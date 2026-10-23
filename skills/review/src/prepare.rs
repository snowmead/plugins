//! The prepare step: what the review reads besides the checkout, and the
//! workflow's args.
//!
//! It writes the pull request, its conversation, and its review threads to the
//! review directory, where the agents read them, and to the trusted directory
//! the threads the post step may reply in and the args. The args name the
//! commits and the files the pull request changes, which decide the segments
//! that run, and the threads that already have this reviewer's "Fixed" reply;
//! after a complete review of an earlier commit they add what changed since
//! then and the findings that review's summary alone holds. The agents read
//! the description without the job's own section, and the conversation
//! without the job's own review bodies.

use crate::{
    actions::Runner,
    error::Error,
    git::Git,
    github::{
        self,
        GitHub,
        login, //
    },
    id::{
        Commit,
        PullNumber,
        Repository,
        ThreadId, //
    },
    marker,
    section,
    settings,
    state::{
        Own,
        Protected,
        Pull,
        read_json,
        write_json, //
    }, //
};
use serde_json::{
    Map,
    Value,
    json, //
};
use std::{
    collections::BTreeSet,
    path::PathBuf, //
};

/// The query for one page of the pull request's review threads.
const THREADS: &str = "query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes { author { __typename login } body url state }
          }
        }
      }
    }
  }
}";

/// What the prepare step reads.
pub(crate) struct Prepare<'a> {
    /// The runner.
    pub(crate) runner: &'a Runner,
    /// GitHub, with the job's token.
    pub(crate) github: &'a dyn GitHub,
    /// The repository.
    pub(crate) repo: &'a Repository,
    /// The login the review posts as, without `[bot]`.
    pub(crate) reviewer: &'a str,
    /// The checkout.
    pub(crate) checkout: &'a Git<'a>,
    /// The run's model overrides (the `agents` input); empty for none.
    pub(crate) agents: &'a str,
}

