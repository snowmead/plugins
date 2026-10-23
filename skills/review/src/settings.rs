//! The review's settings as the steps use them. The settings file (the action's
//! `config` input, `.claude/review.json` by default) belongs to the workflow,
//! which reads all of it; the steps read only the models, apply a run's
//! overrides of them, and pass the result to the workflow in its args.
//!
//! `agents` maps each stage of the review to the model and effort its agents
//! run on. The workflow (`workflows/pr-review.js`, `DEFAULTS`) holds the default
//! of every stage; [`SESSION_MODEL`] and [`SESSION_EFFORT`] repeat the
//! session's, which a test keeps equal.
//!
//! [`SESSION_MODEL`]: crate::settings::SESSION_MODEL
//! [`SESSION_EFFORT`]: crate::settings::SESSION_EFFORT

use crate::error::Error;
use serde_json::{
    Map,
    Value, //
};
use std::{
    fmt,
    str::FromStr, //
};

/// The model and effort of a stage.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Stage {
    /// The model, by its Claude Code name.
    pub(crate) model: String,
    /// The reasoning effort.
    pub(crate) effort: Effort,
}

/// A reasoning effort Claude Code takes, as `--effort` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Effort {
    /// The least reasoning: `low`.
    Low,
    /// `medium`.
    Medium,
    /// `high`.
    High,
    /// `xhigh`.
    Xhigh,
    /// The most reasoning: `max`.
    Max,
}

/// The default model of the Claude Code session, which only starts the
/// workflow and waits for it.
const SESSION_MODEL: &str = "claude-sonnet-5-5";

/// The default effort of the Claude Code session.
const SESSION_EFFORT: Effort = Effort::Low;

/// The stages a run can set.
const STAGES: &[&str] = &[
    "session", "context", "finder", "skeptic", "followup", "editor", "judge", "loader", "scope",
];

/// Settings keys the workflow does not read, which stay out of its args:
/// `examples` are for the settings' own tests.
const NOT_FOR_THE_WORKFLOW: &[&str] = &["examples"];

/// `config` with the run's `overrides` (a JSON object of stages, or empty
/// text for none) set over its stages field by field, as the settings are set
/// over the defaults, without the keys the workflow does not read.
pub(crate) fn for_workflow(config: &Value, overrides: &str) -> Result<Value, Error> {
    let mut config = match config {
        Value::Object(fields) => fields.clone(),
        Value::Null => Map::new(),
        _ => {
            return Err(Error::review(
                "The review's settings are not a JSON object.",
            ));
        }
    };
    for key in NOT_FOR_THE_WORKFLOW {
        config.remove(*key);
    }
    let mut agents = match config.remove("agents") {
        Some(Value::Object(agents)) => agents,
        None => Map::new(),
        Some(_) => return Err(Error::review("The settings' agents are not a JSON object.")),
    };
    if !overrides.trim().is_empty() {
        let overrides: Value = serde_json::from_str(overrides)
            .map_err(|error| Error::review(format!("The agents input is not JSON: {error}")))?;
        let Value::Object(overrides) = overrides else {
            return Err(Error::review(
                "The agents input is not a JSON object of stages.",
            ));
        };
        for (name, stage) in overrides {
            match (agents.get_mut(&name), stage) {
                (Some(Value::Object(fields)), Value::Object(set)) => fields.extend(set),
                (_, stage) => {
                    agents.insert(name, stage);
                }
            }
        }
    }
    for (name, stage) in &agents {
        check_stage(name, stage)?;
    }
    config.insert("agents".into(), Value::Object(agents));
    Ok(Value::Object(config))
}

/// The session's stage in `config`, or [`SESSION_MODEL`] at [`SESSION_EFFORT`].
///
/// [`SESSION_MODEL`]: crate::settings::SESSION_MODEL
/// [`SESSION_EFFORT`]: crate::settings::SESSION_EFFORT
pub(crate) fn session(config: &Value) -> Stage {
    let stage = &config["agents"]["session"];
    Stage {
        model: stage["model"].as_str().unwrap_or(SESSION_MODEL).to_owned(),
        effort: stage["effort"]
            .as_str()
            .and_then(|effort| effort.parse().ok())
            .unwrap_or(SESSION_EFFORT),
    }
}

