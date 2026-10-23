//! What one step learns for the later ones, kept as JSON in the trusted
//! directory: the pull request from the start step, the configuration the
//! protect step took from the trusted branch, and the threads the prepare step
//! lets the post step reply in.

use crate::{
    actions::Runner,
    error::Error,
    id::{
        Commit,
        PullNumber,
        ThreadId, //
    }, //
};
use serde::{
    Deserialize,
    Serialize,
    de::DeserializeOwned, //
};
use serde_json::Value;
use std::{
    fs,
    path::Path, //
};

/// The pull request under review, from the start step.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Pull {
    /// Its number.
    pub(crate) number: PullNumber,
    /// The head commit the checkout is at.
    pub(crate) head: Commit,
    /// The base branch's name.
    pub(crate) base: String,
    /// The repository's default branch.
    pub(crate) default_branch: String,
    /// The body of the last review an earlier run submitted, which ends with
    /// the marker; `None` before the first review.
    pub(crate) last_review: Option<String>,
}

/// What the protect step took from the trusted branch.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Protected {
    /// The branch the configuration came from, as a git revision.
    pub(crate) source: String,
    /// The paths in the checkout that now hold that branch's copy.
    pub(crate) base_copies: Vec<String>,
    /// The review's settings from that branch; `{}` when it has none.
    pub(crate) config: Value,
    /// The rules file the agents read, in the review directory.
    pub(crate) rules: String,
}

/// The review threads the post step may reply in and resolve, which the
/// prepare step listed before the review ran.
#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Own {
    /// This reviewer's open threads, which it resolves once they are settled.
    pub(crate) open: Vec<ThreadId>,
    /// This reviewer's open threads without its "Fixed" reply yet.
    pub(crate) fixed: Vec<ThreadId>,
    /// This reviewer's open threads where a person commented last.
    pub(crate) waiting: Vec<ThreadId>,
}

/// The file in the trusted directory that holds the [`Pull`].
///
/// [`Pull`]: crate::state::Pull
const PULL: &str = "pull.json";
/// The file in the trusted directory that holds what the protect step took.
const PROTECTED: &str = "protected.json";
/// The file in the trusted directory that holds the post step's threads.
const OWN: &str = "own.json";

impl Pull {
    /// Saves the pull request for the later steps.
    pub(crate) fn save(&self, runner: &Runner) -> Result<(), Error> {
        write_json(&runner.trusted_dir().join(PULL), self)
    }

    /// The pull request the start step saved.
    pub(crate) fn load(runner: &Runner) -> Result<Self, Error> {
        read_json(&runner.trusted_dir().join(PULL))
    }
}

impl Protected {
    /// Saves what the protect step took.
    pub(crate) fn save(&self, runner: &Runner) -> Result<(), Error> {
        write_json(&runner.trusted_dir().join(PROTECTED), self)
    }

    /// What the protect step took.
    pub(crate) fn load(runner: &Runner) -> Result<Self, Error> {
        read_json(&runner.trusted_dir().join(PROTECTED))
    }
}

impl Own {
    /// Saves the threads for the post step.
    pub(crate) fn save(&self, runner: &Runner) -> Result<(), Error> {
        write_json(&runner.trusted_dir().join(OWN), self)
    }

    /// The threads the prepare step listed.
    pub(crate) fn load(runner: &Runner) -> Result<Self, Error> {
        read_json(&runner.trusted_dir().join(OWN))
    }
}

/// The JSON in the file at `path`.
pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, Error> {
    let text = read_text(path)?;
    serde_json::from_str(&text).map_err(|source| Error::Json {
        path: path.to_path_buf(),
        source,
    })
}

/// Writes `value` as JSON to the file at `path`.
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), Error> {
    let text = serde_json::to_string(value).map_err(|source| Error::Json {
        path: path.to_path_buf(),
        source,
    })?;
    write_text(path, &text)
}

/// The text of the file at `path`.
fn read_text(path: &Path) -> Result<String, Error> {
    fs::read_to_string(path).map_err(|source| Error::Read {
        path: path.to_path_buf(),
        source,
    })
}

/// Writes `text` to the file at `path`.
pub(crate) fn write_text(path: &Path, text: &str) -> Result<(), Error> {
    fs::write(path, text).map_err(|source| Error::Write {
        path: path.to_path_buf(),
        source,
    })
}
