//! The git the review's agents run: the program installed as `git`, over a
//! stand-in real git that prints its arguments, in a checkout whose tree holds
//! symlinks out of it.

use std::{
    fs,
    io,
    os::unix::fs::{
        PermissionsExt,
        symlink, //
    },
    path::{
        Path,
        PathBuf, //
    },
    process::{
        Command,
        Output,
        Stdio, //
    },
    thread,
    time::Duration, //
};

/// A checkout with the guard installed beside it.
struct Setup {
    /// The directory that holds everything.
    _root: tempfile::TempDir,
    /// The checkout the guard runs in.
    checkout: PathBuf,
    /// The guard, `bin/git`.
    guard: PathBuf,
}

/// The guard installed as the run step installs it: a copy of the program
/// named `git` in `bin`, beside `real-git`, which here prints its arguments.
/// The checkout's tree holds symlinks: `up` and `sub/out` lead out of it, and
/// `here` leads to `sub` inside it.
fn setup() -> Setup {
    let root = tempfile::tempdir().expect("a directory");
    let base = fs::canonicalize(root.path()).expect("the directory");
    let checkout = base.join("checkout");
    fs::create_dir_all(checkout.join("sub")).expect("sub");
    fs::create_dir(checkout.join("web")).expect("web");
    symlink(&base, checkout.join("up")).expect("up");
    symlink(&base, checkout.join("sub/out")).expect("out");
    symlink("sub", checkout.join("here")).expect("here");
    let real = base.join("real-git");
    fs::write(&real, "#!/bin/bash\nprintf 'ran'\nprintf ' %s' \"$@\"\n").expect("the real git");
    fs::set_permissions(&real, fs::Permissions::from_mode(0o755)).expect("it runs");
    let guard = install(&base);
    Setup {
        _root: root,
        checkout,
        guard,
    }
}

/// Installs the guard in `root/bin`, and returns it.
fn install(root: &Path) -> PathBuf {
    let bin = root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let guard = bin.join("git");
    fs::copy(env!("CARGO_BIN_EXE_claude-review"), &guard).expect("the guard");
    guard
}

impl Setup {
    /// Runs the guard with `arguments` in the checkout.
    fn git(&self, arguments: &[&str]) -> Output {
        output(
            Command::new(&self.guard)
                .args(arguments)
                .current_dir(&self.checkout),
        )
    }
}

/// Runs `command`; see [`started`].
fn output(command: &mut Command) -> Output {
    started(command, Command::output)
}

/// What `start` returns for `command`. A program just copied can be busy for
/// a moment while another test's child, forked before the copy closed, has yet
/// to exec.
fn started<T>(command: &mut Command, start: fn(&mut Command) -> io::Result<T>) -> T {
    for _ in 0..50 {
        match start(command) {
            Err(error) if error.kind() == io::ErrorKind::ExecutableFileBusy => {
                thread::sleep(Duration::from_millis(20))
            }
            result => return result.expect("the guard starts"),
        }
    }
    panic!("the guard stayed busy");
}

