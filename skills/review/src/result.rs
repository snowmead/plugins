//! The result step: the review workflow's own return value, which it takes
//! from the run record that the workflow's completion notice names, not from
//! Claude's answer.
//!
//! A session without the Workflow tool, a workflow that did not finish, a
//! result that is not a review of the head, and a review that ran on args
//! other than the job's each fail the step, so a review never ends green with
//! nothing posted and never posts a review of files the session's copy of the
//! args cut or changed. The step also writes how many agents ran, for how
//! long, and how much each model was used to the job's summary.

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
    /// Saves the workflow's review for the post step, or fails without one.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let pull = Pull::load(self.runner)?;
        let Some(events) = Events::load(self.runner)? else {
            return Err(Error::review(
                "Claude Code did not start, so the review could not run.",
            ));
        };
        let has_workflow = events
            .init()
            .and_then(|init| init["tools"].as_array())
            .is_some_and(|tools| tools.iter().any(|tool| tool == "Workflow"));
        if !has_workflow {
            return Err(Error::review(
                "This Claude Code session has no Workflow tool, so the review could not run.",
            ));
        }
        let record = events
            .of("system", Some("task_notification"))
            .filter(|event| event["status"] == "completed")
            .last()
            .and_then(|event| event["output_file"].as_str())
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                Error::review("The review workflow did not finish, so nothing was posted.")
            })?;
        let record: Value = read_json(&record)?;
        write_json(&record_path(self.runner), &record)?;
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
                "The review workflow returned no review: {}",
                one_line(&reason)
            )));
        }
        if review["args"] != prepare::load_args(self.runner)? {
            return Err(Error::review(
                "The review workflow ran on args other than the job's, so nothing was posted.",
            ));
        }
        self.runner
            .summarize(&usage(&record, events.last_result(), self.billing))
    }
}

/// The run record the result step copied.
fn record_path(runner: &Runner) -> PathBuf {
    runner.trusted_dir().join("record.json")
}

/// The review the result step took from the record, which the post step posts.
pub(crate) fn review_path(runner: &Runner) -> PathBuf {
    runner.trusted_dir().join("result.json")
}

