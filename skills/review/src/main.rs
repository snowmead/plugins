//! The Claude review's job steps, as one program the action builds.
//!
//! `action.yml` runs one subcommand per step, in this order: `start`,
//! `protect`, `prepare`, `run`, `result`, `post`, then `unfinished` when the
//! review was not posted and `report` always. Each step reads the runner's
//! environment, the action's inputs as `REVIEW_*` variables, and what the
//! steps before it saved in the trusted directory. A copy of this program
//! named `git` is the guard the review's agents run as git ([`guard`]).
//!
//! A step that fails prints one error annotation and exits with status 1.
//!
//! [`guard`]: crate::guard

mod actions;
mod error;
mod git;
mod github;
mod guard;
mod id;
mod marker;
mod post;
mod prepare;
mod protect;
mod report;
mod result;
mod section;
mod session;
mod settings;
mod start;
mod state;
mod stream;
#[cfg(test)]
mod testing;
mod unfinished;

use crate::{
    actions::{
        Annotation,
        Runner,
        TITLE,
        var,
        var_or_empty, //
    },
    error::Error,
    git::Git,
    github::{
        Http,
        without_bot, //
    },
    id::Repository,
    state::{
        Pull,
        read_json, //
    }, //
};
use std::{
    env,
    path::{
        Path,
        PathBuf, //
    },
    process::ExitCode,
    str::FromStr, //
};

/// The steps, by their subcommands.
#[derive(Clone, Copy)]
enum Step {
    /// Finds the pull request and its last review.
    Start,
    /// Takes the review's configuration from a trusted branch.
    Protect,
    /// Writes what the agents read and the engine's args.
    Prepare,
    /// Runs the review engine.
    Run,
    /// Reads the engine's result.
    Result,
    /// Posts the review.
    Post,
    /// Says the review did not finish.
    Unfinished,
    /// Lists refused tool calls, how each agent ended, and the engine's log.
    Report,
}

/// A subcommand that names no step.
struct UnknownStep;

impl FromStr for Step {
    type Err = UnknownStep;

    /// The step the subcommand `name` names.
    fn from_str(name: &str) -> Result<Self, Self::Err> {
        Ok(match name {
            "start" => Self::Start,
            "protect" => Self::Protect,
            "prepare" => Self::Prepare,
            "run" => Self::Run,
            "result" => Self::Result,
            "post" => Self::Post,
            "unfinished" => Self::Unfinished,
            "report" => Self::Report,
            _ => return Err(UnknownStep),
        })
    }
}

/// Runs the guard when this program is installed as `git`, and otherwise the
/// step its first argument names.
fn main() -> ExitCode {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    if guard::installed() {
        return guard::run(arguments.collect());
    }
    let name = arguments
        .next()
        .and_then(|name| name.into_string().ok())
        .unwrap_or_default();
    let Ok(step) = name.parse::<Step>() else {
        eprintln!("usage: claude-review start|protect|prepare|run|result|post|unfinished|report");
        return ExitCode::from(2);
    };
    let runner = match Runner::from_env() {
        Ok(runner) => runner,
        Err(error) => {
            println!(
                "::error title={TITLE}::{}",
                actions::one_line(&error.to_string())
            );
            return ExitCode::FAILURE;
        }
    };
    match run(step, &runner) {
        Ok(()) => ExitCode::SUCCESS,
        Err(Error::Reported) => ExitCode::FAILURE,
        Err(error) => {
            runner.annotate(Annotation::Error, TITLE, &error.to_string());
            ExitCode::FAILURE
        }
    }
}

/// Runs `step` on `runner`, in the checkout: the working directory.
fn run(step: Step, runner: &Runner) -> Result<(), Error> {
    let dir = env::current_dir().map_err(|source| Error::Read {
        path: PathBuf::from("."),
        source,
    })?;
    let checkout = Git::new(&dir);
    let repo: Repository = var("GITHUB_REPOSITORY")?.parse()?;
    let reviewer = reviewer();
    let server = or_default("GITHUB_SERVER_URL", "https://github.com");
    let run_url = || -> Result<String, Error> {
        Ok(format!(
            "{server}/{repo}/actions/runs/{}",
            var("GITHUB_RUN_ID")?
        ))
    };
    match step {
        Step::Start => {
            let event_path = PathBuf::from(var("GITHUB_EVENT_PATH")?);
            start::Start {
                runner,
                github: &Http::from_env()?,
                repo: &repo,
                reviewer: &reviewer,
                event: &var("GITHUB_EVENT_NAME")?,
                payload: &read_json(&event_path)?,
                input: &var_or_empty("REVIEW_PR"),
                checkout: &checkout,
            }
            .run()
        }
        Step::Protect => protect::Protect {
            runner,
            checkout: &checkout,
            dir: &dir,
            pull: &Pull::load(runner)?,
            rules: &or_default("REVIEW_RULES", "REVIEW.md"),
            config: &or_default("REVIEW_CONFIG", ".claude/review.json"),
            action: Path::new(&var("REVIEW_ACTION_DIR")?),
        }
        .run(),
        Step::Prepare => prepare::Prepare {
            runner,
            github: &Http::from_env()?,
            repo: &repo,
            reviewer: &reviewer,
            checkout: &checkout,
            agents: &var_or_empty("REVIEW_AGENTS"),
            config: &or_default("REVIEW_CONFIG", ".claude/review.json"),
        }
        .run(),
        Step::Run => {
            let git = which("git").ok_or_else(|| Error::review("git is not on the PATH."))?;
            let bun = or_default("REVIEW_BUN", "bun");
            let engine = PathBuf::from(var("REVIEW_ACTION_DIR")?);
            let greptile = non_empty_var("GREPTILE_API_KEY");
            session::Session::new(runner, &dir, &bun, &engine, greptile.as_deref(), &git)?.run()
        }
        Step::Result => result::ReadResult {
            runner,
            billing: result::Billing::named(&var_or_empty("REVIEW_BILLING")),
        }
        .run(),
        Step::Post => {
            let secrets: Vec<String> = [
                "ANTHROPIC_API_KEY",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "GREPTILE_API_KEY",
                "GH_TOKEN",
            ]
            .into_iter()
            .map(var_or_empty)
            .collect();
            post::Post {
                runner,
                github: &Http::from_env()?,
                repo: &repo,
                secrets: &secrets,
                greptile: non_empty_var("GREPTILE_API_KEY").is_some(),
                server: &server,
                run_url: &run_url()?,
            }
            .run()
        }
        Step::Unfinished => unfinished::Unfinished {
            github: &Http::from_env()?,
            repo: &repo,
            pull: &Pull::load(runner)?,
            run_url: &run_url()?,
        }
        .run(),
        Step::Report => report::Report { runner }.run(),
    }
}

/// The login the review posts as, without the `[bot]` an app's login ends
/// with (`REVIEW_REVIEWER`, `github-actions` by default).
fn reviewer() -> String {
    let login = or_default("REVIEW_REVIEWER", "github-actions");
    without_bot(&login).to_owned()
}

/// The environment variable `name`, or `default` when it is unset or empty.
fn or_default(name: &str, default: &str) -> String {
    non_empty_var(name).unwrap_or_else(|| default.into())
}

/// The environment variable `name`; `None` when it is unset or empty, as the
/// action leaves an input it was not given.
fn non_empty_var(name: &str) -> Option<String> {
    Some(var_or_empty(name)).filter(|value| !value.is_empty())
}

/// The first `program` on the `PATH`.
fn which(program: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|path| path.is_file())
}