/// Text of `bytes`.
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn refuses_options_and_paths_that_reach_a_file() {
    let setup = setup();
    let real = setup.checkout.parent().expect("the root").join("real-git");
    let real = real.to_str().expect("a UTF-8 path");
    let commit = "1".repeat(40);
    let cases: &[&[&str]] = &[
        &["log", "-1", "--output=f"],
        &["log", "-1", "--output", "f"],
        &["show", "--outp=f", "HEAD"],
        &["diff", "--no-index", "/etc/hostname", "README.md"],
        // git takes no abbreviation of --no-index (--no-inde could be
        // --no-indent-heuristic), and a path outside is refused anyway.
        &["diff", "--no-inde", "/etc/hostname", "README.md"],
        &["blame", "--contents", "/etc/hostname", "README.md"],
        &["blame", "--cont=/etc/hostname", "README.md"],
        &["blame", "--ignore-revs-file", "/etc/hostname", "README.md"],
        &["blame", "--ignore-revs=/etc/hostname", "README.md"],
        &["blame", "-S", "/etc/hostname", "README.md"],
        &["blame", "-S/etc/hostname", "README.md"],
        &["blame", "-wS/etc/hostname", "README.md"],
        // grep's pager command and pattern file.
        &["grep", "-Ocat", "needle"],
        &["grep", "-O", "needle"],
        &["grep", "-nOcat", "needle"],
        &["grep", "--open-files-in-pager=cat", "needle"],
        &["grep", "--op", "needle"],
        &["grep", "-f", "/etc/hostname"],
        &["grep", "-nf/etc/hostname"],
        &["grep", "--file", "/etc/hostname"],
        &["grep", "--file=/etc/hostname"],
        // Paths that make diff compare files itself, without --no-index.
        &["diff", "/etc/hostname", "README.md"],
        &["diff", "--stat", "README.md", "../../x"],
        &["diff", "..", "README.md"],
        &["diff", "HEAD", "--", "src/../../x"],
        &["diff", "--end-of-options", "README.md", "-x/../../real-git"],
        &["diff", real, "README.md"],
        // A directory or repository outside the checkout.
        &["-C", "/etc", "diff", "hostname", "passwd"],
        &["-C", "..", "log"],
        &["--work-tree", "/etc", "diff"],
        &["--work-tree=/etc", "diff"],
        // The same through a symlink in the tree. A path given before a -C is
        // read from the directory the last -C leads to.
        &["-C", "up", "diff", "real-git", "checkout/up"],
        &["-C", "here", "-C", "out", "log"],
        &["--work-tree", "up", "diff"],
        &["--work-tree=out", "-C", "sub", "diff"],
        &["diff", "up/real-git", "README.md"],
        &["diff", "HEAD", "--", "-x/../../real-git"],
        // /proc/self/cwd is where the last -C left git, so this is sub/out.
        &[
            "-C",
            "sub",
            "-C",
            "/proc/self/cwd/out",
            "diff",
            "real-git",
            "checkout/up",
        ],
        // A shallow file, which git opens from the top of the work tree.
        &["--shallow-file", "shallow", "log"],
        &["--shallow-file=shallow", "log"],
        // A repository other than the checkout's, whose config could run a
        // command, and a directory git runs programs from first.
        &["--git-dir", ".git", "log"],
        &["--git-dir=.git", "log"],
        &["--bare", "log"],
        &["--exec-path=sub", "log", "--show-signature"],
        &["-c", "safe.bareRepository=all", "log"],
        // Config that runs a command or reads a file, in either form.
        &["-c", "diff.external=cat", "diff"],
        &["-c", "Core.FSMonitor=./x", "log"],
        &["-c", "alias.x=!cat /etc/hostname", "x"],
        &["-c", "diff.a.b.textconv=cat", "log", "-p"],
        &["-c", "includeIf.gitdir:/.path=/etc/x", "log"],
        &["--config-env", "core.pager=PAGER", "log"],
        &["--config-env=diff.external=X", "diff"],
        &["--config-env=diff.a=b.textconv=SHELL", "log", "-p"],
        &["--config-env", "diff.a=b.textconv=SHELL", "log", "-p"],
        &["-c", "diff.external=env A=B cat", "diff"],
        // A remote, which a read command fetches a missing object from when it
        // is a promisor, and what its URL or protocol turns into.
        &[
            "-c",
            "remote.x.promisor=true",
            "-c",
            "remote.x.url=.",
            "show",
            &commit,
        ],
        &["-c", "remote.x.uploadpack=touch x;:", "show", &commit],
        &["-c", "url.ext::x.insteadOf=y", "log"],
        &["-c", "Protocol.ext.allow=always", "log"],
        // A misspelled command git corrects to one this checks.
        &[
            "-c",
            "help.autocorrect=immediate",
            "blam",
            "--contents",
            "/etc/hostname",
            "README.md",
        ],
        // Options before the subcommand, and each one that takes a separate
        // value, so that value is not taken for the subcommand.
        &[
            "--no-pager",
            "blame",
            "--contents",
            "/etc/hostname",
            "README.md",
        ],
        &[
            "-c",
            "k=v",
            "blame",
            "--contents",
            "/etc/hostname",
            "README.md",
        ],
        &["-C", ".", "blame", "-S", "/etc/hostname", "README.md"],
        &[
            "--work-tree",
            ".",
            "blame",
            "--contents",
            "/etc/hostname",
            "README.md",
        ],
        &[
            "--namespace",
            "n",
            "blame",
            "--contents",
            "/etc/hostname",
            "README.md",
        ],
        &[
            "--config-env",
            "k=V",
            "blame",
            "--contents",
            "/etc/hostname",
            "README.md",
        ],
        &[
            "--attr-source",
            "HEAD",
            "blame",
            "--contents",
            "/etc/hostname",
            "README.md",
        ],
    ];
    for arguments in cases {
        let output = setup.git(arguments);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{arguments:?}: {}",
            text(&output.stdout)
        );
        assert_eq!(text(&output.stdout), "", "{arguments:?}");
        assert!(
            text(&output.stderr).contains("is refused in the review"),
            "{arguments:?}: {}",
            text(&output.stderr)
        );
    }
}

#[test]
fn refuses_a_path_through_a_symlink_that_leads_into_itself() {
    let setup = setup();
    symlink("a/b", setup.checkout.join("a")).expect("a");
    for arguments in [&["-C", "a", "log"][..], &["diff", "a/x", "README.md"]] {
        let mut child = started(
            Command::new(&setup.guard)
                .args(arguments)
                .current_dir(&setup.checkout)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
            Command::spawn,
        );
        let mut waited = 0;
        while child.try_wait().expect("the guard").is_none() {
            if waited == 500 {
                child.kill().expect("the guard stops");
                panic!("{arguments:?}: the guard did not finish");
            }
            thread::sleep(Duration::from_millis(20));
            waited += 1;
        }
        let output = child.wait_with_output().expect("the guard");
        assert_eq!(output.status.code(), Some(2), "{arguments:?}");
        assert_eq!(text(&output.stdout), "", "{arguments:?}");
        assert!(
            text(&output.stderr).contains("is refused in the review"),
            "{arguments:?}: {}",
            text(&output.stderr)
        );
    }
}

