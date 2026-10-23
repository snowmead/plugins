//! The run step: runs the review engine (`engine/main.ts`, by Bun) on the
//! args and waits for it.
//!
//! The engine starts one Claude Code process per agent through the Agent SDK.
//! The agents can read the checkout and the review directory, run git's read
//! commands through the engine's git tool, and call the knowledge base's read
//! tools; they have no shell and no tool that writes. They get no GitHub token
//! and no Greptile key, which the engine puts in their MCP config instead.
//! Every git the engine and Claude Code run is this program as [`guard`],
//! first on their `PATH`.
//!
//! Bun reads a `bunfig.toml`, which can preload a script, and `.env` files from
//! the directory it starts in, so the engine starts in the action's own copy,
//! never in the checkout, with `--no-env-file`, and is told where the checkout
//! is.
//!
//! The engine writes its events and its record to the trusted directory, and
//! its output to a log there, which the report step prints with workflow
//! commands stopped. The step never fails on the engine's account: the record
//! decides whether there is a review to post (the result step).
//!
//! [`guard`]: crate::guard

use crate::{
    actions::{
        Annotation,
        Runner, //
    },
    error::Error,
    prepare,
    result,
    stream::{
        self,
        Events, //
    }, //
};
use serde_json::Value;
use std::{
    env,
    ffi::OsString,
    fs::{
        self,
        File, //
    },
    os::unix::{
        fs::symlink,
        process::{
            CommandExt,
            ExitStatusExt, //
        }, //
    },
    path::{
        Path,
        PathBuf, //
    },
    process::{
        Child,
        Command,
        ExitStatus,
        Stdio, //
    },
    thread,
    time::{
        Duration,
        Instant, //
    }, //
};

/// The engine, from its directory.
const ENGINE: &str = "engine/main.ts";

/// How long the engine may run.
const LIMIT: Duration = Duration::from_secs(60 * 60);

/// How long an engine asked to stop gets before it is killed.
const GRACE: Duration = Duration::from_secs(10);

/// The status of an engine stopped at [`LIMIT`], as `timeout` reports one.
///
/// [`LIMIT`]: crate::session::LIMIT
const TIMED_OUT: i32 = 124;

/// How many times [`retry_busy`] tries a busy program.
///
/// [`retry_busy`]: crate::session::retry_busy
const BUSY_TRIES: u32 = 50;

/// The largest usage limit reset time read as seconds since 1970: a larger
/// one is in milliseconds, as that many seconds is past the year 5000.
const LARGEST_SECONDS: i64 = 100_000_000_000;

/// What the run step reads.
pub(crate) struct Session<'a> {
    /// The runner.
    runner: &'a Runner,
    /// The checkout, which the agents read.
    checkout: &'a Path,
    /// Bun.
    bun: &'a str,
    /// The engine's directory: the action's copy, where the engine starts.
    engine: &'a Path,
    /// Greptile's API key; `None` when the job has none.
    greptile: Option<&'a str>,
    /// The real git, which the guard runs.
    git: &'a Path,
    /// The program installed as the guard: this one.
    guard: PathBuf,
    /// How long the engine may run.
    limit: Duration,
}

impl<'a> Session<'a> {
    /// The run step's session, with the job's settings.
    pub(crate) fn new(
        runner: &'a Runner,
        checkout: &'a Path,
        bun: &'a str,
        engine: &'a Path,
        greptile: Option<&'a str>,
        git: &'a Path,
    ) -> Result<Self, Error> {
        let guard = env::current_exe().map_err(|source| Error::Read {
            path: PathBuf::from("/proc/self/exe"),
            source,
        })?;
        Ok(Self {
            runner,
            checkout,
            bun,
            engine,
            greptile,
            git,
            guard,
            limit: LIMIT,
        })
    }

