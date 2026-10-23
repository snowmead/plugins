//! The git that the review's agents run.
//!
//! The run step copies this program into the trusted directory as `bin/git`,
//! first on the agents' `PATH`, beside `real-git`, a link to the system's git.
//! A copy named `git` runs [`run`] instead of a step.
//!
//! Some of git's read commands read or write a file outside the checkout:
//! `--output`; diff's `--no-index`, and the same mode git picks by itself when
//! one of two paths given to diff is outside the checkout or no repository is
//! found; blame's `--contents`, `--ignore-revs-file`, and `-S`; and grep's `-f`
//! and `--file`, which read patterns from a file, and `-O`, which runs a pager
//! command. No permission rule can refuse those in every spelling, so this
//! refuses them, abbreviations and bundled short options included; a grep
//! pattern that starts with `-` and holds `O` or `f` is refused with them, and
//! so is a search for text that starts with `--output` or `--no-index`, with a
//! note on how to write one. It also refuses a `-C` or `--work-tree` outside
//! the checkout, and any argument of diff outside it, so a diff option takes
//! such a value attached (`-S/api`, not `-S /api`). A path is judged once its
//! symlinks are followed, from the directory git will be in, since the pull
//! request can add a symlink that points outside or to `/proc/self/cwd`.
//!
//! `--shallow-file` is refused wherever it points, as git opens it from the top
//! of the work tree, not from where the `-C` options lead. Diff's `-O` order
//! file is read but none of it is printed, so it stays allowed. A `-c` or
//! `--config-env` that sets a command or a file to read is refused too, unless
//! it turns that off with an empty value, `false`, or `/dev/null`, as Claude
//! Code's own git calls do (`-c core.hooksPath=/dev/null`). So is one that sets
//! a remote, a URL rewrite, or a protocol: with a promisor remote, a read
//! command fetches an object it lacks, and the fetch runs the remote's
//! upload-pack command. So is `help.autocorrect`, with which git runs blame,
//! grep, or diff for a misspelled name that this does not check.
//!
//! A repository's own config can run a command too (`diff.external`,
//! `core.fsmonitor`), and the pull request can add the files of a bare
//! repository with such a config. So git takes no bare repository it finds by
//! itself (`safe.bareRepository=explicit`), and `--git-dir` and `--bare`, which
//! name one, are refused, as is `--exec-path=`, which puts a directory first
//! on the `PATH` that git runs programs from.
//!
//! [`run`]: crate::guard::run

use std::{
    collections::HashSet,
    env,
    ffi::{
        OsStr,
        OsString, //
    },
    fs,
    io::{
        self,
        Write, //
    },
    os::unix::{
        ffi::{
            OsStrExt,
            OsStringExt, //
        },
        fs::MetadataExt,
        process::CommandExt, //
    },
    path::PathBuf,
    process::{
        Command,
        ExitCode, //
    }, //
};

/// The exit status of a refused command.
const REFUSED: u8 = 2;

/// The exit status when the real git cannot be started, as a shell gives it.
const NOT_STARTED: u8 = 127;

/// The most symlinks one path may follow, as Linux and `realpath` allow.
const MAX_SYMLINKS: usize = 40;

/// The note added when a refused argument can be text to search for.
const TEXT_NOTE: &str = " To search for text that starts with -, write that - as [-] in a pattern \
    (git grep -e '[-]-output') or attach the text to its option (git log -S--output).";

/// Config keys, lowercased, that make git run a command or read a file, or
/// reach a remote. `*` matches any characters, dots included.
const RUNS_OR_READS: &[&str] = &[
    "alias.*",
    "pager.*",
    "filter.*",
    "difftool.*",
    "mergetool.*",
    "browser.*",
    "man.*",
    "include.path",
    "includeif.*.path",
    "core.fsmonitor",
    "core.pager",
    "core.editor",
    "core.sshcommand",
    "core.askpass",
    "core.hookspath",
    "core.gitproxy",
    "core.attributesfile",
    "core.excludesfile",
    "core.worktree",
    "core.alternaterefscommand",
    "credential.helper",
    "credential.*.helper",
    "diff.external",
    "diff.orderfile",
    "diff.*.textconv",
    "diff.*.command",
    "merge.*.driver",
    "gpg.program",
    "gpg.*.program",
    "sequence.editor",
    "interactive.difffilter",
    "mailmap.file",
    "blame.ignorerevsfile",
    "uploadpack.packobjectshook",
    "web.browser",
    "commit.template",
    "init.templatedir",
    "remote.*",
    "url.*",
    "protocol.*",
    "help.autocorrect",
];

