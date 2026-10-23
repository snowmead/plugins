//! The report step: names every refused tool call, from the agents too, with
//! the command or input it was refused, so a missing permission shows up in
//! the run instead of as a quiet gap in the review, and says how each turn of
//! the session ended.

use crate::{
    actions::Runner,
    error::Error,
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
    collections::{
        HashMap,
        HashSet, //
    },
    fs::{
        self,
        File, //
    },
    io::Read,
    path::{
        Path,
        PathBuf, //
    }, //
};

/// How much of a message, input, or reply the report prints.
const EXCERPT: usize = 500;

/// What the report step reads.
pub(crate) struct Report<'a> {
    /// The runner.
    pub(crate) runner: &'a Runner,
    /// Claude Code's `projects` directory, where it writes each agent's
    /// transcript; `None` when the job's environment names no home.
    pub(crate) projects: Option<&'a Path>,
}

impl Report<'_> {
    /// Prints the refused calls and each turn's ending; nothing without a
    /// session.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let Some(events) = Events::load(self.runner)? else {
            return Ok(());
        };
        let refused: Vec<&Value> = events.of("system", Some("permission_denied")).collect();
        let inputs = inputs(&events, &refused, self.projects);
        let denials: Vec<String> = refused
            .iter()
            .map(|event| {
                // A permission_denied event names the call, not its input.
                let input = inputs
                    .get(&text(&event["tool_use_id"]))
                    .map_or(Value::Null, |input| {
                        Value::String(excerpt(&text(or(&input["command"], input))))
                    });
                json!({
                    "tool": event["tool_name"],
                    "input": input,
                    "reason": excerpt(&text(or(&event["message"], &json!("")))),
                })
                .to_string()
            })
            .collect();
        if !denials.is_empty() {
            self.runner.warning(&format!(
                "{} tool call(s) were refused; the Show how the review ended step lists them.",
                denials.len()
            ));
        }
        // Tool inputs and replies come from the pull request, so workflow
        // commands stop while they print.
        let token = token()?;
        self.runner.print(&format!("::stop-commands::{token}"));
        self.runner
            .print(&format!("Refused tool calls: {}", denials.len()));
        for denial in &denials {
            self.runner.print(denial);
        }
        self.runner.print("How each turn ended:");
        for result in events.of("result", None) {
            let ending = json!({
                "subtype": result["subtype"],
                "is_error": result["is_error"],
                "terminal_reason": result["terminal_reason"],
                "api_error_status": result["api_error_status"],
                "num_turns": result["num_turns"],
                "result": excerpt(&text(or(&result["result"], &json!("")))),
            });
            self.runner.print(&ending.to_string());
        }
        self.runner.print(&format!("::{token}::"));
        Ok(())
    }
}

/// The first [`EXCERPT`] characters of `text`.
fn excerpt(text: &str) -> String {
    text.chars().take(EXCERPT).collect()
}

/// The input of each `refused` call, by its `tool_use_id`. The session's own
/// calls are in its events. An agent's calls are in its transcript, which
/// Claude Code writes as `agent-<agent_id>.jsonl` under
/// `<projects>/<checkout>/<session_id>/subagents/`; a call whose transcript
/// is missing has no input here.
fn inputs(events: &Events, refused: &[&Value], projects: Option<&Path>) -> HashMap<String, Value> {
    let wanted: HashSet<String> = refused
        .iter()
        .map(|event| text(&event["tool_use_id"]))
        .collect();
    let mut inputs = HashMap::new();
    let mut take = |event: &Value| {
        for call in event["message"]["content"].as_array().into_iter().flatten() {
            let id = text(&call["id"]);
            if call["type"] == "tool_use" && wanted.contains(&id) {
                inputs.insert(id, call["input"].clone());
            }
        }
    };
    for event in events.of("assistant", None) {
        take(event);
    }
    let agents: HashSet<Transcript> = refused
        .iter()
        .filter(|event| event["agent_id"].is_string())
        .map(|event| Transcript {
            session: text(&event["session_id"]),
            file: format!("agent-{}.jsonl", text(&event["agent_id"])),
        })
        .collect();
    // Names are compared, never joined into a path.
    for session in projects.into_iter().flat_map(entries).flat_map(entries) {
        let Some(name) = session.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        for transcript in files(&session.join("subagents")) {
            let named = transcript.file_name().and_then(|file| file.to_str());
            if named.is_some_and(|file| {
                agents.contains(&Transcript {
                    session: name.to_owned(),
                    file: file.to_owned(),
                })
            }) {
                let Ok(bytes) = fs::read(&transcript) else {
                    continue;
                };
                String::from_utf8_lossy(&bytes)
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .for_each(|event| take(&event));
            }
        }
    }
    inputs
}

