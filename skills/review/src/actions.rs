//! The GitHub Actions runner the steps run on: the two directories the review
//! keeps its files in, step outputs, the step summary, and the workflow
//! commands that become annotations.
//!
//! The review directory holds what the review's agents read (the rules, the
//! settings, the pull request, and its threads); the engine gets it with
//! `--read-dir`. The trusted directory holds what only the job reads and writes
//! (the args, the engine's events and record, the threads the job may reply
//! on, and the git the agents run), outside every directory the agents can
//! reach.

use crate::error::Error;
use std::{
    cell::RefCell,
    env,
    fs::{
        self,
        OpenOptions, //
    },
    io::{
        self,
        Write, //
    },
    path::{
        Path,
        PathBuf, //
    }, //
};

/// The title of the review's annotations.
pub(crate) const TITLE: &str = "Claude review";

/// The kind of a workflow command that becomes an annotation.
#[derive(Clone, Copy)]
pub(crate) enum Annotation {
    /// A failure, shown in red.
    Error,
    /// A problem that did not stop the step.
    Warning,
    /// Information about the run.
    Notice,
}

/// The runner's files and log, from its environment.
pub(crate) struct Runner {
    /// The review directory, which the agents can read.
    review: PathBuf,
    /// The trusted directory, which only the job reads.
    trusted: PathBuf,
    /// The file step outputs go to (`GITHUB_OUTPUT`).
    outputs: PathBuf,
    /// The step's Markdown summary (`GITHUB_STEP_SUMMARY`).
    summary: PathBuf,
    /// Where workflow commands and log lines go: standard output on a runner.
    log: RefCell<Box<dyn Write>>,
}

impl Runner {
    /// The runner of this step, from `RUNNER_TEMP`, `GITHUB_OUTPUT`, and
    /// `GITHUB_STEP_SUMMARY`. It creates both directories.
    pub(crate) fn from_env() -> Result<Self, Error> {
        let temp = PathBuf::from(var("RUNNER_TEMP")?);
        Self::new(
            &temp,
            PathBuf::from(var("GITHUB_OUTPUT")?),
            PathBuf::from(var("GITHUB_STEP_SUMMARY")?),
            Box::new(io::stdout()),
        )
    }

    /// A runner whose directories are under `temp`.
    pub(crate) fn new(
        temp: &Path,
        outputs: PathBuf,
        summary: PathBuf,
        log: Box<dyn Write>,
    ) -> Result<Self, Error> {
        let runner = Self {
            review: temp.join("claude-review"),
            trusted: temp.join("claude-review-trusted"),
            outputs,
            summary,
            log: RefCell::new(log),
        };
        for dir in [&runner.review, &runner.trusted] {
            fs::create_dir_all(dir).map_err(|source| Error::Write {
                path: dir.clone(),
                source,
            })?;
        }
        Ok(runner)
    }

    /// The review directory, which the agents can read.
    pub(crate) fn review_dir(&self) -> &Path {
        &self.review
    }

    /// The trusted directory, which only the job reads.
    pub(crate) fn trusted_dir(&self) -> &Path {
        &self.trusted
    }

    /// Prints an annotation. A message is one line, so text from the pull
    /// request cannot start a workflow command of its own.
    pub(crate) fn annotate(&self, kind: Annotation, title: &str, message: &str) {
        let command = match kind {
            Annotation::Error => "error",
            Annotation::Warning => "warning",
            Annotation::Notice => "notice",
        };
        self.print(&format!("::{command} title={title}::{}", one_line(message)));
    }

    /// Prints a warning titled [`TITLE`].
    ///
    /// [`TITLE`]: crate::actions::TITLE
    pub(crate) fn warning(&self, message: &str) {
        self.annotate(Annotation::Warning, TITLE, message);
    }

    /// Prints a notice titled [`TITLE`].
    ///
    /// [`TITLE`]: crate::actions::TITLE
    pub(crate) fn notice(&self, message: &str) {
        self.annotate(Annotation::Notice, TITLE, message);
    }

    /// Prints one line to the step's log.
    pub(crate) fn print(&self, line: &str) {
        let mut log = self.log.borrow_mut();
        // A log that cannot be written has no one to tell.
        let _ = writeln!(log, "{line}");
        let _ = log.flush();
    }

    /// Sets the step output `key` to the one-line `value`.
    pub(crate) fn set_output(&self, key: &str, value: &str) -> Result<(), Error> {
        append(&self.outputs, &format!("{key}={}\n", one_line(value)))
    }

    /// Adds Markdown to the step summary.
    pub(crate) fn summarize(&self, markdown: &str) -> Result<(), Error> {
        append(&self.summary, markdown)
    }
}

/// The value of the environment variable `name`.
pub(crate) fn var(name: &'static str) -> Result<String, Error> {
    env::var(name).map_err(|source| Error::MissingEnv { name, source })
}

/// The value of the environment variable `name`, empty when it is unset.
pub(crate) fn var_or_empty(name: &str) -> String {
    env::var(name).unwrap_or_default()
}

/// `text` with its line breaks turned into spaces.
pub(crate) fn one_line(text: &str) -> String {
    text.replace(['\r', '\n'], " ")
}

/// Appends `text` to the file at `path`.
fn append(path: &Path, text: &str) -> Result<(), Error> {
    let write = || -> io::Result<()> {
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        file.write_all(text.as_bytes())
    };
    write().map_err(|source| Error::Write {
        path: path.to_path_buf(),
        source,
    })
}

/// A runner for tests, under a temporary directory, whose log they can read.
#[cfg(test)]
pub(crate) struct TestRunner {
    /// The runner.
    pub(crate) runner: Runner,
    /// The temporary directory that holds its files.
    pub(crate) temp: tempfile::TempDir,
    /// What it printed.
    log: std::rc::Rc<RefCell<Vec<u8>>>,
}

#[cfg(test)]
impl TestRunner {
    /// A runner under a new temporary directory.
    pub(crate) fn new() -> Self {
        let temp = tempfile::tempdir().expect("a temporary directory");
        let log = std::rc::Rc::new(RefCell::new(Vec::new()));
        let runner = Runner::new(
            temp.path(),
            temp.path().join("output"),
            temp.path().join("step-summary"),
            Box::new(SharedLog { bytes: log.clone() }),
        )
        .expect("the runner's directories");
        Self { runner, temp, log }
    }

    /// Everything the runner printed so far.
    pub(crate) fn log(&self) -> String {
        String::from_utf8(self.log.borrow().clone()).expect("a UTF-8 log")
    }

    /// The step outputs written so far.
    pub(crate) fn outputs(&self) -> String {
        fs::read_to_string(self.temp.path().join("output")).unwrap_or_default()
    }

    /// The step summary written so far.
    pub(crate) fn step_summary(&self) -> String {
        fs::read_to_string(self.temp.path().join("step-summary")).unwrap_or_default()
    }
}

/// A log that tests read back.
#[cfg(test)]
struct SharedLog {
    /// What was written, shared with the [`TestRunner`].
    bytes: std::rc::Rc<RefCell<Vec<u8>>>,
}

#[cfg(test)]
impl Write for SharedLog {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
