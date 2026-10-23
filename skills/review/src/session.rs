//! The run step: starts Claude Code, which starts the review workflow with
//! the args and waits for it.
//!
//! The agents can read the checkout and the review directory, run git's read
//! commands, load skills, and call the knowledge base's read tools. They get
//! no GitHub token. The git they run is this program as [`guard`], first on
//! their `PATH`. Shell commands run without the job's secrets
//! (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) and cannot read other processes'
//! environments, so an agent cannot print a key in any form.
//!
//! The session's events go to the trusted directory. The step never fails on
//! the session's account: the workflow's own record decides whether there is a
//! review to post (the result step), so a session that errs after the workflow
//! finished still posts.
//!
//! [`guard`]: crate::guard

use crate::{
    actions::{
        Annotation,
        Runner, //
    },
    error::Error,
    prepare,
    settings::{
        self,
        Stage, //
    },
    stream::{
        self,
        Events, //
    }, //
};
use serde_json::{
    Value,
    json, //
};
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

/// The tools the session and its agents may use without asking; the rest are
/// refused, as nobody answers a prompt in the job.
const ALLOWED_TOOLS: &str = "Workflow,Skill,Bash(git log *),Bash(git show *),Bash(git diff *),Bash(git blame *),\
Bash(git ls-files *),Bash(git ls-tree *),mcp__greptile__list_knowledge_bases,\
mcp__greptile__list_knowledge_base_documents,mcp__greptile__get_knowledge_base_document,\
mcp__greptile__search_knowledge_base";

/// Greptile's MCP server, which holds the knowledge base.
const GREPTILE: &str = "https://api.greptile.com/mcp";

/// How long the session may run: the workflow waits up to 55 minutes.
const LIMIT: Duration = Duration::from_secs(60 * 60);

/// How long a session asked to stop gets before it is killed.
const GRACE: Duration = Duration::from_secs(10);

/// The status of a session stopped at [`LIMIT`], as `timeout` reports one.
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
    /// The checkout, where the session starts.
    checkout: &'a Path,
    /// The Claude Code program.
    claude: &'a str,
    /// Greptile's API key; `None` when the job has none.
    greptile: Option<&'a str>,
    /// The real git, which the guard runs.
    git: &'a Path,
    /// The program installed as the guard: this one.
    guard: PathBuf,
    /// How long the session may run.
    limit: Duration,
}