/// The job summary's account of the review: how many agents ran and for how
/// long, each model's tokens, and what they cost. Claude Code prices the
/// tokens at API rates; on a subscription that measures usage, not a bill.
fn usage(record: &Value, result: Option<&Value>, billing: Billing) -> String {
    let agents: Vec<&Value> = record["workflowProgress"]
        .as_array()
        .map(|progress| {
            progress
                .iter()
                .filter(|agent| agent["type"] == "workflow_agent" && !agent["startedAt"].is_null())
                .collect()
        })
        .unwrap_or_default();
    let mut markdown = String::from("### Claude review\n");
    let start = agents
        .iter()
        .filter_map(|agent| agent["startedAt"].as_f64())
        .reduce(f64::min);
    let end = agents
        .iter()
        .filter_map(|agent| {
            Some(agent["startedAt"].as_f64()? + agent["durationMs"].as_f64().unwrap_or(0.0))
        })
        .reduce(f64::max);
    match (agents.len(), start, end) {
        (0, _, _) => markdown.push_str("No agents ran\n"),
        (count, Some(start), Some(end)) => {
            markdown.push_str(&format!(
                "{count} agents, {} minutes\n",
                ((end - start) / 60_000.0).floor()
            ));
        }
        (count, _, _) => markdown.push_str(&format!("{count} agents\n")),
    }
    let null = Value::Null;
    let result = result.unwrap_or(&null);
    if let Some(models) = result["modelUsage"]
        .as_object()
        .filter(|models| !models.is_empty())
    {
        markdown.push_str(
            "\n| Model | Input | Output | Cache read | Cache write |\n|---|---:|---:|---:|---:|\n",
        );
        for (model, used) in models {
            let tokens = |key: &str| {
                used[key]
                    .as_u64()
                    .map_or_else(|| "?".to_owned(), |count| count.to_string())
            };
            markdown.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                model.replace('|', "/"),
                tokens("inputTokens"),
                tokens("outputTokens"),
                tokens("cacheReadInputTokens"),
                tokens("cacheCreationInputTokens"),
            ));
        }
    }
    let cost = result["total_cost_usd"]
        .as_f64()
        .map_or_else(|| "unknown".to_owned(), |cost| format!("${cost:.2}"));
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

    /// Runs the step over a session with `tools` whose workflow returned each
    /// of `records` (`None` for a record that is gone), one notice each.
    fn read(tools: &[&str], records: &[Option<Value>]) -> (TestRunner, Result<Value, String>) {
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
        let mut events = vec![
            "not JSON from a hook".to_owned(),
            json!({"type": "system", "subtype": "init", "tools": tools}).to_string(),
        ];
        for (index, record) in records.iter().enumerate() {
            let path = test.temp.path().join(format!("run-{index}.json"));
            if let Some(record) = record {
                write_json(&path, &json!({"result": record, "workflowProgress": []}))
                    .expect("the record");
            }
            events.push(
                json!({"type": "system", "subtype": "task_notification", "status": "completed", "output_file": path})
                    .to_string(),
            );
        }
        fs::write(Events::path(&test.runner), events.join("\n") + "\n").expect("the events");
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
    fn takes_the_last_finished_review_of_the_head() {
        let (test, result) = read(
            &["Bash", "Workflow"],
            &[Some(json!({"error": "an earlier run"})), Some(review())],
        );
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
        let mut cut = review();
        cut["args"]["changed"] = json!(["src/a.rs"]);
        let mut other = review();
        other["head"] = json!("0".repeat(40));
        for (name, tools, records, message) in [
            (
                "no Workflow tool",
                vec!["Bash"],
                vec![Some(review())],
                "has no Workflow tool",
            ),
            (
                "no finished workflow",
                vec!["Workflow"],
                vec![],
                "did not finish",
            ),
            (
                "a record that is missing",
                vec!["Workflow"],
                vec![None],
                "did not finish",
            ),
            (
                "another commit's review",
                vec!["Workflow"],
                vec![Some(other)],
                "returned no review: unexpected result",
            ),
            (
                "an error",
                vec!["Workflow"],
                vec![Some(
                    json!({"error": "the context stage failed\n::warning::x"}),
                )],
                "returned no review: the context stage failed ::warning::x",
            ),
            (
                "no result",
                vec!["Workflow"],
                vec![Some(json!("text"))],
                "returned no review: unexpected result",
            ),
            // The session copies the args into its Workflow call, and a long
            // list can come out cut or changed.
            (
                "args the session cut",
                vec!["Workflow"],
                vec![Some(cut)],
                "ran on args other than the job's",
            ),
        ] {
            let (_, result) = read(&tools, &records);
            let error = result.expect_err(name);
            assert!(error.contains(message), "{name}: {error}");
            assert!(!error.contains('\n'), "{name}: {error}");
        }
    }

    #[test]
    fn says_without_a_session() {
        let (test, _) = read(&["Workflow"], &[]);
        fs::remove_file(Events::path(&test.runner)).expect("no events");
        let error = ReadResult {
            runner: &test.runner,
            billing: Billing::Unknown,
        }
        .run()
        .expect_err("no session")
        .to_string();
        assert_eq!(
            error,
            "Claude Code did not start, so the review could not run."
        );
    }

    #[test]
    fn the_summary_counts_agents_minutes_and_each_models_tokens() {
        let record = json!({"workflowProgress": [
            {"type": "workflow_agent", "startedAt": 1_000, "durationMs": 120_000},
            {"type": "workflow_agent", "startedAt": 61_000, "durationMs": 200_000},
            {"type": "workflow_agent", "startedAt": null},
            {"type": "log"},
        ]});
        let result = json!({"total_cost_usd": 9.126, "modelUsage": {
            "claude-sonnet-5-5": {"inputTokens": 10, "outputTokens": 20, "cacheReadInputTokens": 30, "cacheCreationInputTokens": 40},
        }});
        let markdown = usage(&record, Some(&result), Billing::Unknown);
        assert!(
            markdown.starts_with("### Claude review\n2 agents, 4 minutes\n"),
            "{markdown}"
        );
        assert!(
            markdown.contains("| claude-sonnet-5-5 | 10 | 20 | 30 | 40 |\n"),
            "{markdown}"
        );
        assert!(
            markdown.ends_with("\nUsage at API prices: $9.13.\n"),
            "{markdown}"
        );
        assert!(
            usage(&json!({}), None, Billing::Unknown)
                .contains("No agents ran\n\nUsage at API prices: unknown.")
        );
    }

    #[test]
    fn the_cost_says_who_pays() {
        let result = json!({"total_cost_usd": 46.724_845_199_999_95});
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
            let markdown = usage(&json!({}), Some(&result), billing);
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
