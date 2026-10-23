//! The report step: names every refused tool call, by agent, with the input
//! it was refused, so a missing permission shows up in the run instead of as
//! a quiet gap in the review; says how each agent and the review ended; and
//! prints the end of the engine's log.

use crate::{
    actions::Runner,
    error::Error,
    session,
    stream::{
        Events,
        or,
        text, //
    }, //
};
use serde_json::{
    Value,
    json, //
};
use std::{
    fs::{
        self,
        File, //
    },
    io::Read,
    path::Path, //
};

/// How much of a message, input, or line the report prints.
const EXCERPT: usize = 500;

/// How many of the engine's last lines the report prints.
const LOG_LINES: usize = 40;

/// What the report step reads.
pub(crate) struct Report<'a> {
    /// The runner.
    pub(crate) runner: &'a Runner,
}

impl Report<'_> {
    /// Prints the refused calls, each agent's and the review's ending, and the
    /// engine's last lines; nothing when the engine never ran.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let events = Events::load(self.runner)?;
        let log = fs::read(session::log_path(self.runner)).ok();
        if events.is_none() && log.is_none() {
            return Ok(());
        }
        let refused: Vec<String> = events
            .iter()
            .flat_map(|events| events.of("system", Some("permission_denied")))
            .map(|event| {
                let input = &event["tool_input"];
                let input = match input {
                    Value::Null => Value::Null,
                    input => Value::String(excerpt(&text(or(&input["command"], input)))),
                };
                json!({"agent": event["agent"], "tool": event["tool_name"], "input": input})
                    .to_string()
            })
            .collect();
        if !refused.is_empty() {
            self.runner.warning(&format!(
                "{} tool call(s) were refused; the Show how the review ended step lists them.",
                refused.len()
            ));
        }
        // Agent labels, tool inputs, and the log come from the pull request,
        // so workflow commands stop while they print.
        let token = token()?;
        self.runner.print(&format!("::stop-commands::{token}"));
        self.runner
            .print(&format!("Refused tool calls: {}", refused.len()));
        for line in &refused {
            self.runner.print(line);
        }
        self.runner.print("How each agent ended:");
        for agent in events.iter().flat_map(|events| events.of("agent", None)) {
            let ending = json!({
                "agent": agent["label"],
                "model": agent["model"],
                "status": excerpt(&text(&agent["status"])),
                "turns": agent["turns"],
                "ms": agent["ms"],
            });
            self.runner.print(&ending.to_string());
        }
        self.runner.print("How the review ended:");
        if let Some(result) = events.as_ref().and_then(Events::last_result) {
            let ending = json!({
                "subtype": result["subtype"],
                "is_error": result["is_error"],
                "terminal_reason": result["terminal_reason"],
                "api_error_status": result["api_error_status"],
            });
            self.runner.print(&ending.to_string());
        }
        if let Some(log) = &log {
            let log = String::from_utf8_lossy(log);
            let lines: Vec<&str> = log.lines().collect();
            self.runner.print(&format!(
                "The engine's last {} of {} log lines:",
                lines.len().min(LOG_LINES),
                lines.len()
            ));
            for line in &lines[lines.len().saturating_sub(LOG_LINES)..] {
                self.runner.print(&excerpt(line));
            }
        }
        self.runner.print(&format!("::{token}::"));
        Ok(())
    }
}

/// The first [`EXCERPT`] characters of `text`.
fn excerpt(text: &str) -> String {
    text.chars().take(EXCERPT).collect()
}

/// A token no printed text can guess, to end `stop-commands` with.
fn token() -> Result<String, Error> {
    let path = Path::new("/dev/urandom");
    let mut bytes = [0_u8; 16];
    File::open(path)
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(|source| Error::Read {
            path: path.to_path_buf(),
            source,
        })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::Report;
    use crate::{
        actions::TestRunner,
        session,
        stream::Events, //
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn lists_refused_calls_how_each_agent_and_the_review_ended_and_the_log_with_commands_stopped() {
        let test = TestRunner::new();
        let events = [
            json!({"type": "system", "subtype": "init", "engine": "review"}),
            json!({"type": "system", "subtype": "permission_denied", "agent": "bugs @1", "tool_name": "Read", "tool_use_id": "t1", "tool_input": {"file_path": "/etc/hosts"}}),
            json!({"type": "system", "subtype": "permission_denied", "agent": "::error::x", "tool_name": "mcp__review__git", "tool_use_id": "t2", "tool_input": {"command": "::error::y".repeat(60)}}),
            json!({"type": "system", "subtype": "permission_denied", "agent": "editor", "tool_name": "Write", "tool_use_id": "t3"}),
            json!({"type": "agent", "label": "context", "stage": "context", "model": "m", "status": "ok", "turns": 3, "ms": 1200}),
            json!({"type": "result", "subtype": "success", "is_error": false, "total_cost_usd": 1.5}),
        ];
        let text: Vec<String> = events.iter().map(ToString::to_string).collect();
        fs::write(Events::path(&test.runner), text.join("\n")).expect("the events");
        let log: Vec<String> = (1..=45).map(|n| format!("line {n}")).collect();
        fs::write(session::log_path(&test.runner), log.join("\n") + "\n").expect("the log");
        Report {
            runner: &test.runner,
        }
        .run()
        .expect("the step");
        let log = test.log();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(
            lines[0],
            "::warning title=Claude review::3 tool call(s) were refused; the Show how the review ended step lists them."
        );
        let token = lines[1]
            .strip_prefix("::stop-commands::")
            .expect("commands stop");
        assert_eq!(token.len(), 32);
        assert_eq!(lines[2], "Refused tool calls: 3");
        let line = |text: &str| serde_json::from_str::<serde_json::Value>(text).expect("JSON");
        // A tool without a command shows its whole input, and each input is
        // cut to 500 characters.
        assert_eq!(
            line(lines[3]),
            json!({"agent": "bugs @1", "tool": "Read", "input": r#"{"file_path":"/etc/hosts"}"#})
        );
        assert_eq!(
            line(lines[4]),
            json!({"agent": "::error::x", "tool": "mcp__review__git", "input": "::error::y".repeat(50)})
        );
        assert_eq!(
            line(lines[5]),
            json!({"agent": "editor", "tool": "Write", "input": null})
        );
        assert_eq!(lines[6], "How each agent ended:");
        assert_eq!(
            line(lines[7]),
            json!({"agent": "context", "model": "m", "status": "ok", "turns": 3, "ms": 1200})
        );
        assert_eq!(lines[8], "How the review ended:");
        assert_eq!(
            line(lines[9]),
            json!({"subtype": "success", "is_error": false, "terminal_reason": null, "api_error_status": null})
        );
        assert_eq!(lines[10], "The engine's last 40 of 45 log lines:");
        assert_eq!(lines[11], "line 6");
        assert_eq!(lines[50], "line 45");
        assert_eq!(lines[51], format!("::{token}::"));
        assert_eq!(lines.len(), 52);
    }

    #[test]
    fn prints_nothing_when_the_engine_never_ran() {
        let test = TestRunner::new();
        Report {
            runner: &test.runner,
        }
        .run()
        .expect("the step");
        assert_eq!(test.log(), "");
    }
}
