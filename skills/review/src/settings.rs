//! The review's settings as the steps use them. The settings file (the action's
//! `config` input, `.claude/review.json` by default) belongs to the engine,
//! which reads all of it; the steps read only the models, apply a run's
//! overrides of them, and pass the result to the engine in its args.
//!
//! `agents` maps each stage of the review to the model and effort its agents
//! run on. The engine (`engine/settings.ts`, `DEFAULTS`) holds the default of
//! every stage.

use crate::error::Error;
use serde_json::{
    Map,
    Value, //
};
use std::{
    fmt,
    str::FromStr, //
};

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

/// The stages a run can set.
const STAGES: &[&str] = &[
    "context", "scope", "finder", "skeptic", "followup", "editor", "judge", "tuner",
];

/// Stages earlier versions had, which settings may still name: they are taken
/// and left out of the engine's args. `session` started the workflow, and
/// `loader` read the settings and the threads, which the engine now reads
/// itself.
const RETIRED_STAGES: &[&str] = &["session", "loader"];

/// Settings keys the engine does not read, which stay out of its args:
/// `examples` are for the settings' own tests.
const NOT_FOR_THE_ENGINE: &[&str] = &["examples"];

/// `config` with the run's `overrides` (a JSON object of stages, or empty
/// text for none) set over its stages field by field, as the settings are set
/// over the defaults, without the keys and stages the engine does not read.
pub(crate) fn for_engine(config: &Value, overrides: &str) -> Result<Value, Error> {
    let mut config = match config {
        Value::Object(fields) => fields.clone(),
        Value::Null => Map::new(),
        _ => {
            return Err(Error::review(
                "The review's settings are not a JSON object.",
            ));
        }
    };
    for key in NOT_FOR_THE_ENGINE {
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
    agents.retain(|name, _| !RETIRED_STAGES.contains(&name.as_str()));
    config.insert("agents".into(), Value::Object(agents));
    Ok(Value::Object(config))
}

/// Checks that the stage `name` is one the review has, set as
/// `{model, effort}` with a known effort.
fn check_stage(name: &str, stage: &Value) -> Result<(), Error> {
    if !STAGES.contains(&name) && !RETIRED_STAGES.contains(&name) {
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
    /// the engine's list.
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
        STAGES,
        for_engine, //
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
        let merged = for_engine(
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
            for_engine(&json!(null), "").expect("no settings"),
            json!({"agents": {}})
        );
        // A stage earlier versions had is taken and left out.
        assert_eq!(
            for_engine(
                &json!({"agents": {"session": {"model": "m"}, "loader": {}}}),
                r#"{"session": {"effort": "low"}}"#
            )
            .expect("retired stages"),
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
            let error = for_engine(&config, overrides)
                .expect_err(message)
                .to_string();
            assert!(error.contains(message), "{error}");
        }
    }

    #[test]
    fn the_stages_and_efforts_are_the_engines() {
        // The engine lists its own in the error for one it does not have.
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
}