impl Prepare<'_> {
    /// Writes what the review reads and its args.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let pull = Pull::load(self.runner)?;
        let protected = Protected::load(self.runner)?;
        let config = settings::for_workflow(&protected.config, self.agents)?;
        let review = self.runner.review_dir();
        let threads = self.threads(pull.number)?;
        let own = own_threads(&threads, self.reviewer);
        own.save(self.runner)?;
        let fixed_before: Vec<&ThreadId> = own
            .open
            .iter()
            .filter(|id| !own.fixed.contains(id))
            .collect();
        let files = Files {
            threads: review.join("threads.json"),
            pr: review.join("pr.json"),
            conversation: review.join("conversation.json"),
        };
        write_json(&files.threads, &threads)?;
        write_json(&files.pr, &self.pull_request(pull.number)?)?;
        write_json(&files.conversation, &self.conversation(pull.number)?)?;
        let base = self.checkout.text(&[
            "merge-base",
            &format!("origin/{}", pull.base),
            pull.head.as_str(),
        ])?;
        let previous = marker::read(pull.last_review.as_deref());
        if previous["unreadable"] == json!(true) {
            self.runner
                .warning("The last review's marker could not be read, so this review runs as a first review.");
        }
        let mut args = self.args(&pull, &base, &previous)?;
        let fields = [
            ("pr", json!(pull.number)),
            ("repo", json!(self.repo.to_string())),
            ("base", json!(base)),
            ("head", json!(pull.head)),
            ("checkout", json!(true)),
            ("rules", json!(protected.rules)),
            ("threads", json!(files.threads)),
            ("fixed_before", json!(fixed_before)),
            ("pr_file", json!(files.pr)),
            ("conversation", json!(files.conversation)),
            ("base_copies", json!(protected.base_copies)),
            ("reviewer", json!(self.reviewer)),
            ("config", config),
        ];
        args.extend(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value)),
        );
        let args = Value::Object(args);
        write_json(&args_path(self.runner), &args)?;
        let count = |key: &str| args[key].as_array().map(Vec::len);
        self.runner.print(
            &json!({
                "base": args["base"],
                "head": args["head"],
                "reviewed": args["reviewed"],
                "since": args["since"],
                "changed": count("changed"),
                "changed_since": count("changed_since"),
            })
            .to_string(),
        );
        Ok(())
    }

    /// The args that depend on the commits: the changed files, and what an
    /// earlier review left for this one.
    fn args(&self, pull: &Pull, base: &str, previous: &Value) -> Result<Map<String, Value>, Error> {
        let head = &pull.head;
        let changed = sorted(self.checkout.names(&[&format!("{base}...{head}")])?);
        let mut args = Map::new();
        // The limit on new Nits counts from the last reviewed commit; only a
        // complete review of an earlier commit lets segments skip a rerun.
        // git resolves an abbreviated commit, so only a full one counts.
        let reviewed = previous["head"]
            .as_str()
            .and_then(|commit| commit.parse::<Commit>().ok())
            .filter(|commit| {
                self.checkout.succeeds(&[
                    "merge-base",
                    "--is-ancestor",
                    commit.as_str(),
                    head.as_str(),
                ])
            });
        if let Some(reviewed) = reviewed {
            args.insert("reviewed".into(), json!(reviewed));
            let complete = previous["partial"] == json!(false);
            if complete && reviewed != *head {
                // A file the new commits revert leaves `changed`, but its
                // segments still run again, so their earlier findings on it clear.
                let mut scope: BTreeSet<String> = self
                    .checkout
                    .names(&[&format!("{base}...{reviewed}")])?
                    .into_iter()
                    .collect();
                scope.extend(changed.iter().cloned());
                let since: Vec<String> =
                    sorted(self.checkout.names(&[reviewed.as_str(), head.as_str()])?)
                        .into_iter()
                        .filter(|path| scope.contains(path))
                        .collect();
                args.insert("since".into(), json!(reviewed));
                args.insert("changed_since".into(), json!(since));
            }
        }
        // The findings the last review listed only in its summary stay until
        // a fix or an answer, whatever the commits since or how far it got.
        if previous["carried"].is_array() {
            args.insert("carried".into(), previous["carried"].clone());
        }
        // An id is never given twice, so the next review counts on from it.
        if previous["last_id"].is_u64() {
            args.insert("last_id".into(), previous["last_id"].clone());
        }
        args.insert("changed".into(), json!(changed));
        Ok(args)
    }

    /// Every review thread on the pull request, without the comments still
    /// pending: GitHub shows the token those of a review a cancelled run
    /// left, which the post step deletes.
    fn threads(&self, number: PullNumber) -> Result<Vec<Value>, Error> {
        let threads = github::nodes(
            self.github,
            THREADS,
            json!({ "owner": self.repo.owner(), "repo": self.repo.name(), "number": number }),
            &["repository", "pullRequest", "reviewThreads"],
        )?;
        Ok(threads.into_iter().filter_map(submitted).collect())
    }

    /// The pull request as `gh pr view --json
    /// title,body,url,author,baseRefName,headRefOid,files` shows it.
    fn pull_request(&self, number: PullNumber) -> Result<Value, Error> {
        let pull = self.github.rest(
            github::Method::Get,
            &format!("repos/{}/pulls/{number}", self.repo),
            None,
        )?;
        let files = self
            .github
            .rest_pages(&format!("repos/{}/pulls/{number}/files", self.repo))?;
        let files: Vec<Value> = files
            .iter()
            .map(|file| json!({"path": file["filename"], "additions": file["additions"], "deletions": file["deletions"]}))
            .collect();
        Ok(json!({
            "title": pull["title"],
            "body": section::without(pull["body"].as_str().unwrap_or_default()),
            "url": pull["html_url"],
            "author": {"login": login(&pull["user"])},
            "baseRefName": pull["base"]["ref"],
            "headRefOid": pull["head"]["sha"],
            "files": files,
        }))
    }

    /// The pull request's comments and reviews, where an author answers
    /// findings listed only in the summary. It leaves out this reviewer's own
    /// review bodies, which say only where the summary is, and the pending
    /// review a cancelled run left, which the post step deletes; it keeps
    /// anyone else's review that quotes one.
    fn conversation(&self, number: PullNumber) -> Result<Value, Error> {
        let comments = self
            .github
            .rest_pages(&format!("repos/{}/issues/{number}/comments", self.repo))?;
        let reviews = self
            .github
            .rest_pages(&format!("repos/{}/pulls/{number}/reviews", self.repo))?;
        let own = |review: &Value| {
            login(&review["user"]) == self.reviewer
                && review["body"]
                    .as_str()
                    .is_some_and(|body| body.contains(marker::OPENING))
        };
        let comments: Vec<Value> = comments
            .iter()
            .map(|comment| json!({"author": login(&comment["user"]), "body": comment["body"], "url": comment["html_url"]}))
            .collect();
        let reviews: Vec<Value> = reviews
            .iter()
            .filter(|review| {
                review["state"] != "PENDING"
                    && review["body"].as_str().is_some_and(|body| !body.is_empty())
                    && !own(review)
            })
            .map(|review| json!({"author": login(&review["user"]), "state": review["state"], "body": review["body"]}))
            .collect();
        Ok(json!({ "comments": comments, "reviews": reviews }))
    }
}