    /// Installs the guard, runs the engine, and says how a failed run ended.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let bin = self.install_guard()?;
        let log = log_path(self.runner);
        let write = |source| Error::Write {
            path: log.clone(),
            source,
        };
        let output = File::create(&log).map_err(write)?;
        let errors = output.try_clone().map_err(write)?;
        let mut command = self.command(&bin);
        // Its own process group, so a stop at the limit reaches every process
        // the engine started, as `timeout` does.
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(output))
            .stderr(Stdio::from(errors))
            .process_group(0);
        let child = retry_busy(|| command.spawn()).map_err(|source| Error::Spawn {
            program: self.bun.into(),
            source,
        })?;
        let status = wait(child, self.limit, GRACE)?;
        let events = Events::load(self.runner)?;
        if status != 0 {
            self.runner.warning(&format!(
                "The review engine exited with status {status}: {}. The Show how the review ended step has its last lines.",
                ending(events.as_ref())
            ));
        }
        if let Some(message) = usage_limit(events.as_ref()) {
            self.runner
                .annotate(Annotation::Warning, "Claude usage limit", &message);
        }
        Ok(())
    }

    /// The engine in its own directory, on the job's args and files, with the
    /// guard first on `PATH` from `bin`, Greptile's key when there is one,
    /// and no GitHub token.
    fn command(&self, bin: &Path) -> Command {
        let mut command = Command::new(self.bun);
        command
            .args(["--no-env-file", ENGINE, "ci", "--repo"])
            .arg(self.checkout)
            .arg("--args")
            .arg(prepare::args_path(self.runner))
            .arg("--out")
            .arg(result::record_path(self.runner))
            .arg("--events")
            .arg(Events::path(self.runner))
            .arg("--read-dir")
            .arg(self.runner.review_dir())
            .current_dir(self.engine)
            .env("PATH", path_with(bin))
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN");
        match self.greptile {
            Some(key) => command.env("GREPTILE_API_KEY", key),
            None => command.env_remove("GREPTILE_API_KEY"),
        };
        command
    }

    /// Installs the guard as `git` in the trusted directory's `bin`, beside
    /// the link to the real git it runs, and returns that `bin`.
    fn install_guard(&self) -> Result<PathBuf, Error> {
        let trusted = self.runner.trusted_dir();
        let bin = trusted.join("bin");
        let guard = bin.join("git");
        let real = trusted.join("real-git");
        let write = |path: &Path, result: std::io::Result<()>| {
            result.map_err(|source| Error::Write {
                path: path.to_path_buf(),
                source,
            })
        };
        write(&bin, fs::create_dir_all(&bin))?;
        // A copy, not a link: the program runs as the guard when its own file
        // is named git.
        write(&guard, fs::copy(&self.guard, &guard).map(drop))?;
        if fs::symlink_metadata(&real).is_ok() {
            write(&real, fs::remove_file(&real))?;
        }
        write(&real, symlink(self.git, &real))?;
        let version = retry_busy(|| {
            Command::new(&guard)
                .arg("--version")
                .current_dir(self.checkout)
                .output()
        })
        .map_err(|source| Error::Spawn {
            program: guard.display().to_string(),
            source,
        })?;
        if !version.status.success() {
            return Err(Error::review(format!(
                "The review's git does not run: {}",
                String::from_utf8_lossy(&version.stderr).trim()
            )));
        }
        self.runner
            .print(String::from_utf8_lossy(&version.stdout).trim());
        Ok(bin)
    }
}

/// `start`'s result, tried again while the program it runs is busy: a
/// program just written cannot run while a child that another thread forked
/// before the file closed has yet to exec.
fn retry_busy<T>(mut start: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    for _ in 0..BUSY_TRIES {
        match start() {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                thread::sleep(Duration::from_millis(20))
            }
            result => return result,
        }
    }
    start()
}

/// The engine's output, which the report step prints.
pub(crate) fn log_path(runner: &Runner) -> PathBuf {
    runner.trusted_dir().join("engine.log")
}

/// `PATH` with `bin` first.
fn path_with(bin: &Path) -> OsString {
    let mut paths = vec![bin.to_path_buf()];
    if let Some(path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&path));
    }
    env::join_paths(paths).unwrap_or_else(|_| bin.as_os_str().to_owned())
}

