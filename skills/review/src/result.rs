//! The result step: the review engine's return value, from the record the
//! engine writes, never from an agent's answer.
//!
//! An engine that did not start or did not finish, a result that is not a
//! review of the head, and a review that ran on args other than the job's each
//! fail the step, so a review never ends green with nothing posted and never
//! posts a review of files other than the job's. The step also writes how many
//! agents ran, for how long, and each stage's and model's tokens to the job's
//! summary.

use crate::{
    actions::{
        Runner,
        one_line, //
    },
    error::Error,
    prepare,
    state::{
        Pull,
        read_json,
        write_json, //
    },
    stream::{
        Events,
        text, //
    }, //
};
use serde_json::{
    Value,
    json, //
};
use std::path::PathBuf;

/// What the result step reads.
pub(crate) struct ReadResult<'a> {
    /// The runner.
    pub(crate) runner: &'a Runner,
    /// Who pays for the review's tokens.
    pub(crate) billing: Billing,
}

/// Who pays for the review's tokens, by the credential the job gave Claude
/// Code, which takes an API key over a subscription's token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Billing {
    /// A Claude subscription: the tokens count against its usage limits, and
    /// nothing is billed.
    Subscription,
    /// An Anthropic API key, billed per token.
    ApiKey,
    /// The job did not say.
    Unknown,
}

impl Billing {
    /// The billing `name` names: `subscription` or `api-key`.
    pub(crate) fn named(name: &str) -> Self {
        match name {
            "subscription" => Self::Subscription,
            "api-key" => Self::ApiKey,
            _ => Self::Unknown,
        }
    }
}

impl ReadResult<'_> {
    /// Saves the engine's review for the post step, or fails without one.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let pull = Pull::load(self.runner)?;
        if Events::load(self.runner)?.is_none() {
            return Err(Error::review(
                "The review engine did not start, so the review could not run.",
            ));
        }
        let path = record_path(self.runner);
        if !path.is_file() {
            return Err(Error::review(
                "The review engine did not finish, so nothing was posted.",
            ));
        }
        let record: Value = read_json(&path)?;
        let review = &record["result"];
        write_json(&review_path(self.runner), review)?;
        let is_review = review["head"] == json!(pull.head)
            && review["comments"].is_array()
            && review["summary"].is_object()
            && review["marker"].is_object();
        if !is_review {
            let reason = match &review["error"] {
                Value::Null | Value::Bool(false) => "unexpected result".to_owned(),
                error if review.is_object() => text(error),
                _ => "unexpected result".to_owned(),
            };
            return Err(Error::review(format!(
                "The review engine returned no review: {}",
                one_line(&reason)
            )));
        }
        if review["args"] != prepare::load_args(self.runner)? {
            return Err(Error::review(
                "The review engine ran on args other than the job's, so nothing was posted.",
            ));
        }
        self.runner.summarize(&usage(&record, self.billing))
    }
}

/// The record the engine writes: its result, each agent's account, each
/// model's tokens, and how long it ran.
pub(crate) fn record_path(runner: &Runner) -> PathBuf {
    runner.trusted_dir().join("record.json")
}

/// The review the result step took from the record, which the post step posts.
pub(crate) fn review_path(runner: &Runner) -> PathBuf {
    runner.trusted_dir().join("result.json")
}

