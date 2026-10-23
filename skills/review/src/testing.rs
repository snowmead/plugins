//! Helpers for tests: a temporary git repository with commits made from a map
//! of files, isolated from the machine's git config, and the review workflow
//! run by Node with stub agents.

use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{
        Path,
        PathBuf, //
    },
    process::{
        Command,
        Stdio, //
    },
};

/// The review workflow's result for `args`, run by Node with the stub agents
/// of `workflows/tests/review.mjs`: the security segment finds one Nit on
/// `src/a.rs:3`, the editor posts it, and the follow-up says thread `T1` is
/// fixed and answers a person in thread `T2` with text that starts with
/// "Fixed ".
pub(crate) fn workflow(args: &Value) -> Value {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("workflows/tests/review.mjs");
    let mut node = Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node runs");
    node.stdin
        .take()
        .expect("stdin")
        .write_all(args.to_string().as_bytes())
        .expect("the args");
    let output = node.wait_with_output().expect("the workflow");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("the result")
}

/// A temporary git repository.
pub(crate) struct Repo {
    /// The directory that holds it, removed when the repository drops.
    dir: tempfile::TempDir,
}

impl Repo {
    /// A new repository whose first branch is `main`.
    pub(crate) fn new() -> Self {
        let repo = Self {
            dir: tempfile::tempdir().expect("a temporary directory"),
        };
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }

    /// The working tree.
    pub(crate) fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Runs git with `args` and returns its output, trimmed; a failure panics.
    pub(crate) fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(self.path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("UTF-8")
            .trim()
            .to_owned()
    }

    /// Writes `files` (path, text) and commits every change; returns the commit.
    pub(crate) fn commit(&self, files: &[(&str, &str)]) -> String {
        for (name, text) in files {
            let path = self.file(name);
            fs::create_dir_all(path.parent().expect("a parent")).expect("the directory");
            fs::write(&path, text).expect("the file");
        }
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", "c"]);
        self.git(&["rev-parse", "HEAD"])
    }

    /// The path of `name` in the working tree.
    pub(crate) fn file(&self, name: &str) -> PathBuf {
        self.path().join(name)
    }
}