/// Waits for `child`, the leader of its own process group, up to `limit`,
/// then asks the group to stop, kills it once the leader has exited or
/// `grace` has passed, and returns its exit status: [`TIMED_OUT`] when it
/// was stopped, and 128 plus the signal when a signal ended it.
///
/// [`TIMED_OUT`]: crate::session::TIMED_OUT
fn wait(mut child: Child, limit: Duration, grace: Duration) -> Result<i32, Error> {
    let deadline = Instant::now() + limit;
    let spawn = |source| Error::Spawn {
        program: "the review engine".into(),
        source,
    };
    loop {
        if let Some(status) = child.try_wait().map_err(spawn)? {
            return Ok(code(status));
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    // Ask first, as `timeout` does, so the engine can stop its agents.
    let group = format!("-{}", child.id());
    let signal = |name: &str| {
        let _ = Command::new("kill").args([name, "--", &group]).status();
    };
    signal("-TERM");
    let asked = Instant::now();
    while asked.elapsed() < grace {
        if child.try_wait().map_err(spawn)?.is_some() {
            signal("-KILL");
            return Ok(TIMED_OUT);
        }
        thread::sleep(Duration::from_millis(200));
    }
    signal("-KILL");
    let _ = child.wait();
    Ok(TIMED_OUT)
}

/// The shell's exit status for `status`.
fn code(status: ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or_default())
}

/// How the engine ended, from its own values and Claude Code's, not a
/// model's: each value keeps only letters, digits, `_`, `.`, and `-`, so none
/// can start a workflow command.
fn ending(events: Option<&Events>) -> String {
    let null = Value::Null;
    let result = events.and_then(Events::last_result).unwrap_or(&null);
    let limit = events
        .and_then(|events| events.of("rate_limit_event", None).last())
        .map_or(&null, |event| &event["rate_limit_info"]);
    let value = |value: &Value, fallback: &str| match value {
        Value::Null | Value::Bool(false) => fallback.to_owned(),
        value => clean(&stream::text(value)),
    };
    format!(
        "{}, {}, API status {}; rate limit {} ({})",
        value(&result["subtype"], "no result"),
        value(&result["terminal_reason"], "unknown"),
        value(&result["api_error_status"], "none"),
        value(&limit["status"], "unknown"),
        value(&limit["rateLimitType"], "unknown"),
    )
}

/// What to tell the author when the Claude account the review runs on hit a
/// usage limit, which stops the review's agents until it resets: `None` when
/// it did not.
fn usage_limit(events: Option<&Events>) -> Option<String> {
    let events = events?;
    let info = events
        .of("rate_limit_event", None)
        .last()
        .map(|event| &event["rate_limit_info"]);
    let rejected = info.is_some_and(|info| info["status"] == "rejected");
    let refused = events
        .last_result()
        .is_some_and(|result| result["api_error_status"] == 429);
    if !rejected && !refused {
        return None;
    }
    let null = Value::Null;
    let info = info.unwrap_or(&null);
    let kind = match info["rateLimitType"].as_str() {
        Some("five_hour") => "5-hour ".to_owned(),
        Some("seven_day") => "weekly ".to_owned(),
        Some("seven_day_opus") => "weekly Opus ".to_owned(),
        Some("seven_day_sonnet") => "weekly Sonnet ".to_owned(),
        Some(other) => format!("{} ", clean(other)),
        None => String::new(),
    };
    let reset = info["resetsAt"]
        .as_i64()
        .map(|at| format!(", which resets at {}", utc(at)))
        .unwrap_or_default();
    Some(format!(
        "The Claude account the review runs on hit its {kind}usage limit{reset}, so the review stopped early. \
         Run the job again once the limit resets."
    ))
}

/// The time `at` (seconds since 1970, or milliseconds above
/// [`LARGEST_SECONDS`]) as `YYYY-MM-DD HH:MM UTC`.
///
/// [`LARGEST_SECONDS`]: crate::session::LARGEST_SECONDS
fn utc(at: i64) -> String {
    let seconds = if at > LARGEST_SECONDS { at / 1000 } else { at };
    let time = seconds.rem_euclid(86_400);
    // The civil date of a day count, as in Howard Hinnant's `civil_from_days`.
    let days = seconds.div_euclid(86_400) + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 {
        shifted + 3
    } else {
        shifted - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year}-{month:02}-{day:02} {:02}:{:02} UTC",
        time / 3600,
        time % 3600 / 60
    )
}