#[test]
fn passes_read_commands_through_unchanged() {
    let setup = setup();
    let readme = setup.checkout.join("README.md");
    let readme = readme.to_str().expect("a UTF-8 path");
    let checkout = setup.checkout.to_str().expect("a UTF-8 path");
    let cases: &[&[&str]] = &[
        &["log", "-1", "--oneline"],
        &["log", "-S", "needle", "--", "src"],
        &["log", "-Sneedle"],
        &["show", "HEAD:README.md"],
        &["diff", "HEAD~1", "HEAD", "--", "README.md"],
        &["diff", "HEAD~1..HEAD", "--", "README.md"],
        &["diff", "origin/main...HEAD", "--stat"],
        &["diff", "--src-prefix=a/", "--dst-prefix=b/", "HEAD~1"],
        &["diff", readme, "web/README.md"],
        &["-C", checkout, "diff", "--numstat"],
        &["-C", "here", "diff", "--numstat"],
        &["-C", "web", "--work-tree=.", "diff"],
        &["diff", "HEAD", "--", "-x"],
        &["diff", "-S/api/", "HEAD~1"],
        &["log", "-S", "/api/", "--", "src"],
        &["blame", "--ignore-rev", "HEAD~1", "README.md"],
        &["blame", "-L", "1,3", "-w", "README.md"],
        &["blame", "-L/Server/,+2", "README.md"],
        &["-c", "blame", "log", "-S", "needle"],
        // Config that turns a command off, as Claude Code's own git calls set it.
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=",
            "-c",
            "credential.helper=",
            "-c",
            "core.quotepath=false",
            "-c",
            "safe.bareRepository=explicit",
            "log",
            "-1",
        ],
        &["-c", "core.fsmonitor=false", "diff"],
        &["grep", "-n", "-A", "40", "needle", "--", "src"],
        &["grep", "--files-with-matches", "-e", "needle"],
        &["grep", "-n", "-i", "-w", "needle", "HEAD~1"],
    ];
    for arguments in cases {
        let output = setup.git(arguments);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{arguments:?}: {}",
            text(&output.stderr)
        );
        assert_eq!(
            text(&output.stdout),
            format!(
                "ran -c safe.bareRepository=explicit {}",
                arguments.join(" ")
            ),
            "{arguments:?}"
        );
    }
}

#[test]
fn refusing_text_to_search_for_says_how_to_write_it() {
    let setup = setup();
    // The spellings the note gives pass: a pattern whose - is [-], and text
    // attached to -S.
    for (refused, written) in [
        (["grep", "-e", "--no-index"], ["grep", "-e", "[-]-no-index"]),
        (["grep", "-e", "-foo"], ["grep", "-e", "[-]foo"]),
        (["log", "-S", "--output"], ["log", "-S--output", ""]),
    ] {
        let output = setup.git(&refused);
        assert_eq!(output.status.code(), Some(2), "{refused:?}");
        assert!(
            text(&output.stderr)
                .contains("To search for text that starts with -, write that - as [-]"),
            "{refused:?}: {}",
            text(&output.stderr)
        );
        let written: Vec<&str> = written
            .into_iter()
            .filter(|argument| !argument.is_empty())
            .collect();
        assert_eq!(setup.git(&written).status.code(), Some(0), "{written:?}");
    }
}

#[test]
fn takes_no_bare_repository_from_the_tree() {
    // The files of a bare repository, which the pull request can add, with
    // git itself under the guard.
    let root = tempfile::tempdir().expect("a directory");
    let base = fs::canonicalize(root.path()).expect("the directory");
    let bare = base.join("checkout/bare");
    fs::create_dir_all(bare.join("objects")).expect("objects");
    fs::create_dir(bare.join("refs")).expect("refs");
    fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").expect("HEAD");
    fs::write(bare.join("config"), "[core]\n\tbare = true\n").expect("config");
    let git = Command::new("bash")
        .args(["-c", "command -v git"])
        .output()
        .expect("git");
    symlink(text(&git.stdout).trim(), base.join("real-git")).expect("the real git");
    let guard = install(&base);
    let output = output(
        Command::new(guard)
            .args(["-C", "bare", "rev-parse", "--git-dir"])
            .current_dir(base.join("checkout"))
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1"),
    );
    assert_ne!(output.status.code(), Some(0), "{}", text(&output.stdout));
    assert!(
        text(&output.stderr).contains("safe.bareRepository"),
        "{}",
        text(&output.stderr)
    );
}

#[test]
fn a_subcommand_it_does_not_have_is_a_usage_error() {
    let output = Command::new(env!("CARGO_BIN_EXE_claude-review"))
        .arg("review")
        .output()
        .expect("the program runs");
    assert_eq!(output.status.code(), Some(2));
    assert!(text(&output.stderr).starts_with("usage: claude-review start|"));
}
