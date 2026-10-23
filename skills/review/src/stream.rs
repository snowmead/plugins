//! The engine's events, one JSON object per line, in the shapes Claude Code's
//! `--output-format stream-json` gives them: an `init` event, rate limit and
//! refused tool call events, one `agent` event per agent, and a last `result`.
//! Lines that are not a JSON object are skipped.

use crate::{
    actions::Runner,
    error::Error, //
};
use serde_json::Value;
use std::{
    fs,
    io,
    path::PathBuf, //
};

/// The engine's events, in order.
pub(crate) struct Events {
    /// The events.
    events: Vec<Value>,
}

impl Events {
    /// The file the run step writes the events to.
    pub(crate) fn path(runner: &Runner) -> PathBuf {
        runner.trusted_dir().join("stream.jsonl")
    }

    /// The engine's events; `None` when the engine never started.
    pub(crate) fn load(runner: &Runner) -> Result<Option<Self>, Error> {
        let path = Self::path(runner);
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(Self::parse(&String::from_utf8_lossy(&bytes)))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(Error::Read { path, source }),
        }
    }

    /// The events in `text`.
    fn parse(text: &str) -> Self {
        let events = text
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(Value::is_object)
            .collect();
        Self { events }
    }

    /// The events of `kind` (`type`), and of `subtype` when one is given.
    pub(crate) fn of<'a>(
        &'a self,
        kind: &'a str,
        subtype: Option<&'a str>,
    ) -> impl Iterator<Item = &'a Value> {
        self.events.iter().filter(move |event| {
            event["type"] == kind && subtype.is_none_or(|subtype| event["subtype"] == subtype)
        })
    }

    /// The last `result` event: how the review ended, its usage, and the
    /// status of each MCP server the agents had.
    pub(crate) fn last_result(&self) -> Option<&Value> {
        self.of("result", None).last()
    }
}

/// `value` as jq's string interpolation shows it: a string as itself, anything
/// else as its JSON.
pub(crate) fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `value`, or `fallback` when it is null or false, as jq's `//` gives it.
pub(crate) fn or<'a>(value: &'a Value, fallback: &'a Value) -> &'a Value {
    match value {
        Value::Null | Value::Bool(false) => fallback,
        other => other,
    }
}
