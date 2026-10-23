//! The protect step: replaces what configures the review with a trusted
//! branch's copy, so a pull request can neither run code through it nor
//! loosen or instruct its own review.
//!
//! Claude Code acts on `.claude/` (hooks, skills, settings), `.claude.json`,
//! `.mcp.json`, and instruction files as it starts, and git and husky on
//! `.gitmodules` and `.husky/` when the agents run git. A `.gitattributes` or
//! ignore file (`.gitignore`, `.rgignore`, `.ignore`) in any directory can hide
//! a diff or a file from the agents' git and rg. The rules file and the
//! settings file set how the review runs. Each of those paths, in the checkout
//! and in git's index, becomes the trusted branch's copy, or goes when that
//! branch has none; the review reads the pull request's versions with
//! `git show`.
//!
//! The trusted branch is the pull request's base when it has the rules or the
//! settings file, else the default branch when it has them, else the base.
//! The step also copies the rules to the review directory, where the agents
//! read them, and keeps the settings for the later steps.
//!
//! It stops first when the checkout keeps a credential in its own git config,
//! as `actions/checkout` does unless `persist-credentials: false`: the agents
//! read the checkout, its `.git/config` included.

use crate::{
    actions::Runner,
    error::Error,
    git::Git,
    state::{
        Protected,
        Pull, //
    }, //
};
use serde_json::{
    Map,
    Value, //
};
use std::{
    collections::HashSet,
    ffi::{
        OsStr,
        OsString, //
    },
    fs,
    io,
    os::unix::ffi::{
        OsStrExt,
        OsStringExt, //
    },
    path::Path, //
};

/// Paths that configure Claude Code, git, or husky wherever the checkout has
/// them; the rules and settings files follow.
const ALWAYS: &[&str] = &[
    ".claude",
    ".agents",
    ".mcp.json",
    ".claude.json",
    ".gitmodules",
    ".husky",
];

/// File names that configure the review in any directory: instruction files,
/// and attribute and ignore files.
const IN_ANY_DIRECTORY: &[&str] = &[
    "AGENTS.md",
    "CLAUDE.md",
    "AGENTS.local.md",
    "CLAUDE.local.md",
    ".gitattributes",
    ".gitignore",
    ".rgignore",
    ".ignore",
];

/// What the protect step reads.
pub(crate) struct Protect<'a> {
    /// The runner.
    pub(crate) runner: &'a Runner,
    /// The checkout, at the pull request's head.
    pub(crate) checkout: &'a Git<'a>,
    /// The checkout's directory.
    pub(crate) dir: &'a Path,
    /// The pull request.
    pub(crate) pull: &'a Pull,
    /// The rules file, relative to the repository's root.
    pub(crate) rules: &'a str,
    /// The settings file, relative to the repository's root.
    pub(crate) config: &'a str,
    /// The action's own directory, with its default rules.
    pub(crate) action: &'a Path,
}