/// The paths of the files the agents read.
struct Files {
    /// The review threads.
    threads: PathBuf,
    /// The pull request.
    pr: PathBuf,
    /// Its comments and reviews.
    conversation: PathBuf,
}

/// The args the prepare step wrote, in the trusted directory.
pub(crate) fn args_path(runner: &Runner) -> PathBuf {
    runner.trusted_dir().join("args.json")
}

/// The args the prepare step wrote.
pub(crate) fn load_args(runner: &Runner) -> Result<Value, Error> {
    read_json(&args_path(runner))
}

/// The threads the post step may reply in and resolve: `reviewer`'s open
/// threads, for a "Fixed" reply when it has none there yet, and for an answer
/// when a person, not this reviewer or another app, commented last.
fn own_threads(threads: &[Value], reviewer: &str) -> Own {
    let by_reviewer = |comment: &Value| {
        comment["author"]["login"]
            .as_str()
            .is_some_and(|author| author == reviewer)
    };
    let mut own = Own::default();
    for thread in threads {
        let comments = thread["comments"]["nodes"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let (Some(id), Some((first, replies))) = (thread["id"].as_str(), comments.split_first())
        else {
            continue;
        };
        if thread["isResolved"] != json!(false) || !by_reviewer(first) {
            continue;
        }
        own.open.push(ThreadId::from(id));
        // The job's replies start with its "Fixed" line, or hold only an
        // answer and end with the marker that says so, whatever the answer says.
        let fixed = replies.iter().any(|reply| {
            by_reviewer(reply)
                && reply["body"]
                    .as_str()
                    .is_some_and(|body| !body.trim_end().ends_with(marker::ANSWER))
        });
        if !fixed {
            own.fixed.push(ThreadId::from(id));
        }
        let waiting = replies
            .last()
            .is_some_and(|last| !by_reviewer(last) && last["author"]["__typename"] == "User");
        if waiting {
            own.waiting.push(ThreadId::from(id));
        }
    }
    own
}

/// `thread` without its pending comments; `None` when it has no others.
fn submitted(mut thread: Value) -> Option<Value> {
    let comments = thread["comments"]["nodes"].as_array_mut()?;
    comments.retain(|comment| comment["state"] != "PENDING");
    (!comments.is_empty()).then_some(thread)
}

/// `names` sorted, each once.
fn sorted(names: Vec<String>) -> Vec<String> {
    names
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        Prepare,
        own_threads, //
    };
    use crate::{
        actions::TestRunner,
        git::Git,
        github::fake::{
            self,
            FakeGitHub,
            Kind, //
        },
        marker,
        post::Post,
        result::review_path,
        section,
        state::{
            Own,
            Protected,
            Pull,
            read_json,
            write_json, //
        },
        testing::{
            self,
            Repo, //
        },
    };
    use serde_json::{
        Value,
        json, //
    };

    /// A pull request's commits: `change` starts at `base` on `main`; `other`
    /// is a branch the pull request never had.
    struct Commits {
        /// The repository.
        repo: Repo,
        /// Where the pull request starts.
        base: String,
        /// A commit on another branch.
        other: String,
        /// The pull request's first commit: it changes `src/a.rs` and `web/x.tsx`.
        first: String,
        /// Its second: it changes `README.md`.
        second: String,
        /// Its third: it reverts `web/x.tsx`.
        third: String,
    }

    fn commits() -> Commits {
        let repo = Repo::new();
        let base = repo.commit(&[("README.md", "a"), ("src/a.rs", "a"), ("web/x.tsx", "a")]);
        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        repo.git(&["checkout", "-q", "-b", "other"]);
        let other = repo.commit(&[("README.md", "other")]);
        repo.git(&["checkout", "-q", "-b", "change", &base]);
        let first = repo.commit(&[("src/a.rs", "b"), ("web/x.tsx", "b")]);
        let second = repo.commit(&[("README.md", "b")]);
        let third = repo.commit(&[("web/x.tsx", "a")]);
        Commits {
            repo,
            base,
            other,
            first,
            second,
            third,
        }
    }

    /// The GitHub the step reads: no threads, the pull request, and no
    /// comments or reviews.
    fn github() -> FakeGitHub {
        FakeGitHub::new(|call| match call.kind {
            Kind::GraphQl => {
                Ok(json!({"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}))
            }
            Kind::Get | Kind::Post | Kind::Patch => {
                Ok(json!({"title": "t", "body": null, "user": {"login": "snowmead"}}))
            }
            Kind::Pages => Ok(json!([])),
        })
    }

    /// Runs the step at `head` after the review whose body is `last_review`,
    /// and returns the runner and the args.
    fn prepare(
        commits: &Commits,
        head: &str,
        last_review: Option<String>,
        github: &FakeGitHub,
    ) -> (TestRunner, Value) {
        commits.repo.git(&["checkout", "-q", head]);
        let test = TestRunner::new();
        let pull = Pull {
            number: 70.into(),
            head: head.parse().expect("a commit"),
            base: "main".into(),
            default_branch: "main".into(),
            last_review,
        };
        pull.save(&test.runner).expect("the pull request");
        Protected {
            source: "origin/main".into(),
            base_copies: vec!["AGENTS.md".into()],
            config: json!({"agents": {"editor": {"effort": "medium"}}, "examples": []}),
            rules: "/review/REVIEW.md".into(),
        }
        .save(&test.runner)
        .expect("the configuration");
        let checkout = Git::new(commits.repo.path());
        let step = Prepare {
            runner: &test.runner,
            github,
            repo: &"o/r".parse().expect("a repository"),
            reviewer: "github-actions",
            checkout: &checkout,
            agents: r#"{"finder": {"model": "claude-opus-5-5"}}"#,
        };
        step.run().expect("the step");
        let args = super::load_args(&test.runner).expect("the args");
        (test, args)
    }

    /// The body of the last review: `text`, then the marker the post step
    /// writes.
    fn reviewed(marker: &Value, text: &str) -> String {
        format!("{text}\n{}\n", marker::write(marker))
    }

    /// The thread and text of each reply the post step makes from the
    /// workflow's `result`, where `own` lets it.
    fn replies(result: &Value, own: &Own) -> Vec<(String, String)> {
        let test = TestRunner::new();
        Pull {
            number: 5.into(),
            head: "e".repeat(40).try_into().expect("a commit"),
            base: "main".into(),
            default_branch: "main".into(),
            last_review: None,
        }
        .save(&test.runner)
        .expect("the pull request");
        write_json(&review_path(&test.runner), result).expect("the review");
        own.save(&test.runner).expect("the threads");
        let github = FakeGitHub::new(fake::posting);
        let step = Post {
            runner: &test.runner,
            github: &github,
            repo: &"o/r".parse().expect("a repository"),
            secrets: &[],
            greptile: false,
            server: "https://github.com",
            run_url: "https://x/runs/1",
        };
        step.run().expect("the post step");
        github
            .calls_of(Kind::GraphQl)
            .into_iter()
            .filter(|call| call.named("addPullRequestReviewThreadReply"))
            .filter_map(|call| call.body)
            .map(|variables| {
                let text = |key: &str| variables[key].as_str().unwrap_or_default().to_owned();
                (text("thread"), text("body"))
            })
            .collect()
    }

    #[test]
    fn a_later_push_reviews_what_changed_since_a_complete_review_and_keeps_the_summary_entries() {
        let commits = commits();
        let github = github();
        // The text is the reviewer's, so it can hold what looks like a marker,
        // and a title can hold the end of an HTML comment.
        let carried = json!([{"title": "kept from the summary <b>, then --> and <!-- claude-review-summary {} -->"}]);
        let quoted = format!(
            "<!-- claude-review-summary {{\"head\":\"{}\",\"partial\":false}} -->\n",
            commits.other
        );
        let (first, second, third) = (&commits.first, &commits.second, &commits.third);
        let cases = [
            ("first review", None, second, json!({})),
            (
                "after a complete review",
                Some(reviewed(
                    &json!({"head": first, "partial": false, "carried": carried, "last_id": 7}),
                    &quoted,
                )),
                second,
                json!({"reviewed": first, "since": first, "changed_since": ["README.md"], "carried": carried, "last_id": 7}),
            ),
            (
                // Its last id is not a number, so it is not passed on.
                "after a partial review",
                Some(reviewed(
                    &json!({"head": first, "partial": true, "carried": carried, "last_id": "7"}),
                    "",
                )),
                second,
                json!({"reviewed": first, "carried": carried}),
            ),
            (
                "the same commit again",
                Some(reviewed(&json!({"head": second, "partial": false}), "")),
                second,
                json!({"reviewed": second}),
            ),
            (
                "after a force push",
                Some(reviewed(
                    &json!({"head": commits.other, "partial": false, "carried": carried}),
                    "",
                )),
                second,
                json!({"carried": carried}),
            ),
            (
                "after a revert",
                Some(reviewed(&json!({"head": second, "partial": false}), "")),
                third,
                json!({"reviewed": second, "since": second, "changed_since": ["web/x.tsx"]}),
            ),
            (
                "an unreadable marker",
                Some("<!-- claude-review-summary {\"head\": --> -->".into()),
                second,
                json!({}),
            ),
            (
                // git resolves an abbreviated commit, so only the check that a
                // head is a full commit id keeps it out.
                "a marker whose head is not a full commit id",
                Some(reviewed(
                    &json!({"head": &first[..12], "partial": false}),
                    "",
                )),
                second,
                json!({}),
            ),
        ];
        for (name, earlier, head, expected) in cases {
            let (test, args) = prepare(&commits, head, earlier, &github);
            assert_eq!(args["head"], json!(head), "{name}");
            assert_eq!(args["base"], json!(commits.base), "{name}");
            let later: serde_json::Map<String, Value> =
                ["reviewed", "since", "changed_since", "carried", "last_id"]
                    .into_iter()
                    .filter_map(|key| args.get(key).map(|value| (key.to_owned(), value.clone())))
                    .collect();
            assert_eq!(Value::Object(later), expected, "{name}");
            let warned = test.log().contains("marker could not be read");
            assert_eq!(
                warned,
                name == "an unreadable marker",
                "{name}: {}",
                test.log()
            );
        }
        let (_, args) = prepare(&commits, third, None, &github);
        assert_eq!(args["changed"], json!(["README.md", "src/a.rs"]));
    }

    #[test]
    fn the_args_name_what_the_agents_read_and_the_runs_models() {
        let commits = commits();
        let (test, args) = prepare(&commits, &commits.second, None, &github());
        let review = test.runner.review_dir();
        for (key, file) in [
            ("threads", "threads.json"),
            ("pr_file", "pr.json"),
            ("conversation", "conversation.json"),
        ] {
            assert_eq!(args[key], json!(review.join(file)), "{key}");
        }
        assert_eq!(
            (
                &args["pr"],
                &args["repo"],
                &args["rules"],
                &args["base_copies"],
                &args["reviewer"],
                &args["checkout"]
            ),
            (
                &json!(70),
                &json!("o/r"),
                &json!("/review/REVIEW.md"),
                &json!(["AGENTS.md"]),
                &json!("github-actions"),
                &json!(true)
            )
        );
        // The run's overrides join the settings, and the settings' own tests stay out.
        assert_eq!(
            args["config"],
            json!({"agents": {"editor": {"effort": "medium"}, "finder": {"model": "claude-opus-5-5"}}})
        );
        let pr: Value = read_json(&review.join("pr.json")).expect("the pull request");
        assert_eq!(
            (&pr["body"], &pr["author"]["login"]),
            (&json!(""), &json!("snowmead"))
        );
    }

    #[test]
    fn the_agents_read_the_description_and_conversation_without_this_reviewers_summaries() {
        let commits = commits();
        let marker = r#"<!-- claude-review-summary {"head":"abc"} -->"#;
        let comment = |login: &str, body: String| json!({"user": {"login": login}, "body": body, "html_url": "https://x/c"});
        let comments = json!([
            comment("github-actions[bot]", "Deployed to the preview.".into()),
            comment(
                "snowmead",
                format!("Answering the summary:\n> {marker}\nThe nit stays.")
            ),
        ]);
        let review = |login: &str, state: &str, body: String| json!({"user": {"login": login}, "state": state, "body": body});
        let reviews = json!([
            review(
                "github-actions[bot]",
                "COMMENTED",
                format!("**Claude review** of `abc`.\n\n{marker}")
            ),
            review("github-actions[bot]", "COMMENTED", String::new()),
            // What a cancelled run left for the post step to delete.
            review(
                "github-actions[bot]",
                "PENDING",
                "<!-- claude-review-pending -->".into()
            ),
            review("snowmead", "COMMENTED", String::new()),
            review("snowmead", "APPROVED", "Fine.".into()),
            review("other-bot[bot]", "COMMENTED", format!("Copied:\n{marker}")),
        ]);
        let description = section::replace("What this does.", "## Claude review\n\nOld findings.");
        let github = FakeGitHub::new(move |call| match call.kind {
            Kind::Pages if call.path.ends_with("/issues/70/comments") => Ok(comments.clone()),
            Kind::Pages if call.path.ends_with("/pulls/70/reviews") => Ok(reviews.clone()),
            Kind::Pages => Ok(json!([])),
            Kind::GraphQl => {
                Ok(json!({"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}))
            }
            Kind::Get | Kind::Post | Kind::Patch => Ok(json!({"body": description})),
        });
        let (test, _) = prepare(&commits, &commits.second, None, &github);
        let review = test.runner.review_dir();
        let pr: Value = read_json(&review.join("pr.json")).expect("the pull request");
        assert_eq!(pr["body"], "What this does.");
        let conversation: Value =
            read_json(&review.join("conversation.json")).expect("the conversation");
        assert_eq!(
            conversation,
            json!({
                "comments": [
                    {"author": "github-actions", "body": "Deployed to the preview.", "url": "https://x/c"},
                    {"author": "snowmead", "body": format!("Answering the summary:\n> {marker}\nThe nit stays."), "url": "https://x/c"},
                ],
                "reviews": [
                    {"author": "snowmead", "state": "APPROVED", "body": "Fine."},
                    {"author": "other-bot", "state": "COMMENTED", "body": format!("Copied:\n{marker}")},
                ],
            })
        );
    }

    #[test]
    fn lists_this_reviewers_open_threads_to_resolve_and_for_a_fixed_reply_and_an_answer() {
        // A person's comment, or an app's: the reviewer posts as an app.
        let comment = |login: &str, body: &str| {
            let kind = if login.contains("[bot]") || login == "github-actions" {
                "Bot"
            } else {
                "User"
            };
            let login = login.trim_end_matches("[bot]");
            json!({"author": {"__typename": kind, "login": login}, "body": body})
        };
        let thread = |name: &str, author: &str, resolved: bool, replies: &[(&str, &str)]| {
            let mut comments = vec![comment(author, "finding")];
            comments.extend(replies.iter().map(|(login, body)| comment(login, body)));
            json!({"id": name, "isResolved": resolved, "comments": {"nodes": comments}})
        };
        let threads = [
            thread("open", "github-actions", false, &[]),
            thread("resolved", "github-actions", true, &[("snowmead", "Why?")]),
            thread(
                "author says fixed",
                "github-actions",
                false,
                &[("snowmead", "Fixed in abc1234 (not yet pushed)")],
            ),
            thread(
                "fixed before",
                "github-actions",
                false,
                &[("github-actions", "Fixed in abc1234.")],
            ),
            thread(
                "asked after the fix",
                "github-actions",
                false,
                &[
                    ("github-actions", "Fixed in abc1234."),
                    ("snowmead", "Not for an empty list."),
                ],
            ),
            thread(
                "answered",
                "github-actions",
                false,
                &[
                    ("snowmead", "It is on purpose."),
                    ("github-actions", &format!("Agreed.\n\n{}", marker::ANSWER)),
                ],
            ),
            thread(
                "an app replied",
                "github-actions",
                false,
                &[("greptile-apps[bot]", "Same here.")],
            ),
            thread("someone else's", "snowmead", false, &[("octocat", "Why?")]),
            json!({"id": "no comments", "isResolved": false, "comments": {"nodes": []}}),
        ];
        assert_eq!(
            own_threads(&threads, "github-actions"),
            Own {
                open: vec![
                    "open".into(),
                    "author says fixed".into(),
                    "fixed before".into(),
                    "asked after the fix".into(),
                    "answered".into(),
                    "an app replied".into()
                ],
                fixed: vec![
                    "open".into(),
                    "author says fixed".into(),
                    "answered".into(),
                    "an app replied".into()
                ],
                waiting: vec!["author says fixed".into(), "asked after the fix".into()],
            }
        );
        // The post step's replies on a thread the workflow calls fixed, and on
        // one it answers with text that starts with "Fixed ", read back as
        // what they are: neither gets a second, and the answered thread can
        // still get its "Fixed" reply.
        let result = testing::workflow(&json!({
            "pr": 5, "threads": "/t.json", "base": "b".repeat(40), "head": "e".repeat(40), "changed": ["README.md"],
        }));
        let posted = replies(
            &result,
            &Own {
                open: vec!["T1".into(), "T2".into()],
                fixed: vec!["T1".into(), "T2".into()],
                waiting: vec!["T2".into()],
            },
        );
        let reply = |id: &str| {
            posted
                .iter()
                .find(|(thread, _)| thread == id)
                .map(|(_, body)| body.as_str())
                .expect("a reply")
        };
        let replied = [
            thread(
                "T1",
                "github-actions",
                false,
                &[("github-actions", reply("T1"))],
            ),
            thread(
                "T2",
                "github-actions",
                false,
                &[("snowmead", "Fixed?"), ("github-actions", reply("T2"))],
            ),
        ];
        assert_eq!(
            own_threads(&replied, "github-actions"),
            Own {
                open: vec!["T1".into(), "T2".into()],
                fixed: vec!["T2".into()],
                waiting: vec![],
            }
        );
        // The step writes the lists where only the job reads them, and the
        // threads with a "Fixed" reply to the args, from every page.
        let commits = commits();
        let pages = json!([
            {"repository": {"pullRequest": {"reviewThreads": {"pageInfo": {"hasNextPage": true, "endCursor": "c1"}, "nodes": [threads[0]]}}}},
            {"repository": {"pullRequest": {"reviewThreads": {"pageInfo": {"hasNextPage": false}, "nodes": [threads[2], threads[3]]}}}},
        ]);
        let github = FakeGitHub::new(move |call| match (call.kind, &call.body) {
            (Kind::GraphQl, Some(variables)) => {
                Ok(pages[usize::from(variables["cursor"] == json!("c1"))].clone())
            }
            (Kind::Pages, _) => Ok(json!([])),
            _ => Ok(json!({})),
        });
        let (test, args) = prepare(&commits, &commits.second, None, &github);
        assert_eq!(
            Own::load(&test.runner).expect("the threads"),
            Own {
                open: vec![
                    "open".into(),
                    "author says fixed".into(),
                    "fixed before".into()
                ],
                fixed: vec!["open".into(), "author says fixed".into()],
                waiting: vec!["author says fixed".into()],
            }
        );
        assert_eq!(args["fixed_before"], json!(["fixed before"]));
        let all: Value =
            read_json(&test.runner.review_dir().join("threads.json")).expect("the threads");
        assert_eq!(all.as_array().map(Vec::len), Some(3));
    }

    #[test]
    fn leaves_out_what_a_cancelled_run_left_pending() {
        // The post step deletes the pending review, so the agents must not
        // take its threads for raised findings, nor its replies for posted.
        let comment = |body: &str, state: &str| json!({"author": {"__typename": "Bot", "login": "github-actions"}, "body": body, "state": state});
        let threads = json!({"repository": {"pullRequest": {"reviewThreads": {"nodes": [
            {"id": "pending", "isResolved": false, "comments": {"nodes": [comment("finding", "PENDING")]}},
            {"id": "open", "isResolved": false, "comments": {"nodes": [
                comment("finding", "SUBMITTED"),
                comment("Fixed in abc1234.", "PENDING"),
            ]}},
        ]}}}});
        let github = FakeGitHub::new(move |call| match call.kind {
            Kind::GraphQl => Ok(threads.clone()),
            Kind::Pages => Ok(json!([])),
            Kind::Get | Kind::Post | Kind::Patch => Ok(json!({})),
        });
        let commits = commits();
        let (test, args) = prepare(&commits, &commits.second, None, &github);
        let all: Value =
            read_json(&test.runner.review_dir().join("threads.json")).expect("the threads");
        assert_eq!(
            all,
            json!([{"id": "open", "isResolved": false, "comments": {"nodes": [comment("finding", "SUBMITTED")]}}])
        );
        assert_eq!(
            Own::load(&test.runner).expect("the threads"),
            Own {
                open: vec!["open".into()],
                fixed: vec!["open".into()],
                waiting: vec![],
            }
        );
        assert_eq!(args["fixed_before"], json!([]));
    }
}