/// `text` with only letters, digits, `_`, `.`, and `-`.
fn clean(text: &str) -> String {
    text.chars()
        .filter(|char| char.is_ascii_alphanumeric() || matches!(char, '_' | '.' | '-'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        ENGINE,
        Session,
        TIMED_OUT,
        log_path,
        wait, //
    };
    use crate::{
        actions::TestRunner,
        prepare,
        result,
        stream::Events, //
    };
    use serde_json::json;
    use std::{
        fs,
        os::unix::{
            fs::PermissionsExt,
            process::CommandExt, //
        },
        path::{
            Path,
            PathBuf, //
        },
        process::Command,
        thread,
        time::{
            Duration,
            Instant, //
        },
    };

    /// The checkout and the engine's directory of a test.
    fn dirs(test: &TestRunner) -> (PathBuf, PathBuf) {
        let checkout = test.temp.path().join("checkout");
        let engine = test.temp.path().join("engine");
        for dir in [&checkout, &engine] {
            fs::create_dir_all(dir).expect("the directory");
        }
        (checkout, engine)
    }

    /// A Bun that writes `events` to its events file and exits with `status`;
    /// then the step run over it.
    fn session(test: &TestRunner, events: &str, status: i32) -> Vec<String> {
        let temp = test.temp.path();
        fs::write(temp.join("events"), format!("{events}\n")).expect("the events");
        let rest = format!(
            "while [ $# -gt 0 ]; do [ \"$1\" = --events ] && to=\"$2\"; shift; done\n\
             cat '{}/events' > \"$to\"\necho 'engine output'\nexit {status}\n",
            temp.display()
        );
        run(test, &rest, Duration::from_secs(30))
    }

    /// A Bun that saves its arguments, directory, `PATH`, and process id,
    /// then runs the shell commands `rest`; then the step run over it with
    /// `limit`. Returns the arguments.
    fn run(test: &TestRunner, rest: &str, limit: Duration) -> Vec<String> {
        let temp = test.temp.path();
        let bun = temp.join("bun");
        fs::write(
            &bun,
            format!(
                "#!/bin/bash\necho $$ > '{dir}/pid'\nprintf '%s\\0' \"$@\" > '{dir}/argv'\npwd > '{dir}/cwd'\n\
                 printf '%s\\n' \"$PATH\" > '{dir}/path'\n{rest}",
                dir = temp.display()
            ),
        )
        .expect("bun");
        fs::set_permissions(&bun, fs::Permissions::from_mode(0o755)).expect("bun runs");
        // A stand-in for this program, which the step installs as the guard.
        let guard = temp.join("guard");
        fs::write(&guard, "#!/bin/bash\necho 'git version 2.0'\n").expect("the guard");
        fs::set_permissions(&guard, fs::Permissions::from_mode(0o755)).expect("the guard runs");
        let (checkout, engine) = dirs(test);
        let bun = bun.display().to_string();
        let mut step = Session::new(
            &test.runner,
            &checkout,
            &bun,
            &engine,
            None,
            Path::new("/usr/bin/git"),
        )
        .expect("the step");
        step.guard = guard;
        step.limit = limit;
        step.run().expect("the step");
        let argv = fs::read(temp.join("argv")).expect("the arguments");
        String::from_utf8(argv)
            .expect("UTF-8")
            .split('\0')
            .filter(|arg| !arg.is_empty())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn an_engine_that_fails_leaves_the_result_to_the_next_step_and_says_how_it_ended() {
        let test = TestRunner::new();
        // An engine that errs once the review has finished.
        let events = [
            "not JSON".to_owned(),
            json!({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "rateLimitType": "five_hour"}}).to_string(),
            json!({"type": "result", "subtype": "error_during_execution", "terminal_reason": "aborted::error::x", "api_error_status": 529})
                .to_string(),
        ]
        .join("\n");
        let argv = session(&test, &events, 1);
        // The values are cleaned, so none can start a workflow command.
        let log = test.log();
        assert!(
            log.ends_with(
                "::warning title=Claude review::The review engine exited with status 1: error_during_execution, abortederrorx, \
                 API status 529; rate limit allowed (five_hour). The Show how the review ended step has its last lines.\n"
            ),
            "{log}"
        );
        // The engine reads the job's args and writes its record and events
        // to the trusted directory; its agents read the checkout and the
        // review directory.
        let (checkout, engine) = dirs(&test);
        let path = |path: &Path| path.display().to_string();
        assert_eq!(
            argv,
            [
                "--no-env-file".to_owned(),
                ENGINE.into(),
                "ci".into(),
                "--repo".into(),
                path(&checkout),
                "--args".into(),
                path(&prepare::args_path(&test.runner)),
                "--out".into(),
                path(&result::record_path(&test.runner)),
                "--events".into(),
                path(&Events::path(&test.runner)),
                "--read-dir".into(),
                path(test.runner.review_dir()),
            ]
        );
        // It starts in its own directory, never the checkout, with the guard
        // first on its PATH, and its output goes to the log the report prints.
        let read = |name: &str| fs::read_to_string(test.temp.path().join(name)).expect(name);
        assert_eq!(read("cwd").trim(), path(&engine));
        assert!(
            read("path").starts_with(&format!(
                "{}:",
                test.runner.trusted_dir().join("bin").display()
            )),
            "{}",
            read("path")
        );
        assert_eq!(
            fs::read_to_string(log_path(&test.runner)).expect("the log"),
            "engine output\n"
        );
        assert!(!log.contains("usage limit"), "{log}");
        // Without any event at all, it still says so.
        let test = TestRunner::new();
        session(&test, "", 124);
        assert!(
            test.log().contains(
                "status 124: no result, unknown, API status none; rate limit unknown (unknown)."
            ),
            "{}",
            test.log()
        );
    }

    #[test]
    fn an_engine_stopped_by_a_usage_limit_says_when_to_run_it_again() {
        let limited = |info: serde_json::Value, status: serde_json::Value| {
            [
                json!({"type": "rate_limit_event", "rate_limit_info": info}).to_string(),
                json!({"type": "result", "subtype": "success", "is_error": true, "terminal_reason": "api_error", "api_error_status": status})
                    .to_string(),
            ]
            .join("\n")
        };
        for (name, events, said) in [
            (
                "the 5-hour limit",
                limited(
                    json!({"status": "rejected", "rateLimitType": "five_hour", "resetsAt": 1_791_482_400}),
                    json!(429),
                ),
                "hit its 5-hour usage limit, which resets at 2026-10-08 18:00 UTC, so the review stopped early.",
            ),
            (
                "a weekly limit in milliseconds",
                limited(
                    json!({"status": "rejected", "rateLimitType": "seven_day", "resetsAt": 1_791_655_200_000_i64}),
                    json!(null),
                ),
                "hit its weekly usage limit, which resets at 2026-10-10 18:00 UTC,",
            ),
            (
                "a refusal without a limit event",
                json!({"type": "result", "api_error_status": 429}).to_string(),
                "hit its usage limit, so",
            ),
        ] {
            let test = TestRunner::new();
            session(&test, &events, 1);
            let log = test.log();
            assert!(
                log.contains(
                    "::warning title=Claude usage limit::The Claude account the review runs on "
                ),
                "{name}: {log}"
            );
            assert!(log.contains(said), "{name}: {log}");
        }
    }

    #[test]
    fn the_engine_gets_greptiles_key_and_no_github_token() {
        let test = TestRunner::new();
        let (checkout, engine) = dirs(&test);
        let envs = |greptile: Option<&str>| -> Vec<(String, Option<String>)> {
            let step = Session::new(
                &test.runner,
                &checkout,
                "bun",
                &engine,
                greptile,
                Path::new("/usr/bin/git"),
            )
            .expect("the step");
            let command = step.command(Path::new("/bin"));
            assert_eq!(command.get_current_dir(), Some(engine.as_path()));
            command
                .get_envs()
                .map(|(name, value)| {
                    (
                        name.to_string_lossy().into_owned(),
                        value.map(|value| value.to_string_lossy().into_owned()),
                    )
                })
                .collect()
        };
        let with = envs(Some("gk-0123"));
        for (name, value) in [
            ("GH_TOKEN", None),
            ("GITHUB_TOKEN", None),
            ("GREPTILE_API_KEY", Some("gk-0123".to_owned())),
        ] {
            assert!(with.contains(&(name.to_owned(), value)), "{name}: {with:?}");
        }
        // Without a key, none, even one the job's environment has.
        let without = envs(None);
        assert!(
            without.contains(&("GREPTILE_API_KEY".to_owned(), None)),
            "{without:?}"
        );
    }

    /// Whether process `pid` still runs, as `ps` reports it on Linux and
    /// macOS alike: a zombie has stopped.
    fn running(pid: &str) -> bool {
        let output = Command::new("ps")
            .args(["-o", "stat=", "-p", pid.trim()])
            .output()
            .expect("ps runs");
        let stat = String::from_utf8_lossy(&output.stdout);
        let stat = stat.trim();
        !stat.is_empty() && !stat.starts_with('Z')
    }

    #[test]
    fn a_session_past_its_limit_is_asked_to_stop_with_what_it_started() {
        let test = TestRunner::new();
        let dir = test.temp.path().display().to_string();
        // An engine that notes being asked to stop, waiting on a command it
        // started that does not stop when asked, as an agent's might not.
        let rest = format!(
            "trap 'echo asked > \"{dir}/asked\"; exit 143' TERM\n(trap '' TERM; exec sleep 60) &\n\
             echo $! > '{dir}/agent'\nwait\n"
        );
        let started = Instant::now();
        run(&test, &rest, Duration::from_secs(1));
        // Stopped at the limit, not when its own work ended.
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
        let log = test.log();
        assert!(
            log.contains("The review engine exited with status 124: no result"),
            "{log}"
        );
        // Asked first, so it could stop its agents, not only killed.
        assert!(
            test.temp.path().join("asked").exists(),
            "the engine was not asked to stop"
        );
        for name in ["pid", "agent"] {
            let pid = fs::read_to_string(test.temp.path().join(name)).expect("the process id");
            let asked = Instant::now();
            while running(&pid) && asked.elapsed() < Duration::from_secs(5) {
                thread::sleep(Duration::from_millis(50));
            }
            assert!(!running(&pid), "{name} still runs");
        }
    }

    #[test]
    fn a_session_that_does_not_stop_when_asked_is_killed_with_what_it_started() {
        let temp = tempfile::tempdir().expect("a directory");
        let agent = temp.path().join("agent");
        let child = Command::new("bash")
            .arg("-c")
            .arg(format!(
                "trap '' TERM\nsleep 60 &\necho $! > '{}'\nwait\n",
                agent.display()
            ))
            .process_group(0)
            .spawn()
            .expect("the engine");
        let started = Instant::now();
        let status = wait(child, Duration::from_millis(500), Duration::from_secs(1));
        assert_eq!(status.expect("the status"), TIMED_OUT);
        // Killed after the grace, with the command it started.
        assert!(started.elapsed() >= Duration::from_millis(1500));
        let pid = fs::read_to_string(&agent).expect("the process id");
        let killed = Instant::now();
        while running(&pid) && killed.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!running(&pid), "the agent still runs");
    }
}