impl Protect<'_> {
    /// Takes the configuration from the trusted branch and saves what it took.
    pub(crate) fn run(&self) -> Result<(), Error> {
        for (name, path) in [("rules", self.rules), ("config", self.config)] {
            check_relative(name, path)?;
        }
        if self.checkout.succeeds(&[
            "config",
            "--local",
            "--get-regexp",
            r"^http\..*\.extraheader$",
        ]) {
            return Err(Error::review(
                "The checkout keeps a GitHub token in its git config (an http extraheader), where the \
                 review's agents could read it. Check the pull request out with \
                 `persist-credentials: false`.",
            ));
        }
        let source = self.source();
        for path in self.paths(&source)? {
            self.replace(&source, &path)?;
        }
        let base_copies = self.checkout.names(&["HEAD"])?;
        let rules = self.copy_rules(&source)?;
        Protected {
            config: self.settings(&source)?,
            source,
            base_copies,
            rules,
        }
        .save(self.runner)
    }

    /// The branch the configuration comes from, as a git revision.
    fn source(&self) -> String {
        let base = format!("origin/{}", self.pull.base);
        let configured = |revision: &str| {
            [self.rules, self.config].iter().any(|path| {
                self.checkout
                    .succeeds(&["cat-file", "-e", &format!("{revision}:{path}")])
            })
        };
        if configured(&base) {
            return base;
        }
        let default = format!("origin/{}", self.pull.default_branch);
        if !self.pull.default_branch.is_empty() && configured(&default) {
            self.runner.notice(&format!(
                "{base} has no review rules or settings, so the review uses {}'s.",
                self.pull.default_branch
            ));
            return default;
        }
        base
    }

    /// Every path to replace, each once: the fixed ones, then the ones either
    /// tree has in any directory, with every `.gitattributes` first, so the
    /// pull request's attributes are gone before git writes another copy.
    fn paths(&self, source: &str) -> Result<Vec<OsString>, Error> {
        let mut paths: Vec<OsString> = ALWAYS
            .iter()
            .chain([&self.rules, &self.config])
            .map(OsString::from)
            .collect();
        let mut listed: Vec<Vec<u8>> = Vec::new();
        for revision in [self.pull.head.as_str(), source] {
            let names = self
                .checkout
                .output(&["ls-tree", "-r", "-z", "--name-only", revision])?;
            listed.extend(
                names
                    .split(|byte| *byte == 0)
                    .filter(|name| configures(name))
                    .map(<[u8]>::to_vec),
            );
        }
        listed.sort();
        paths.extend(listed.into_iter().map(OsString::from_vec));
        let mut seen = HashSet::new();
        paths.retain(|path| seen.insert(path.clone()));
        paths.sort_by_key(|path| {
            path.as_bytes().rsplit(|byte| *byte == b'/').next() != Some(b".gitattributes")
        });
        Ok(paths)
    }

    /// Replaces `path` in the checkout and the index with `source`'s copy, or
    /// removes it when `source` has none. The index goes too: git reads a
    /// `.gitattributes` from it when the file is gone.
    fn replace(&self, source: &str, path: &OsStr) -> Result<(), Error> {
        let file = self.dir.join(path);
        if has_symlink_parent(self.dir, path) {
            return Err(Error::review(format!(
                "{} is under a symlink, so the review cannot replace it with {source}'s copy.",
                path.to_string_lossy()
            )));
        }
        remove(&file).map_err(|error| Error::Write {
            path: file,
            source: error,
        })?;
        let mut literal = OsString::from(":(literal)");
        literal.push(path);
        self.checkout.output(&[
            OsStr::new("rm"),
            OsStr::new("-q"),
            OsStr::new("-r"),
            OsStr::new("--cached"),
            OsStr::new("--ignore-unmatch"),
            OsStr::new("--"),
            &literal,
        ])?;
        let mut object = OsString::from(format!("{source}:"));
        object.push(path);
        if self
            .checkout
            .succeeds(&[OsStr::new("cat-file"), OsStr::new("-e"), &object])
        {
            self.checkout.output(&[
                OsStr::new("checkout"),
                OsStr::new(source),
                OsStr::new("--"),
                &literal,
            ])?;
        }
        Ok(())
    }

    /// Copies `source`'s rules to the review directory, or the action's
    /// default rules when it has none, and returns the copy's path.
    fn copy_rules(&self, source: &str) -> Result<String, Error> {
        let name = Path::new(self.rules)
            .file_name()
            .unwrap_or(OsStr::new("REVIEW.md"));
        let copy = self.runner.review_dir().join(name);
        let object = format!("{source}:{}", self.rules);
        let text = if self.checkout.succeeds(&["cat-file", "-e", &object]) {
            self.checkout.output(&["show", &object])?
        } else {
            self.runner.notice(&format!(
                "{source} has no {}, so the review follows the action's default rules.",
                self.rules
            ));
            let default = self.action.join("rules.md");
            fs::read(&default).map_err(|error| Error::Read {
                path: default,
                source: error,
            })?
        };
        fs::write(&copy, text).map_err(|error| Error::Write {
            path: copy.clone(),
            source: error,
        })?;
        Ok(copy.to_string_lossy().into_owned())
    }

    /// The review's settings on `source`; an empty object when it has none.
    fn settings(&self, source: &str) -> Result<Value, Error> {
        let object = format!("{source}:{}", self.config);
        if !self.checkout.succeeds(&["cat-file", "-e", &object]) {
            return Ok(Value::Object(Map::new()));
        }
        let text = self.checkout.output(&["show", &object])?;
        match serde_json::from_slice::<Value>(&text) {
            Ok(settings @ Value::Object(_)) => Ok(settings),
            Ok(_) => Err(Error::review(format!(
                "{} on {source} is not a JSON object.",
                self.config
            ))),
            Err(error) => Err(Error::review(format!(
                "{} on {source} is not valid JSON: {error}",
                self.config
            ))),
        }
    }
}