impl<'a> Session<'a> {
    /// The run step's session, with the job's settings.
    pub(crate) fn new(
        runner: &'a Runner,
        checkout: &'a Path,
        claude: &'a str,
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
            claude,
            greptile,
            git,
            guard,
            limit: LIMIT,
        })
    }

    /// Installs the guard, runs the session, and says how a failed session
    /// ended.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let bin = self.install_guard()?;
        let args = prepare::load_args(self.runner)?;
        let stage = settings::session(&args["config"]);
        // The prompt goes in on stdin: the args of a pull request with many
        // files are too long for one command-line argument.
        let prompt = self.runner.trusted_dir().join("prompt.txt");
        let workflow = self.runner.review_dir().join("pr-review.js");
        crate::state::write_text(
            &prompt,
            &format!(
                "Call the Workflow tool exactly once, with scriptPath \"{}\" and with args set to this JSON object, \
                 unchanged: {args}. Do nothing else. When the workflow finishes, reply with one word: done.",
                workflow.display()
            ),
        )?;
        let events = Events::path(self.runner);
        let output = File::create(&events).map_err(|source| Error::Write {
            path: events,
            source,
        })?;
        let input = File::open(&prompt).map_err(|source| Error::Read {
            path: prompt,
            source,
        })?;
        let mut command = self.command(&stage, &bin);
        // Its own process group, so a stop at the limit reaches every process
        // the session started, as `timeout` does.
        command
            .stdin(Stdio::from(input))
            .stdout(Stdio::from(output))
            .process_group(0);
        let child = retry_busy(|| command.spawn()).map_err(|source| Error::Spawn {
            program: self.claude.into(),
            source,
        })?;
        let status = wait(child, self.limit, GRACE)?;
        let events = Events::load(self.runner)?;
        if status != 0 {
            self.runner.warning(&format!(
                "Claude Code exited with status {status}: {}. The Show how the review ended step has its last replies.",
                ending(events.as_ref())
            ));
        }
        if let Some(message) = usage_limit(events.as_ref()) {
            self.runner
                .annotate(Annotation::Warning, "Claude usage limit", &message);
        }
        Ok(())
    }

    /// Claude Code in the checkout, with the stage's model and effort, the
    /// allowed tools, the guard first on `PATH` from `bin`, and no GitHub
    /// token.
    fn command(&self, stage: &Stage, bin: &Path) -> Command {
        let mut command = Command::new(self.claude);
        command
            .args([
                "-p",
                "--model",
                &stage.model,
                "--effort",
                stage.effort.name(),
                "--add-dir",
            ])
            .arg(self.runner.review_dir())
            .args(["--allowedTools", ALLOWED_TOOLS, "--strict-mcp-config"]);
        if let Some(key) = self.greptile {
            // The scrub blanks ${GREPTILE_API_KEY} in an MCP header too, so the
            // key goes in the config itself. An agent cannot read it back from
            // /proc: Claude Code refuses a path argument outside the checkout
            // and the review directory, and the guard refuses the options and
            // paths that reach a file outside the checkout.
            command.arg("--mcp-config").arg(mcp_config(key).to_string());
        }
        command
            .args(["--output-format", "stream-json", "--verbose"])
            .current_dir(self.checkout)
            .env("PATH", path_with(bin))
            .env("CLAUDE_CODE_WORKFLOWS", "1")
            .env("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1")
            // The default follows the CPU count; review agents mostly wait on the API.
            .env("CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS", "8")
            // Wait for the workflow up to 55 minutes instead of the default 10.
            .env("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS", "3300000")
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN");
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

/// The MCP config that reaches Greptile with `key`.
fn mcp_config(key: &str) -> Value {
    json!({"mcpServers": {"greptile": {"type": "http", "url": GREPTILE, "headers": {"Authorization": format!("Bearer {key}")}}}})
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
        program: "claude".into(),
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
    // Ask first, as `timeout` does, so the session can stop its agents.
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

/// How the session ended, from Claude Code's own values, not the model's:
/// each value keeps only letters, digits, `_`, `.`, and `-`, so none can
/// start a workflow command.
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
        Session,
        TIMED_OUT,
        wait, //
    };
    use crate::{
        actions::TestRunner,
        prepare,
        settings::{
            Effort,
            Stage, //
        },
        state::write_json, //
    };
    use serde_json::{
        Value,
        json, //
    };
    use std::{
        ffi::OsStr,
        fs,
        os::unix::{
            fs::PermissionsExt,
            process::CommandExt, //
        },
        path::Path,
        process::Command,
        thread,
        time::{
            Duration,
            Instant, //
        },
    };

    /// A claude that saves its arguments and prompt, prints `events`, and
    /// exits with `status`; then the step run over it with `args`.
    fn session(
        test: &TestRunner,
        args: &Value,
        events: &str,
        status: i32,
        greptile: &str,
    ) -> Vec<String> {
        let temp = test.temp.path();
        fs::write(temp.join("events"), format!("{events}\n")).expect("the events");
        let rest = format!("cat '{}/events'\nexit {status}\n", temp.display());
        run(test, args, &rest, greptile, Duration::from_secs(30))
    }

    /// A claude that saves its arguments, prompt, `PATH`, and process id,
    /// then runs the shell commands `rest`; then the step run over it with
    /// `args` and `limit`. Returns the arguments.
    fn run(
        test: &TestRunner,
        args: &Value,
        rest: &str,
        greptile: &str,
        limit: Duration,
    ) -> Vec<String> {
        let temp = test.temp.path();
        let claude = temp.join("claude");
        fs::write(
            &claude,
            format!(
                "#!/bin/bash\necho $$ > '{dir}/pid'\nprintf '%s\\0' \"$@\" > '{dir}/argv'\ncat > '{dir}/prompt'\n\
                 printf '%s\\n' \"$PATH\" > '{dir}/path'\n{rest}",
                dir = temp.display()
            ),
        )
        .expect("claude");
        fs::set_permissions(&claude, fs::Permissions::from_mode(0o755)).expect("claude runs");
        write_json(&prepare::args_path(&test.runner), args).expect("the args");
        // A stand-in for this program, which the step installs as the guard.
        let guard = temp.join("guard");
        fs::write(&guard, "#!/bin/bash\necho 'git version 2.0'\n").expect("the guard");
        fs::set_permissions(&guard, fs::Permissions::from_mode(0o755)).expect("the guard runs");
        let checkout = tempfile::tempdir().expect("a checkout");
        let claude = claude.display().to_string();
        let mut step = Session::new(
            &test.runner,
            checkout.path(),
            &claude,
            Some(greptile).filter(|key| !key.is_empty()),
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
    fn a_session_that_fails_leaves_the_result_to_the_next_step_and_says_how_it_ended() {
        let test = TestRunner::new();
        // A session that errs once the workflow has finished.
        let args = json!({"pr": 5, "head": "e".repeat(40), "changed": ["src/a b.rs"], "config": {"agents": {}}});
        let events = [
            "not JSON from a hook".to_owned(),
            json!({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "rateLimitType": "five_hour"}}).to_string(),
            json!({"type": "result", "subtype": "error_during_execution", "terminal_reason": "aborted::error::x", "api_error_status": 529})
                .to_string(),
        ]
        .join("\n");
        let argv = session(&test, &args, &events, 1, "");
        // The values are cleaned, so none can start a workflow command.
        let log = test.log();
        assert!(
            log.ends_with(
                "::warning title=Claude review::Claude Code exited with status 1: error_during_execution, abortederrorx, \
                 API status 529; rate limit allowed (five_hour). The Show how the review ended step has its last replies.\n"
            ),
            "{log}"
        );
        // The args go in on stdin, whole, and the session runs on the default stage.
        let prompt = fs::read_to_string(test.temp.path().join("prompt")).expect("the prompt");
        assert!(
            prompt.contains(&format!(
                "with args set to this JSON object, unchanged: {args}."
            )),
            "{prompt}"
        );
        let at =
            |flag: &str| argv[argv.iter().position(|arg| arg == flag).expect(flag) + 1].clone();
        assert_eq!(
            (at("--model"), at("--effort")),
            ("claude-sonnet-5-5".into(), "low".into())
        );
        assert_eq!(
            at("--add-dir"),
            test.runner.review_dir().display().to_string()
        );
        // The guard is first on the session's PATH.
        let path = fs::read_to_string(test.temp.path().join("path")).expect("the PATH");
        assert!(
            path.starts_with(&format!(
                "{}:",
                test.runner.trusted_dir().join("bin").display()
            )),
            "{path}"
        );
        assert!(!log.contains("usage limit"), "{log}");
        // Without any event at all, it still says so.
        let test = TestRunner::new();
        session(&test, &args, "", 124, "");
        assert!(
            test.log().contains(
                "status 124: no result, unknown, API status none; rate limit unknown (unknown)."
            ),
            "{}",
            test.log()
        );
    }

    #[test]
    fn a_session_stopped_by_a_usage_limit_says_when_to_run_it_again() {
        let args = json!({"config": {"agents": {}}});
        let limited = |info: Value, status: Value| {
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
            session(&test, &args, &events, 1, "");
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
    fn the_session_reaches_greptile_with_the_key_in_its_config_and_runs_the_settings_model() {
        let test = TestRunner::new();
        let args = json!({"config": {"agents": {"session": {"model": "claude-opus-5-5"}}}});
        // The env scrub blanks a ${GREPTILE_API_KEY} header, so the key is written into the config itself.
        let argv = session(&test, &args, "", 0, "gk-0123");
        let at =
            |flag: &str| argv[argv.iter().position(|arg| arg == flag).expect(flag) + 1].clone();
        let config: Value = serde_json::from_str(&at("--mcp-config")).expect("JSON");
        assert_eq!(
            config,
            json!({"mcpServers": {"greptile": {"type": "http", "url": "https://api.greptile.com/mcp",
                                                 "headers": {"Authorization": "Bearer gk-0123"}}}})
        );
        // A stage sets either field; the other keeps its default.
        assert_eq!(
            (at("--model"), at("--effort")),
            ("claude-opus-5-5".into(), "low".into())
        );
        assert_eq!(test.log().matches("::warning").count(), 0, "{}", test.log());
        // Without a key, no server.
        let test = TestRunner::new();
        let args = json!({"config": {"agents": {"session": {"effort": "medium"}}}});
        let argv = session(&test, &args, "", 0, "");
        let at =
            |flag: &str| argv[argv.iter().position(|arg| arg == flag).expect(flag) + 1].clone();
        assert!(!argv.iter().any(|arg| arg == "--mcp-config"));
        assert_eq!(
            (at("--model"), at("--effort")),
            ("claude-sonnet-5-5".into(), "medium".into())
        );
    }

    #[test]
    fn the_session_gets_no_github_token_and_only_the_allowed_tools() {
        let test = TestRunner::new();
        let checkout = tempfile::tempdir().expect("a checkout");
        let step = Session::new(
            &test.runner,
            checkout.path(),
            "claude",
            None,
            Path::new("/usr/bin/git"),
        )
        .expect("the step");
        let stage = Stage {
            model: "sonnet".into(),
            effort: Effort::Low,
        };
        let command = step.command(&stage, Path::new("/bin"));
        let envs: Vec<_> = command.get_envs().collect();
        for (name, value) in [
            ("GH_TOKEN", None),
            ("GITHUB_TOKEN", None),
            ("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", Some("1")),
        ] {
            assert!(
                envs.contains(&(OsStr::new(name), value.map(OsStr::new))),
                "{name}: {envs:?}"
            );
        }
        let args: Vec<_> = command.get_args().collect();
        let tools = args
            .iter()
            .position(|arg| *arg == "--allowedTools")
            .and_then(|at| args.get(at + 1))
            .expect("the allowed tools")
            .to_str()
            .expect("UTF-8");
        // The agents' shell is read-only git, which the guard runs.
        let shell: Vec<_> = tools
            .split(',')
            .filter(|tool| tool.starts_with("Bash("))
            .collect();
        assert_eq!(
            shell,
            [
                "Bash(git log *)",
                "Bash(git show *)",
                "Bash(git diff *)",
                "Bash(git blame *)",
                "Bash(git ls-files *)",
                "Bash(git ls-tree *)"
            ]
        );
        assert!(
            !tools
                .split(',')
                .any(|tool| tool == "Bash" || tool == "Write" || tool == "Edit"),
            "{tools}"
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
        let args = json!({"config": {"agents": {}}});
        let dir = test.temp.path().display().to_string();
        // A session that notes being asked to stop, waiting on a command it
        // started that does not stop when asked, as an agent's might not.
        let rest = format!(
            "trap 'echo asked > \"{dir}/asked\"; exit 143' TERM\n(trap '' TERM; exec sleep 60) &\n\
             echo $! > '{dir}/agent'\nwait\n"
        );
        let started = Instant::now();
        run(&test, &args, &rest, "", Duration::from_secs(1));
        // Stopped at the limit, not when its own work ended.
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
        let log = test.log();
        assert!(
            log.contains("Claude Code exited with status 124: no result"),
            "{log}"
        );
        // Asked first, so it could stop its agents, not only killed.
        assert!(
            test.temp.path().join("asked").exists(),
            "the session was not asked to stop"
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
            .expect("the session");
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
