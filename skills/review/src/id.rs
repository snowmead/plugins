//! The identifiers the steps pass between them: the repository, its pull
//! request, the reviews and review threads on that pull request, and the
//! commits a review covers.
//!
//! Each is its own type, so one cannot be passed where another is expected,
//! and each saves to the trusted directory as the bare number or string
//! GitHub and git give it.

use serde::{
    Deserialize,
    Serialize,
    Serializer, //
};
use std::{
    fmt,
    str::FromStr, //
};

/// A repository on GitHub, named `owner/name` (`GITHUB_REPOSITORY`).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Repository {
    /// The account that owns it.
    owner: String,
    /// Its name under that account.
    name: String,
}

/// A pull request's number in its repository, as GitHub shows it after `#`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct PullNumber {
    /// The number.
    number: u64,
}

/// A review's GraphQL node id: the pending review the post step builds, or
/// one a cancelled run left.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ReviewId {
    /// The node id.
    id: String,
}

/// A review thread's GraphQL node id, which a reply and a resolve name.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ThreadId {
    /// The node id.
    id: String,
}

/// A full git commit id: 40 (SHA-1) or 64 (SHA-256) hexadecimal digits. A
/// full id never passes as an option, and git never resolves it as an
/// abbreviation of another commit. It saves as its string and loads only
/// when it is still one.
#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub(crate) struct Commit {
    /// The digits, as given.
    id: String,
}

impl Repository {
    /// The account that owns the repository.
    pub(crate) fn owner(&self) -> &str {
        &self.owner
    }

    /// The repository's name under its owner.
    pub(crate) fn name(&self) -> &str {
        &self.name
    }
}

impl FromStr for Repository {
    type Err = InvalidRepository;

    /// The repository `text` names as `owner/name`, each part non-empty.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if let Some((owner, name)) = text.split_once('/')
            && !owner.is_empty()
            && !name.is_empty()
            && !name.contains('/')
        {
            return Ok(Self {
                owner: owner.into(),
                name: name.into(),
            });
        }
        Err(InvalidRepository { text: text.into() })
    }
}

impl fmt::Display for Repository {
    /// Writes `owner/name`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}/{}", self.owner, self.name)
    }
}

impl From<u64> for PullNumber {
    fn from(number: u64) -> Self {
        Self { number }
    }
}

impl fmt::Display for PullNumber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.number.fmt(formatter)
    }
}

impl From<&str> for ReviewId {
    fn from(id: &str) -> Self {
        Self { id: id.into() }
    }
}

impl From<&str> for ThreadId {
    fn from(id: &str) -> Self {
        Self { id: id.into() }
    }
}

impl Commit {
    /// The id as text, for git's arguments.
    pub(crate) fn as_str(&self) -> &str {
        &self.id
    }
}

impl TryFrom<String> for Commit {
    type Error = InvalidCommit;

    /// The commit `text` names, when it is a full commit id.
    fn try_from(text: String) -> Result<Self, Self::Error> {
        let full =
            matches!(text.len(), 40 | 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit());
        if full {
            Ok(Self { id: text })
        } else {
            Err(InvalidCommit { text })
        }
    }
}

impl FromStr for Commit {
    type Err = InvalidCommit;

    /// The commit `text` names, when it is a full commit id.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::try_from(text.to_owned())
    }
}

impl fmt::Display for Commit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.id)
    }
}

impl Serialize for Commit {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.id)
    }
}

/// Text that does not name a repository as `owner/name`.
#[derive(Debug, thiserror::Error)]
#[error("{text:?} is not a repository's owner/name")]
pub(crate) struct InvalidRepository {
    /// The text.
    text: String,
}

/// Text that is not a full commit id.
#[derive(Debug, thiserror::Error)]
#[error("{text:?} is not a full commit id")]
pub(crate) struct InvalidCommit {
    /// The text.
    text: String,
}

#[cfg(test)]
mod tests {
    use super::{
        Commit,
        Repository, //
    };

    #[test]
    fn a_commit_is_only_a_full_hexadecimal_id() {
        // Git reads anything else as an option or an abbreviation, so the
        // review refuses it before git sees it.
        for text in ["a".repeat(40), "0123456789ABCDEF".repeat(4)] {
            assert_eq!(text.parse::<Commit>().expect("a full id").as_str(), text);
        }
        for text in [
            String::new(),
            "a".repeat(39),
            "a".repeat(41),
            "g".repeat(40),
            format!("--{}", "a".repeat(38)),
        ] {
            assert!(text.parse::<Commit>().is_err(), "{text:?}");
        }
    }

    #[test]
    fn a_repository_is_one_owner_and_one_name() {
        let repository: Repository = "owner/name".parse().expect("a repository");
        assert_eq!(repository.owner(), "owner");
        assert_eq!(repository.name(), "name");
        assert_eq!(repository.to_string(), "owner/name");
        for text in ["", "owner", "/name", "owner/", "owner/name/more"] {
            assert!(text.parse::<Repository>().is_err(), "{text:?}");
        }
    }
}