/// Whether the repository path `name` configures the review wherever it is:
/// an instruction, attribute, or ignore file, or a path in a nested `.claude`
/// (a `.claude` symlink is listed as itself, so it matches whole).
fn configures(name: &[u8]) -> bool {
    if name.is_empty() {
        return false;
    }
    let file = name.rsplit(|byte| *byte == b'/').next().unwrap_or(name);
    if IN_ANY_DIRECTORY
        .iter()
        .any(|known| known.as_bytes() == file)
    {
        return true;
    }
    (1..name.len()).any(|slash| {
        name[slash..]
            .strip_prefix(b"/.claude")
            .is_some_and(|after| after.is_empty() || after.starts_with(b"/"))
    })
}

/// Checks that the input `name` is a path inside the repository.
fn check_relative(name: &str, path: &str) -> Result<(), Error> {
    let inside = !path.is_empty()
        && !path.starts_with('/')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if inside {
        Ok(())
    } else {
        Err(Error::review(format!(
            "The {name} input, {path:?}, is not a path inside the repository."
        )))
    }
}

/// Whether a directory above `path` in `root` is a symlink, through which
/// removing it would reach outside the checkout.
fn has_symlink_parent(root: &Path, path: &OsStr) -> bool {
    let mut current = root.to_path_buf();
    let parts: Vec<&[u8]> = path.as_bytes().split(|byte| *byte == b'/').collect();
    parts[..parts.len().saturating_sub(1)].iter().any(|part| {
        current.push(OsStr::from_bytes(part));
        fs::symlink_metadata(&current).is_ok_and(|meta| meta.file_type().is_symlink())
    })
}