/// Values that turn a command or file setting off, as Claude Code's own git
/// calls set them.
const OFF: &[&[u8]] = &[b"", b"false", b"/dev/null"];

/// What the argument after an option before the subcommand is.
#[derive(Clone, Copy)]
enum Value {
    /// The directory `-C` moves git to.
    Directory,
    /// The work tree `--work-tree` names, judged at the end.
    WorkTree,
    /// The `key[=value]` of `-c`.
    Config,
    /// The `key=VARIABLE` of `--config-env`.
    ConfigEnv,
    /// A value nothing here checks (`--namespace`, `--attr-source`).
    Unchecked,
}

/// A refused argument and whether the refusal adds [`TEXT_NOTE`].
///
/// [`TEXT_NOTE`]: crate::guard::TEXT_NOTE
struct Refusal {
    /// The argument as given.
    argument: Vec<u8>,
    /// Whether the argument can be text to search for.
    text: bool,
}

/// The checkout the agents run in and the directory git will be in after the
/// `-C` options read so far.
struct Guard {
    /// The checkout, as `pwd -P` gives it.
    root: Vec<u8>,
    /// Where git will be after the `-C` options read so far.
    current: Vec<u8>,
}

/// Whether this program runs as the guard: a copy named `git`.
pub(crate) fn installed() -> bool {
    env::current_exe().is_ok_and(|exe| exe.file_name() == Some(OsStr::new("git")))
}

/// Checks git's `arguments` and runs the real git with them, or refuses them
/// with status 2 and a message on standard error.
pub(crate) fn run(arguments: Vec<OsString>) -> ExitCode {
    let arguments: Vec<Vec<u8>> = arguments.into_iter().map(OsString::into_vec).collect();
    let Ok(root) = env::current_dir() else {
        return fail(b"git: the review cannot read its working directory");
    };
    let root = root.into_os_string().into_vec();
    let mut guard = Guard {
        current: root.clone(),
        root,
    };
    let checked = guard.check(&arguments);
    // Judging a path moves into the directory git will be in, so git starts
    // from the checkout again.
    if env::set_current_dir(OsStr::from_bytes(&guard.root)).is_err() {
        return fail(b"git: the review cannot return to its working directory");
    }
    if let Err(refusal) = checked {
        let mut message = b"git: ".to_vec();
        message.extend_from_slice(&refusal.argument);
        message.extend_from_slice(b" is refused in the review, which only reads the repository");
        if refusal.text {
            message.push(b'.');
            message.extend_from_slice(TEXT_NOTE.as_bytes());
        }
        return fail(&message);
    }
    let Some(real) = real_git() else {
        return fail(b"git: the review's real git is missing");
    };
    let error = Command::new(&real)
        .arg("-c")
        .arg("safe.bareRepository=explicit")
        .args(arguments.into_iter().map(OsString::from_vec))
        .exec();
    let _ = writeln!(
        io::stderr(),
        "git: could not run {}: {error}",
        real.display()
    );
    ExitCode::from(NOT_STARTED)
}