/// The job summary's account of the review: how many agents ran and for how
/// long, each stage's and each model's tokens, and what they cost. Claude
/// Code prices the tokens at API rates; on a subscription that measures usage,
/// not a bill.
fn usage(record: &Value, billing: Billing) -> String {
    let agents: &[Value] = record["agents"].as_array().map_or(&[], Vec::as_slice);
    let mut markdown = String::from("### Claude review\n");
    match (agents.len(), record["ms"].as_f64()) {
        (0, _) => markdown.push_str("No agents ran\n"),
        (count, Some(ms)) => {
            markdown.push_str(&format!(
                "{count} agents, {} minutes\n",
                (ms / 60_000.0).floor()
            ));
        }
        (count, None) => markdown.push_str(&format!("{count} agents\n")),
    }
    let tokens = |used: &Value, key: &str| {
        used[key]
            .as_u64()
            .map_or_else(|| "?".to_owned(), |count| count.to_string())
    };
    let mut stages: Vec<(&str, Vec<&Value>)> = Vec::new();
    for agent in agents {
        let stage = agent["stage"].as_str().unwrap_or("?");
        match stages.iter_mut().find(|(name, _)| *name == stage) {
            Some((_, of)) => of.push(agent),
            None => stages.push((stage, vec![agent])),
        }
    }
    if !stages.is_empty() {
        markdown.push_str(
            "\n| Stage | Agents | Input | Output | Cache read | Cache write | Cost |\n|---|---:|---:|---:|---:|---:|---:|\n",
        );
        for (stage, of) in &stages {
            let sum = |key: &str| {
                of.iter()
                    .filter_map(|agent| agent[key].as_u64())
                    .sum::<u64>()
            };
            let cost: f64 = of.iter().filter_map(|agent| agent["cost"].as_f64()).sum();
            let failed = of.iter().filter(|agent| agent["status"] != "ok").count();
            let count = match failed {
                0 => of.len().to_string(),
                failed => format!("{} ({failed} failed)", of.len()),
            };
            markdown.push_str(&format!(
                "| {} | {count} | {} | {} | {} | {} | ${cost:.2} |\n",
                stage.replace('|', "/"),
                sum("input"),
                sum("output"),
                sum("cache_read"),
                sum("cache_write"),
            ));
        }
    }
    let models = record["models"].as_object();
    if let Some(models) = models.filter(|models| !models.is_empty()) {
        markdown.push_str(
            "\n| Model | Input | Output | Cache read | Cache write |\n|---|---:|---:|---:|---:|\n",
        );
        for (model, used) in models {
            markdown.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                model.replace('|', "/"),
                tokens(used, "input"),
                tokens(used, "output"),
                tokens(used, "cache_read"),
                tokens(used, "cache_write"),
            ));
        }
    }
    let cost = models.map_or_else(
        || "unknown".to_owned(),
        |models| {
            let total: f64 = models
                .values()
                .filter_map(|used| used["cost"].as_f64())
                .sum();
            format!("${total:.2}")
        },
    );
    markdown.push('\n');
    markdown.push_str(&match billing {
        Billing::Subscription => format!(
            "Usage: {cost} at API prices. The review ran on a Claude subscription, so this is not billed: it counts \
             against the subscription's usage limits.\n"
        ),
        Billing::ApiKey => format!("Cost: {cost}, billed to the Anthropic API key.\n"),
        Billing::Unknown => format!("Usage at API prices: {cost}.\n"),
    });
    markdown
}

#[cfg(test)]
mod tests {
    use super::{
        Billing,
        ReadResult,
        record_path,
        review_path,
        usage, //
    };
    use crate::{
        actions::TestRunner,
        prepare,
        state::{
            Pull,
            read_json,
            write_json, //
        },
        stream::Events, //
    };
    use serde_json::{
        Value,
        json, //
    };
    use std::fs;

    const HEAD: &str = "c311c8a89bf78b17a70120ac9f80ece09081f530";

    fn args() -> Value {
        json!({"pr": 5, "head": HEAD, "changed": ["src/a.rs", "web/x.tsx"]})
    }

    fn review() -> Value {
        json!({"head": HEAD, "comments": [], "summary": {"top": "No blocking issues", "issues": [], "bottom": ""},
               "marker": {"head": HEAD}, "args": args()})
    }

    /// Runs the step over an engine that started and wrote a record with
    /// `result` (`None` for no record).
    fn read(result: Option<Value>) -> (TestRunner, Result<Value, String>) {
        let test = TestRunner::new();
        Pull {
            number: 5.into(),
            head: HEAD.parse().expect("a commit"),
            base: "main".into(),
            default_branch: "main".into(),
            last_review: None,
        }
        .save(&test.runner)
        .expect("the pull request");
        let init = json!({"type": "system", "subtype": "init", "engine": "review"});
        fs::write(Events::path(&test.runner), format!("{init}\n")).expect("the events");
        if let Some(result) = result {
            write_json(
                &record_path(&test.runner),
                &json!({"result": result, "agents": [], "models": {}}),
            )
            .expect("the record");
        }
        write_json(&prepare::args_path(&test.runner), &args()).expect("the args");
        let result = ReadResult {
            runner: &test.runner,
            billing: Billing::Unknown,
        }
        .run()
        .map_err(|error| error.to_string())
        .and_then(|()| read_json(&review_path(&test.runner)).map_err(|error| error.to_string()));
        (test, result)
    }