/// Removes `path` as `rm -rf` does, a symlink as itself.
fn remove(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        // A file where the path has a directory leaves nothing to remove.
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Protect,
        check_relative,
        configures, //
    };
    use crate::{
        actions::TestRunner,
        git::Git,
        state::{
            Protected,
            Pull, //
        },
        testing::Repo, //
    };
    use serde_json::json;
    use std::{
        collections::BTreeMap,
        fs,
        os::unix::fs::symlink,
        path::Path, //
    };

    /// A repository whose pull request changes the review's configuration:
    /// `origin/old` from before the review existed, `origin/main` with it,
    /// and the pull request's head on `change`.
    struct Setup {
        /// The repository.
        repo: Repo,
        /// The pull request's head.
        head: String,
        /// The action's directory.
        action: tempfile::TempDir,
    }

    fn setup() -> Setup {
        let repo = Repo::new();
        repo.commit(&[("src/a.rs", "old")]);
        repo.git(&["update-ref", "refs/remotes/origin/old", "HEAD"]);
        repo.commit(&[
            (".claude/settings.json", "base"),
            (".claude/review.json", r#"{"segments": [{"name": "bugs"}]}"#),
            ("AGENTS.md", "base"),
            (".agents/skills/x/SKILL.md", "base skill"),
            ("REVIEW.md", "base rules"),
            (".gitignore", "base-ignore"),
        ]);
        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        repo.git(&["checkout", "-q", "-b", "change"]);
        // A nested .claude can be a symlink, which git lists as one path.
        fs::create_dir_all(repo.file("lib")).expect("lib");
        symlink("../src/a.rs", repo.file("lib/.claude")).expect("a symlink");
        let head = repo.commit(&[
            (".claude/settings.json", "head"),
            (".claude/review.json", r#"{"segments": []}"#),
            (".claude/hooks/run.sh", "head"),
            ("AGENTS.md", "head"),
            ("docs/sub dir/CLAUDE.md", "head"),
            ("pkg/.claude/settings.json", "head"),
            (".mcp.json", "head"),
            (".agents/skills/x/SKILL.md", "head skill"),
            ("REVIEW.md", "head rules"),
            ("src/a.rs", "head"),
            // Files that hide a diff, or a file from rg, in any directory.
            (".gitignore", "head-ignore"),
            ("src/.gitattributes", "* -diff\n"),
            ("docs/.rgignore", "*\n"),
            // Files that configure Claude Code or git, or run on a commit.
            (".claude.json", "head"),
            (".gitmodules", "head"),
            (".husky/pre-commit", "head"),
        ]);
        let action = tempfile::tempdir().expect("the action");
        fs::write(action.path().join("rules.md"), "default rules").expect("the default rules");
        Setup { repo, head, action }
    }

    /// Runs the step from a clean checkout of the pull request, and returns
    /// the runner, the step's result, and the files in the checkout.
    fn protect(
        setup: &Setup,
        base: &str,
        default: &str,
    ) -> (
        TestRunner,
        Result<Protected, String>,
        BTreeMap<String, String>,
    ) {
        let repo = &setup.repo;
        repo.git(&["checkout", "-q", "-f", "change"]);
        repo.git(&["clean", "-q", "-f", "-d"]);
        let test = TestRunner::new();
        let pull = Pull {
            number: 5.into(),
            head: setup.head.parse().expect("a commit"),
            base: base.into(),
            default_branch: default.into(),
            last_review: None,
        };
        let checkout = Git::new(repo.path());
        let step = Protect {
            runner: &test.runner,
            checkout: &checkout,
            dir: repo.path(),
            pull: &pull,
            rules: "REVIEW.md",
            config: ".claude/review.json",
            action: setup.action.path(),
        };
        let result = step
            .run()
            .map_err(|error| error.to_string())
            .and_then(|()| Protected::load(&test.runner).map_err(|error| error.to_string()));
        (test, result, files(repo.path(), repo.path()))
    }

    /// Every file under `dir`, outside `.git`, by its path from `root`.
    fn files(root: &Path, dir: &Path) -> BTreeMap<String, String> {
        let mut found = BTreeMap::new();
        for entry in fs::read_dir(dir).expect("a directory") {
            let path = entry.expect("an entry").path();
            if path.file_name().is_some_and(|name| name == ".git") {
                continue;
            }
            let meta = fs::symlink_metadata(&path).expect("metadata");
            if meta.is_dir() {
                found.extend(files(root, &path));
            } else if meta.is_file() {
                let name = path
                    .strip_prefix(root)
                    .expect("under the root")
                    .to_string_lossy()
                    .into_owned();
                found.insert(name, fs::read_to_string(&path).expect("text"));
            }
        }
        found
    }

    #[test]
    fn replaces_the_review_configuration_with_the_trusted_branchs() {
        let setup = setup();
        let base: BTreeMap<String, String> = [
            (".claude/settings.json", "base"),
            (".claude/review.json", r#"{"segments": [{"name": "bugs"}]}"#),
            ("AGENTS.md", "base"),
            (".agents/skills/x/SKILL.md", "base skill"),
            ("REVIEW.md", "base rules"),
            (".gitignore", "base-ignore"),
            ("src/a.rs", "head"),
        ]
        .into_iter()
        .map(|(path, text)| (path.to_owned(), text.to_owned()))
        .collect();
        let replaced = [
            ".agents/skills/x/SKILL.md",
            ".claude.json",
            ".claude/hooks/run.sh",
            ".claude/review.json",
            ".claude/settings.json",
            ".gitignore",
            ".gitmodules",
            ".husky/pre-commit",
            ".mcp.json",
            "AGENTS.md",
            "REVIEW.md",
            "docs/.rgignore",
            "docs/sub dir/CLAUDE.md",
            "lib/.claude",
            "pkg/.claude/settings.json",
            "src/.gitattributes",
        ];
        for (name, branch, notice) in [
            ("the base has the configuration", "main", None),
            (
                "only the default branch has it",
                "old",
                Some("origin/old has no review rules or settings, so the review uses main's."),
            ),
        ] {
            let (test, result, tree) = protect(&setup, branch, "main");
            let protected = result.expect(name);
            assert_eq!(protected.source, "origin/main", "{name}");
            if let Some(notice) = notice {
                assert!(test.log().contains(notice), "{name}: {}", test.log());
            }
            // Paths only the pull request has are gone, and the code it changes stays.
            assert_eq!(tree, base, "{name}");
            // git reads attributes from the index when the file is gone.
            assert_eq!(
                setup.repo.git(&["check-attr", "diff", "--", "src/a.rs"]),
                "src/a.rs: diff: unspecified"
            );
            assert_eq!(protected.base_copies, replaced, "{name}");
            assert_eq!(
                protected.config,
                json!({"segments": [{"name": "bugs"}]}),
                "{name}"
            );
            assert_eq!(
                fs::read_to_string(&protected.rules).expect("the rules"),
                "base rules"
            );
        }
    }

    #[test]
    fn a_base_with_its_own_rules_wins_over_the_default_branch() {
        let setup = setup();
        let repo = &setup.repo;
        repo.git(&["checkout", "-q", "-b", "release", "origin/old"]);
        repo.commit(&[("REVIEW.md", "release rules")]);
        repo.git(&["update-ref", "refs/remotes/origin/release", "HEAD"]);
        let (test, result, _) = protect(&setup, "release", "main");
        let protected = result.expect("the step");
        assert_eq!(protected.source, "origin/release");
        assert_eq!(
            fs::read_to_string(&protected.rules).expect("the rules"),
            "release rules"
        );
        // The release branch has no settings, so the review runs on the defaults.
        assert_eq!(protected.config, json!({}));
        assert!(!test.log().contains("so the review uses"), "{}", test.log());
    }

    /// Makes `trusted`, the base, from `origin/main` with `files`, then
    /// gives the pull request a commit that replaces `dir` with what `make`
    /// leaves in its place.
    fn change_a_directory(
        setup: &mut Setup,
        files: &[(&str, &str)],
        dir: &str,
        make: impl FnOnce(&Path),
    ) {
        let repo = &setup.repo;
        repo.git(&["checkout", "-q", "-b", "trusted", "origin/main"]);
        repo.commit(files);
        repo.git(&["update-ref", "refs/remotes/origin/trusted", "HEAD"]);
        repo.git(&["checkout", "-q", "change"]);
        fs::remove_dir_all(repo.file(dir)).expect("the directory");
        make(&repo.file(dir));
        setup.head = repo.commit(&[]);
    }

    #[test]
    fn refuses_a_path_under_a_symlink() {
        let mut setup = setup();
        let outside = tempfile::tempdir().expect("a directory outside the checkout");
        fs::write(outside.path().join("AGENTS.md"), "outside").expect("the outside file");
        // Replacing docs/AGENTS.md through the link would delete and write outside the checkout.
        change_a_directory(
            &mut setup,
            &[("docs/AGENTS.md", "trusted")],
            "docs",
            |docs| {
                symlink(outside.path(), docs).expect("a symlink");
            },
        );
        let (_, result, _) = protect(&setup, "trusted", "main");
        let error = result.expect_err("a path under a symlink");
        assert!(
            error.contains("docs/AGENTS.md is under a symlink"),
            "{error}"
        );
        assert_eq!(
            files(outside.path(), outside.path()),
            BTreeMap::from([("AGENTS.md".to_owned(), "outside".to_owned())])
        );
    }

    #[test]
    fn replaces_a_file_where_the_trusted_branch_has_a_directory() {
        let mut setup = setup();
        change_a_directory(
            &mut setup,
            &[("pkg/.claude/settings.json", "trusted")],
            "pkg",
            |pkg| fs::write(pkg, "a file").expect("the file"),
        );
        let (_, result, tree) = protect(&setup, "trusted", "main");
        let protected = result.expect("the step");
        assert_eq!(
            tree.get("pkg/.claude/settings.json").map(String::as_str),
            Some("trusted")
        );
        assert!(
            protected
                .base_copies
                .contains(&"pkg/.claude/settings.json".to_owned()),
            "{:?}",
            protected.base_copies
        );
    }

    #[test]
    fn writes_the_trusted_copies_without_the_pull_requests_attributes() {
        let mut setup = setup();
        let repo = &setup.repo;
        repo.git(&["checkout", "-q", "-b", "trusted", "origin/main"]);
        repo.commit(&[(".claude/settings.json", "{\n}\n")]);
        repo.git(&["update-ref", "refs/remotes/origin/trusted", "HEAD"]);
        repo.git(&["checkout", "-q", "change"]);
        // Were it still there, git would write the trusted copy with CRLF.
        setup.head = repo.commit(&[(".gitattributes", ".claude/** text eol=crlf\n")]);
        let (_, result, tree) = protect(&setup, "trusted", "main");
        result.expect("the step");
        assert_eq!(
            tree.get(".claude/settings.json").map(String::as_str),
            Some("{\n}\n")
        );
        assert!(!tree.contains_key(".gitattributes"), "{tree:?}");
    }

    #[test]
    fn without_configuration_on_any_branch_takes_the_base_and_the_default_rules() {
        let setup = setup();
        let (test, result, tree) = protect(&setup, "old", "old");
        let protected = result.expect("the step");
        assert_eq!(protected.source, "origin/old");
        // The pull request's own configuration is gone: the base has none.
        assert_eq!(tree.keys().collect::<Vec<_>>(), ["src/a.rs"]);
        assert_eq!(protected.config, json!({}));
        assert_eq!(
            fs::read_to_string(&protected.rules).expect("the rules"),
            "default rules"
        );
        assert!(test.log().contains(
            "origin/old has no REVIEW.md, so the review follows the action's default rules."
        ));
    }

    #[test]
    fn matches_configuration_in_any_directory() {
        for (name, configures_it) in [
            ("docs/AGENTS.md", true),
            ("CLAUDE.local.md", true),
            ("pkg/.claude", true),
            ("pkg/.claude/settings.json", true),
            ("a/b/.ignore", true),
            (".claude/x", false),
            ("pkg/.claudex/y", false),
            ("docs/AGENTS.mdx", false),
            ("src/a.rs", false),
        ] {
            assert_eq!(configures(name.as_bytes()), configures_it, "{name}");
        }
    }

    #[test]
    fn refuses_a_checkout_that_keeps_a_token_in_its_git_config() {
        let setup = setup();
        setup.repo.git(&[
            "config",
            "--local",
            "http.https://github.com/.extraheader",
            "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dA==",
        ]);
        let (_, result, tree) = protect(&setup, "main", "main");
        let error = result.expect_err("a refusal");
        assert!(error.contains("persist-credentials: false"), "{error}");
        // Nothing was replaced.
        assert_eq!(tree.get("AGENTS.md").map(String::as_str), Some("head"));
    }

    #[test]
    fn the_rules_and_settings_inputs_stay_inside_the_repository() {
        for path in ["../x", "/etc/x", "a//b", "./x", "a/..", ""] {
            let error = check_relative("rules", path).expect_err(path).to_string();
            assert!(
                error.contains("is not a path inside the repository"),
                "{path}: {error}"
            );
        }
        for path in ["REVIEW.md", "docs/review/rules.md", ".claude/review.json"] {
            assert!(check_relative("config", path).is_ok(), "{path}");
        }
    }
}