impl Guard {
    /// Checks every argument in order. Each `-C` is judged when it is read, as
    /// git moves there in turn; the other paths are judged at the end, against
    /// the directory the last `-C` leaves git in.
    fn check(&mut self, arguments: &[Vec<u8>]) -> Result<(), Refusal> {
        let mut paths: Vec<&[u8]> = Vec::new();
        let mut subcommand: Option<&[u8]> = None;
        let mut value: Option<Value> = None;
        let mut dashes = false;
        for argument in arguments {
            let arg = argument.as_slice();
            if arg.starts_with(b"--ou") || arg == b"--no-index" {
                return Err(refuse_text(arg));
            }
            let Some(sub) = subcommand else {
                // Options before the subcommand; the ones listed take the next
                // argument as a value: -C names a directory, --work-tree a
                // path, and the next two set config.
                if let Some(kind) = value.take() {
                    match kind {
                        Value::Directory => {
                            self.current = self.inside(arg).ok_or_else(|| refuse(arg))?;
                        }
                        Value::WorkTree => paths.push(arg),
                        Value::Config if config(arg) => return Err(refuse(arg)),
                        Value::ConfigEnv if config_env(arg) => return Err(refuse(arg)),
                        Value::Config | Value::ConfigEnv | Value::Unchecked => {}
                    }
                    continue;
                }
                if arg == b"--git-dir"
                    || arg.starts_with(b"--git-dir=")
                    || arg == b"--bare"
                    || arg.starts_with(b"--exec-path=")
                    || arg == b"--shallow-file"
                    || arg.starts_with(b"--shallow-file=")
                {
                    return Err(refuse(arg));
                }
                match arg {
                    b"-C" => value = Some(Value::Directory),
                    b"--work-tree" => value = Some(Value::WorkTree),
                    b"-c" => value = Some(Value::Config),
                    b"--config-env" => value = Some(Value::ConfigEnv),
                    b"--namespace" | b"--attr-source" => value = Some(Value::Unchecked),
                    _ => {
                        if let Some(tree) = arg.strip_prefix(b"--work-tree=") {
                            paths.push(tree);
                        } else if let Some(setting) = arg.strip_prefix(b"--config-env=") {
                            if config_env(setting) {
                                return Err(refuse(arg));
                            }
                        } else if !arg.starts_with(b"-") {
                            subcommand = Some(arg);
                        }
                    }
                }
                continue;
            };
            match sub {
                b"diff" => {
                    // After -- or --end-of-options, every argument is a path,
                    // a leading - included.
                    if dashes {
                        paths.push(arg);
                    } else if arg == b"--" || arg == b"--end-of-options" {
                        dashes = true;
                    } else if !arg.starts_with(b"-") {
                        paths.push(arg);
                    }
                }
                b"blame" => {
                    if arg.starts_with(b"--con") || arg.starts_with(b"--ignore-revs") {
                        return Err(refuse(arg));
                    }
                    if arg.starts_with(b"-L") {
                        continue;
                    }
                    // -S, and a bundle of short options that holds S.
                    let bundled = arg.len() > 2
                        && arg[0] == b'-'
                        && arg[1] != b'-'
                        && arg[2..].contains(&b'S');
                    if arg.starts_with(b"-S") || bundled {
                        return Err(refuse(arg));
                    }
                }
                b"grep" => {
                    if arg.starts_with(b"--op") || arg == b"--file" || arg.starts_with(b"--file=") {
                        return Err(refuse(arg));
                    }
                    let short = arg.starts_with(b"-") && !arg.starts_with(b"--");
                    if short && arg[1..].iter().any(|byte| matches!(byte, b'O' | b'f')) {
                        return Err(refuse_text(arg));
                    }
                }
                _ => {}
            }
        }
        for path in paths {
            if self.inside(path).is_none() {
                return Err(refuse(path));
            }
        }
        Ok(())
    }

    /// Where `path` leads, when that is the checkout or inside it; `None` when
    /// it leaves the checkout or cannot be resolved. A path that names `..`
    /// leaves it.
    fn inside(&self, path: &[u8]) -> Option<Vec<u8>> {
        if path == b".."
            || path.starts_with(b"../")
            || path.ends_with(b"/..")
            || path.windows(4).any(|window| window == b"/../")
        {
            return None;
        }
        let resolved = self.resolve(path)?;
        let within = resolved.strip_prefix(self.root.as_slice());
        within
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(b"/"))
            .then_some(resolved)
    }

    /// Where `path` leads once its symlinks are followed, from the directory
    /// git will be in. This moves there, so `/proc/self/cwd` leads where it
    /// does for git. The longest part that exists is resolved as `readlink -f`
    /// does, and the rest is appended.
    fn resolve(&self, path: &[u8]) -> Option<Vec<u8>> {
        env::set_current_dir(OsStr::from_bytes(&self.current)).ok()?;
        let mut path = if path.starts_with(b"/") {
            path.to_vec()
        } else {
            let mut joined = self.current.clone();
            joined.push(b'/');
            joined.extend_from_slice(path);
            joined
        };
        let mut rest = Vec::new();
        while !(exists(&path) || is_symlink(&path)) {
            let slash = path.iter().rposition(|byte| *byte == b'/')?;
            let mut tail = path.split_off(slash);
            tail.extend_from_slice(&rest);
            rest = tail;
            if path.is_empty() {
                path.push(b'/');
            }
        }
        let mut real = canonicalize(&path)?;
        real.extend_from_slice(&rest);
        Some(real)
    }
}

/// Whether config `key` set to `value` has git run a command or read a file,
/// or take a bare repository it finds. Keys are case-insensitive.
fn runs_or_reads(key: &[u8], value: &[u8]) -> bool {
    let key = key.to_ascii_lowercase();
    if key == b"safe.barerepository" {
        return value != b"explicit";
    }
    RUNS_OR_READS
        .iter()
        .any(|pattern| glob(pattern.as_bytes(), &key))
        && !OFF.contains(&value)
}