/// Checks that the stage `name` is one the review has, set as
/// `{model, effort}` with a known effort.
fn check_stage(name: &str, stage: &Value) -> Result<(), Error> {
    if !STAGES.contains(&name) {
        return Err(Error::review(format!(
            "The settings name a stage the review does not have: {name}. Its stages are {}.",
            STAGES.join(", ")
        )));
    }
    let Value::Object(fields) = stage else {
        return Err(Error::review(format!(
            "The {name} stage is not a JSON object of model and effort."
        )));
    };
    for (key, value) in fields {
        match key.as_str() {
            "model" if value.is_string() => {}
            "effort"
                if value
                    .as_str()
                    .is_some_and(|effort| effort.parse::<Effort>().is_ok()) => {}
            _ => {
                return Err(Error::review(format!(
                    "The {name} stage sets {key} to {value}; a stage takes a model name and an effort ({}).",
                    Effort::ALL.map(Effort::name).join(", ")
                )));
            }
        }
    }
    Ok(())
}

impl Effort {
    /// Every effort, from the least to the most, which a test keeps equal to
    /// the workflow's list.
    const ALL: [Self; 5] = [Self::Low, Self::Medium, Self::High, Self::Xhigh, Self::Max];

    /// Claude Code's name for the effort.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// Text that names no effort Claude Code takes.
pub(crate) struct UnknownEffort;

impl FromStr for Effort {
    type Err = UnknownEffort;

    /// The effort Claude Code names `name`.
    fn from_str(name: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|effort| effort.name() == name)
            .ok_or(UnknownEffort)
    }
}

impl fmt::Display for Effort {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Effort,
        SESSION_EFFORT,
        SESSION_MODEL,
        STAGES,
        for_workflow, //
    };
    use crate::testing;
    use serde_json::{
        Value,
        json, //
    };

    #[test]
    fn a_run_sets_the_fields_it_names_over_the_settings() {
        let config = json!({
            "segments": [{"name": "bugs"}],
            "examples": [{"files": ["a.rs"], "segments": ["bugs"]}],
            "agents": {"finder": {"model": "claude-sonnet-5-5", "effort": "high"}, "editor": {"effort": "medium"}},
        });
        let merged = for_workflow(
            &config,
            r#"{"finder": {"model": "claude-opus-5-5"}, "skeptic": {"effort": "low"}}"#,
        )
        .expect("valid settings");
        assert_eq!(
            merged,
            json!({
                "segments": [{"name": "bugs"}],
                "agents": {
                    "finder": {"model": "claude-opus-5-5", "effort": "high"},
                    "editor": {"effort": "medium"},
                    "skeptic": {"effort": "low"},
                },
            })
        );
        assert_eq!(
            for_workflow(&json!(null), "").expect("no settings"),
            json!({"agents": {}})
        );
    }

    #[test]
    fn refuses_a_stage_or_effort_the_review_does_not_have() {
        for (config, overrides, message) in [
            (
                json!({}),
                r#"{"reviewer": {"model": "m"}}"#,
                "does not have: reviewer",
            ),
            (
                json!({"agents": {"editor": {"effort": "huge"}}}),
                "",
                "sets effort to \"huge\"",
            ),
            (
                json!({"agents": {"editor": "fast"}}),
                "",
                "not a JSON object of model and effort",
            ),
            (json!({}), "[1]", "not a JSON object of stages"),
            (json!({}), "{", "not JSON"),
        ] {
            let error = for_workflow(&config, overrides)
                .expect_err(message)
                .to_string();
            assert!(error.contains(message), "{error}");
        }
    }

    #[test]
    fn the_stages_and_efforts_are_the_workflows() {
        // The workflow lists its own in the error for one it does not have.
        let listed = |agents: Value, before: &str, after: &str| {
            let result = testing::workflow(&json!({"mode": "names", "config": {"agents": agents}}));
            let error = result["error"].as_str().expect("an error");
            let list = error
                .split_once(before)
                .and_then(|(_, rest)| rest.strip_suffix(after))
                .unwrap_or_else(|| panic!("{error}"));
            let mut names: Vec<String> = list.split(", ").map(str::to_owned).collect();
            names.sort();
            names
        };
        let sorted = |names: &[&str]| {
            let mut names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
            names.sort();
            names
        };
        assert_eq!(
            listed(json!({"none": {}}), "which is not one of ", "."),
            sorted(STAGES)
        );
        assert_eq!(
            listed(json!({"finder": {"effort": "none"}}), "an effort (", ")."),
            sorted(&Effort::ALL.map(Effort::name))
        );
    }

    #[test]
    fn the_session_default_is_the_workflows() {
        let workflow = include_str!("../workflows/pr-review.js");
        let line = format!("session: {{ model: '{SESSION_MODEL}', effort: '{SESSION_EFFORT}' }}");
        assert!(
            workflow.contains(&line),
            "workflows/pr-review.js has no `{line}` default"
        );
    }
}
