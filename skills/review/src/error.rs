//! Failures that stop a step. `main` prints each as one error annotation and
//! exits with status 1.

use crate::id::InvalidRepository;
use serde_json::Value;
use std::{
    env::VarError,
    io,
    path::PathBuf, //
};

/// Why a step stopped.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    /// A failure the step explains to whoever reads the run.
    #[error("{message}")]
    Review {
        /// The explanation, one sentence or more.
        message: String,
    },
    /// A failure the step already printed with its own annotation.
    #[error("the step failed")]
    Reported,
    /// An environment variable the step needs is missing or not Unicode.
    #[error("the environment variable {name} is not set")]
    MissingEnv {
        /// The variable's name.
        name: &'static str,
        /// Whether it is missing or not Unicode.
        source: VarError,
    },
    /// The runner's repository (`GITHUB_REPOSITORY`) is not `owner/name`.
    #[error(transparent)]
    Repository {
        /// The text it holds instead.
        #[from]
        source: InvalidRepository,
    },
    /// Reading a file failed.
    #[error("could not read {}: {source}", path.display())]
    Read {
        /// The file.
        path: PathBuf,
        /// What the system said.
        source: io::Error,
    },
    /// Writing, copying, or removing a file failed.
    #[error("could not write {}: {source}", path.display())]
    Write {
        /// The file.
        path: PathBuf,
        /// What the system said.
        source: io::Error,
    },
    /// A file did not hold the JSON the step expects.
    #[error("{} is not the JSON the review expects: {source}", path.display())]
    Json {
        /// The file.
        path: PathBuf,
        /// What the parser said.
        source: serde_json::Error,
    },
    /// A git command failed.
    #[error("git {command} failed: {detail}")]
    Git {
        /// The command's arguments, joined with spaces.
        command: String,
        /// Its standard error, or why it did not start.
        detail: String,
    },
    /// A request to GitHub failed.
    #[error("GitHub {request} failed: {detail}")]
    GitHub {
        /// The method and route, or "GraphQL".
        request: String,
        /// The status and response, or the transport error.
        detail: String,
        /// The HTTP status GitHub refused the request with; none when the
        /// request did not reach GitHub or GitHub took it.
        status: Option<u16>,
    },
    /// GitHub answered a GraphQL request with errors instead of doing it.
    #[error("GitHub refused a GraphQL request: {detail}")]
    GraphQl {
        /// The errors' messages, joined with semicolons.
        detail: String,
    },
    /// GitHub did a GraphQL mutation but failed on part of its result.
    #[error("GitHub did a GraphQL mutation but failed on part of its result: {detail}")]
    GraphQlPartial {
        /// The errors' messages, joined with semicolons.
        detail: String,
        /// The result, with null where GitHub failed.
        data: Value,
    },
    /// A program the step runs could not start.
    #[error("could not run {program}: {source}")]
    Spawn {
        /// The program.
        program: String,
        /// What the system said.
        source: io::Error,
    },
}

impl Error {
    /// A failure explained by `message`.
    pub(crate) fn review(message: impl Into<String>) -> Self {
        Self::Review {
            message: message.into(),
        }
    }

    /// Whether GitHub refused the request, and so did none of it: a GraphQL
    /// reply with errors. Any other failure can come after GitHub did it.
    pub(crate) fn is_refusal(&self) -> bool {
        match self {
            Self::GraphQl { detail: _ } => true,
            Self::Review { message: _ }
            | Self::Reported
            | Self::MissingEnv { name: _, source: _ }
            | Self::Repository { source: _ }
            | Self::Read { path: _, source: _ }
            | Self::Write { path: _, source: _ }
            | Self::Json { path: _, source: _ }
            | Self::Git {
                command: _,
                detail: _,
            }
            | Self::GitHub {
                request: _,
                detail: _,
                status: _,
            }
            | Self::GraphQlPartial { detail: _, data: _ }
            | Self::Spawn {
                program: _,
                source: _,
            } => false,
        }
    }
}