/// Whether `-c` with `setting` is refused. git splits it at the first `=`,
/// and a key alone is true.
fn config(setting: &[u8]) -> bool {
    match setting.iter().position(|byte| *byte == b'=') {
        Some(equals) => runs_or_reads(&setting[..equals], &setting[equals + 1..]),
        None => runs_or_reads(setting, b"true"),
    }
}

/// Whether `--config-env` with `setting` is refused. git splits it at the last
/// `=`, and the value is that variable's, so only the key decides.
fn config_env(setting: &[u8]) -> bool {
    let (key, variable) = match setting.iter().rposition(|byte| *byte == b'=') {
        Some(equals) => (&setting[..equals], &setting[equals + 1..]),
        None => (setting, setting),
    };
    let mut value = b"$".to_vec();
    value.extend_from_slice(variable);
    runs_or_reads(key, &value)
}

/// Whether `text` matches `pattern`, where `*` matches any bytes.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|byte| *byte == b'*')
}

/// The refusal of `argument`.
fn refuse(argument: &[u8]) -> Refusal {
    Refusal {
        argument: argument.to_vec(),
        text: false,
    }
}

/// The refusal of `argument`, which can be text to search for.
fn refuse_text(argument: &[u8]) -> Refusal {
    Refusal {
        argument: argument.to_vec(),
        text: true,
    }
}

/// Writes `message` to standard error and returns the refused status.
fn fail(message: &[u8]) -> ExitCode {
    let mut stderr = io::stderr();
    let _ = stderr.write_all(message);
    let _ = stderr.write_all(b"\n");
    ExitCode::from(REFUSED)
}

/// The real git: `real-git` in the directory above this program's own, a
/// link the run step makes to the system's git, followed to that git so git
/// sees the path it was installed at.
fn real_git() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    fs::canonicalize(exe.parent()?.parent()?.join("real-git")).ok()
}

/// Whether `path` exists, following symlinks, as `test -e` checks.
fn exists(path: &[u8]) -> bool {
    fs::metadata(OsStr::from_bytes(path)).is_ok()
}

/// Whether `path` is a symlink, as `test -L` checks.
fn is_symlink(path: &[u8]) -> bool {
    fs::symlink_metadata(OsStr::from_bytes(path)).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// The absolute `path` with every symlink followed, as GNU `readlink -f`
/// gives it: every part but the last must exist, and a symlink seen twice
/// with the same name left to resolve is a loop. So is following more than
/// [`MAX_SYMLINKS`], which also ends a link that leads into itself, such as
/// `a -> a/b`, whose name left to resolve grows each time.
///
/// [`MAX_SYMLINKS`]: crate::guard::MAX_SYMLINKS
fn canonicalize(path: &[u8]) -> Option<Vec<u8>> {
    let mut resolved = b"/".to_vec();
    let mut name = path.to_vec();
    let mut start = 0;
    let mut seen: HashSet<(u64, u64, Vec<u8>)> = HashSet::new();
    let mut followed = 0;
    loop {
        while start < name.len() && name[start] == b'/' {
            start += 1;
        }
        if start == name.len() {
            return Some(resolved);
        }
        let end = name[start..]
            .iter()
            .position(|byte| *byte == b'/')
            .map_or(name.len(), |offset| start + offset);
        let component = &name[start..end];
        let last = name[end..].iter().all(|byte| *byte == b'/');
        if component == b"." {
            start = end;
            continue;
        }
        if component == b".." {
            pop(&mut resolved);
            start = end;
            continue;
        }
        if !resolved.ends_with(b"/") {
            resolved.push(b'/');
        }
        resolved.extend_from_slice(component);
        let meta = match fs::symlink_metadata(OsStr::from_bytes(&resolved)) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound && last => {
                start = end;
                continue;
            }
            Err(_) => return None,
        };
        if meta.file_type().is_symlink() {
            followed += 1;
            if followed > MAX_SYMLINKS || !seen.insert((meta.dev(), meta.ino(), name.clone())) {
                return None;
            }
            let target = fs::read_link(OsStr::from_bytes(&resolved)).ok()?;
            let mut expanded = target.into_os_string().into_vec();
            if expanded.starts_with(b"/") {
                resolved = b"/".to_vec();
            } else {
                pop(&mut resolved);
            }
            expanded.extend_from_slice(&name[end..]);
            name = expanded;
            start = 0;
            continue;
        }
        if !meta.is_dir() && end < name.len() {
            return None;
        }
        start = end;
    }
}

/// Removes the last component of the absolute `path`, keeping the root.
fn pop(path: &mut Vec<u8>) {
    let slash = path.iter().rposition(|byte| *byte == b'/').unwrap_or(0);
    path.truncate(slash.max(1));
}