    #[test]
    fn takes_the_review_of_the_head_from_the_record() {
        let (test, result) = read(Some(review()));
        assert_eq!(result, Ok(review()));
        assert!(
            test.step_summary()
                .starts_with("### Claude review\nNo agents ran\n"),
            "{}",
            test.step_summary()
        );
    }

    #[test]
    fn fails_without_a_review_of_the_head() {
        let mut other_args = review();
        other_args["args"]["changed"] = json!(["src/a.rs"]);
        let mut other = review();
        other["head"] = json!("0".repeat(40));
        for (name, result, message) in [
            ("no record", None, "did not finish"),
            (
                "another commit's review",
                Some(other),
                "returned no review: unexpected result",
            ),
            (
                "an error",
                Some(json!({"error": "the context stage failed\n::warning::x"})),
                "returned no review: the context stage failed ::warning::x",
            ),
            (
                "no result",
                Some(json!("text")),
                "returned no review: unexpected result",
            ),
            (
                "other args",
                Some(other_args),
                "ran on args other than the job's",
            ),
        ] {
            let (_, result) = read(result);
            let error = result.expect_err(name);
            assert!(error.contains(message), "{name}: {error}");
            assert!(!error.contains('\n'), "{name}: {error}");
        }
    }

    #[test]
    fn says_when_the_engine_did_not_start() {
        let (test, _) = read(Some(review()));
        fs::remove_file(Events::path(&test.runner)).expect("no events");
        let error = ReadResult {
            runner: &test.runner,
            billing: Billing::Unknown,
        }
        .run()
        .expect_err("no engine")
        .to_string();
        assert_eq!(
            error,
            "The review engine did not start, so the review could not run."
        );
    }

    #[test]
    fn the_summary_counts_agents_minutes_and_each_stages_and_models_tokens() {
        let agent = |stage: &str, status: &str, cost: f64| json!({"stage": stage, "status": status, "input": 10, "output": 20, "cache_read": 30, "cache_write": 40, "cost": cost});
        let record = json!({
            "ms": 250_000,
            "agents": [agent("context", "ok", 0.5), agent("finder", "ok", 1.0), agent("finder", "error_max_turns", 2.004)],
            "models": {"claude-sonnet-5-5": {"input": 30, "output": 60, "cache_read": 90, "cache_write": 120, "cost": 3.504}},
        });
        let markdown = usage(&record, Billing::Unknown);
        assert!(
            markdown.starts_with("### Claude review\n3 agents, 4 minutes\n"),
            "{markdown}"
        );
        assert!(
            markdown.contains("| context | 1 | 10 | 20 | 30 | 40 | $0.50 |\n"),
            "{markdown}"
        );
        assert!(
            markdown.contains("| finder | 2 (1 failed) | 20 | 40 | 60 | 80 | $3.00 |\n"),
            "{markdown}"
        );
        assert!(
            markdown.contains("| claude-sonnet-5-5 | 30 | 60 | 90 | 120 |\n"),
            "{markdown}"
        );
        assert!(
            markdown.ends_with("\nUsage at API prices: $3.50.\n"),
            "{markdown}"
        );
        assert!(
            usage(&json!({}), Billing::Unknown)
                .contains("No agents ran\n\nUsage at API prices: unknown.")
        );
    }

    #[test]
    fn the_cost_says_who_pays() {
        let record = json!({"models": {"m": {"cost": 46.724_845_199_999_95}}});
        for (billing, said) in [
            (
                Billing::Subscription,
                "Usage: $46.72 at API prices. The review ran on a Claude subscription, so this is not billed",
            ),
            (
                Billing::ApiKey,
                "Cost: $46.72, billed to the Anthropic API key.",
            ),
            (Billing::Unknown, "Usage at API prices: $46.72."),
        ] {
            let markdown = usage(&record, billing);
            assert!(markdown.contains(said), "{billing:?}: {markdown}");
        }
        assert_eq!(
            [
                Billing::named("subscription"),
                Billing::named("api-key"),
                Billing::named("")
            ],
            [Billing::Subscription, Billing::ApiKey, Billing::Unknown]
        );
        // The action names the billing with those words: api-key when a key
        // is set.
        let line = include_str!("../action.yml")
            .lines()
            .find(|line| line.trim_start().starts_with("REVIEW_BILLING:"))
            .expect("action.yml sets REVIEW_BILLING");
        let words: String = line.split_whitespace().collect();
        assert!(
            words.contains("inputs.anthropic-api-key!=''&&'api-key'||'subscription'"),
            "{line}"
        );
    }
}
