//! The system's git, which the steps run in the checkout before the agents
//! start. (The agents run [`guard`] instead.)
//!
//! [`guard`]: crate::guard

use crate::error::Error;
use std::{
    ffi::OsStr,
    path::Path,
    process::Command, //
};

/// The repository the steps read: the checkout at the pull request's head.
pub(crate) struct Git<'a> {
    /// The checkout.
    dir: &'a Path,
}

impl<'a> Git<'a> {
    /// The repository at `dir`.
    pub(crate) fn new(dir: &'a Path) -> Self {
        Self { dir }
    }

    /// Runs git with `args` and returns its standard output.
    pub(crate) fn output<S: AsRef<OsStr>>(&self, args: &[S]) -> Result<Vec<u8>, Error> {
        let output = Command::new("git")
            .args(args)
            .current_dir(self.dir)
            .output()
            .map_err(|error| failure(args, error.to_string()))?;
        if !output.status.success() {
            return Err(failure(
                args,
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        Ok(output.stdout)
    }

    /// Runs git with `args` and returns its standard output as text, one line
    /// break trimmed from the end.
    pub(crate) fn text<S: AsRef<OsStr>>(&self, args: &[S]) -> Result<String, Error> {
        let bytes = self.output(args)?;
        let text = String::from_utf8(bytes)
            .map_err(|_| failure(args, "printed text that is not UTF-8".into()))?;
        Ok(text.strip_suffix('\n').unwrap_or(&text).to_owned())
    }

    /// Whether git with `args` succeeds; its output is dropped.
    pub(crate) fn succeeds<S: AsRef<OsStr>>(&self, args: &[S]) -> bool {
        Command::new("git")
            .args(args)
            .current_dir(self.dir)
            .output()
            .is_ok_and(|output| output.status.success())
    }

    /// The files `range` changes (`base...head`, two commits, or one commit
    /// against the working tree), renames as a deletion and an addition.
    /// Each name is the path itself: git separates them with NUL and quotes
    /// none. A name that is not UTF-8 is an error: the review's agents get the
    /// names as JSON, and leaving the file out would hide it from them. The
    /// `--` keeps a revision a revision when the pull request adds a file of
    /// that name.
    pub(crate) fn names(&self, range: &[&str]) -> Result<Vec<String>, Error> {
        let mut args = vec!["diff", "--no-renames", "--name-only", "-z"];
        args.extend_from_slice(range);
        args.push("--");
        self.output(&args)?
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
            .map(|name| {
                String::from_utf8(name.to_vec()).map_err(|_| {
                    Error::review(format!(
                        "{} is not a UTF-8 file name, so the review cannot name it to its agents. \
                         Rename it to review this change.",
                        String::from_utf8_lossy(name)
                    ))
                })
            })
            .collect()
    }
}

/// The error of git with `args`.
fn failure<S: AsRef<OsStr>>(args: &[S], detail: String) -> Error {
    let command: Vec<String> = args
        .iter()
        .map(|arg| arg.as_ref().to_string_lossy().into_owned())
        .collect();
    Error::Git {
        command: command.join(" "),
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::Git;
    use crate::testing::Repo;
    use std::{
        ffi::OsStr,
        os::unix::ffi::OsStrExt,
        process::Command, //
    };

    #[test]
    fn names_each_file_as_its_path() {
        let repo = Repo::new();
        let base = repo.commit(&[("src/a.rs", "a")]);
        // Git quotes these names in a line-separated list.
        let head = repo.commit(&[
            ("src/a\"b.rs", "b"),
            ("src/tab\there.rs", "c"),
            ("src/é.rs", "d"),
        ]);
        let git = Git::new(repo.path());
        assert_eq!(
            git.names(&[&format!("{base}...{head}")])
                .expect("the names"),
            ["src/a\"b.rs", "src/tab\there.rs", "src/é.rs"]
        );
        std::fs::write(repo.file("src/a.rs"), "changed").expect("a change");
        assert_eq!(git.names(&["HEAD"]).expect("the names"), ["src/a.rs"]);
    }

    #[test]
    fn a_file_named_like_a_revision_stays_a_name() {
        let repo = Repo::new();
        let base = repo.commit(&[("src/a.rs", "a")]);
        let head = repo.commit(&[("HEAD", "a file named HEAD")]);
        let git = Git::new(repo.path());
        std::fs::write(repo.file("HEAD"), "changed").expect("a change");
        assert_eq!(git.names(&["HEAD"]).expect("the names"), ["HEAD"]);
        std::fs::write(repo.file(&base), "named after a commit").expect("a file");
        repo.git(&["add", "-A"]);
        assert_eq!(git.names(&[&base, &head]).expect("the names"), ["HEAD"]);
    }

    #[test]
    fn a_name_that_is_not_utf8_says_so() {
        let repo = Repo::new();
        let base = repo.commit(&[("src/a.rs", "a")]);
        // Into the index only: some file systems, such as macOS's, refuse the
        // name on disk.
        let blob = repo.git(&["rev-parse", "HEAD:src/a.rs"]);
        let mut entry = format!("100644,{blob},").into_bytes();
        entry.extend_from_slice(b"src/caf\xe9.rs");
        let status = Command::new("git")
            .args(["update-index", "--add", "--cacheinfo"])
            .arg(OsStr::from_bytes(&entry))
            .current_dir(repo.path())
            .status()
            .expect("git runs");
        assert!(status.success(), "git update-index");
        repo.git(&["commit", "-q", "-m", "c"]);
        let head = repo.git(&["rev-parse", "HEAD"]);
        let error = Git::new(repo.path())
            .names(&[&format!("{base}...{head}")])
            .expect_err("a name that is not UTF-8")
            .to_string();
        assert!(
            error.contains("src/caf\u{FFFD}.rs is not a UTF-8 file name"),
            "{error}"
        );
    }
}