/// Where a refused agent's transcript is.
#[derive(PartialEq, Eq, Hash)]
struct Transcript {
    /// The name of its session's directory, the session's id.
    session: String,
    /// Its own file name, from the agent's id.
    file: String,
}

/// The entries of `dir`; none when it cannot be read.
fn entries(dir: impl AsRef<Path>) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| Some(entry.ok()?.path()))
        .collect()
}

/// The files under `dir`, in its subdirectories too, without following links.
fn files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for path in entries(dir) {
        // A link, or an entry that cannot be read, is skipped.
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            found.extend(files(&path));
        } else if meta.is_file() {
            found.push(path);
        }
    }
    found
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
        stream::Events, //
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn lists_refused_calls_with_their_inputs_and_how_each_turn_ended_with_commands_stopped() {
        let test = TestRunner::new();
        let projects = test.temp.path().join("projects");
        let transcript = |session: &str, agent: &str, id: &str, command: &str| {
            let dir = projects
                .join("-checkout")
                .join(session)
                .join("subagents/workflows/wf_1");
            fs::create_dir_all(&dir).expect("the transcript directory");
            let call = json!({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "searching"},
                {"type": "tool_use", "id": id, "name": "Bash", "input": {"command": command, "description": "x"}},
            ]}});
            fs::write(
                dir.join(format!("agent-{agent}.jsonl")),
                format!("not JSON\n{call}\n"),
            )
            .expect("the transcript");
        };
        transcript("s1", "a1", "toolu_agent", "awk NR==1 a.txt");
        // The refused agent a2 of session s1 left no transcript; the one of
        // another session is not this run's.
        transcript("s0", "a2", "toolu_gone", "python3 -c 1");
        let events = [
            json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_main", "name": "Read", "input": {"file_path": "/etc/hosts"}}]}}),
            json!({"type": "system", "subtype": "permission_denied", "tool_name": "Read", "tool_use_id": "toolu_main", "session_id": "s1", "message": "::error::x".repeat(60)}),
            json!({"type": "system", "subtype": "permission_denied", "tool_name": "Bash", "tool_use_id": "toolu_agent", "agent_id": "a1", "session_id": "s1", "message": "This command requires approval"}),
            json!({"type": "system", "subtype": "permission_denied", "tool_name": "Write", "tool_use_id": "toolu_gone", "agent_id": "a2", "session_id": "s1"}),
            json!({"type": "result", "subtype": "success", "is_error": false, "num_turns": 3, "result": "done"}),
        ];
        let text: Vec<String> = events.iter().map(ToString::to_string).collect();
        fs::write(Events::path(&test.runner), text.join("\n")).expect("the events");
        Report {
            runner: &test.runner,
            projects: Some(&projects),
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
        let denial = |line: &str| serde_json::from_str::<serde_json::Value>(line).expect("JSON");
        // A tool other than Bash shows its whole input, and each message is
        // cut to 500 characters.
        assert_eq!(
            denial(lines[3]),
            json!({"tool": "Read", "input": r#"{"file_path":"/etc/hosts"}"#, "reason": "::error::x".repeat(50)})
        );
        assert_eq!(
            denial(lines[4]),
            json!({"tool": "Bash", "input": "awk NR==1 a.txt", "reason": "This command requires approval"})
        );
        assert_eq!(
            denial(lines[5]),
            json!({"tool": "Write", "input": null, "reason": ""})
        );
        assert_eq!(lines[6], "How each turn ended:");
        assert_eq!(
            denial(lines[7]),
            json!({"subtype": "success", "is_error": false, "terminal_reason": null, "api_error_status": null, "num_turns": 3, "result": "done"})
        );
        assert_eq!(lines[8], format!("::{token}::"));
    }

    #[test]
    fn prints_nothing_without_a_session() {
        let test = TestRunner::new();
        Report {
            runner: &test.runner,
            projects: None,
        }
        .run()
        .expect("the step");
        assert_eq!(test.log(), "");
    }
}
