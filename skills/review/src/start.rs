//! The start step: which pull request the run reviews, and the last review an
//! earlier run submitted, whose marker says what this run reviews again. It
//! runs as soon as this program is built, before the review's other steps, so
//! a run that fails after it can mark the summary in the pull request
//! description as not current. A run that fails before it, in building this
//! program, fails its check but leaves the summary as it was.
//!
//! A pull request event names the pull request. A manual run looks it up by
//! number, and refuses one from a fork: a manual run holds the secrets, so it
//! never reviews a fork's code. Either way the checkout must be at the pull
//! request's head, so inline comments land on its own line numbers.

use crate::{
    actions::Runner,
    error::Error,
    git::Git,
    github::{
        self,
        GitHub, //
    },
    id::{
        Commit,
        PullNumber,
        Repository, //
    },
    marker,
    state::Pull, //
};
use serde_json::{
    Value,
    json, //
};

/// What the start step reads.
pub(crate) struct Start<'a> {
    /// The runner.
    pub(crate) runner: &'a Runner,
    /// GitHub, with the job's token.
    pub(crate) github: &'a dyn GitHub,
    /// The repository.
    pub(crate) repo: &'a Repository,
    /// The login the review posts as, without `[bot]`.
    pub(crate) reviewer: &'a str,
    /// The event that started the run (`GITHUB_EVENT_NAME`).
    pub(crate) event: &'a str,
    /// The event's payload (`GITHUB_EVENT_PATH`).
    pub(crate) payload: &'a Value,
    /// The `pr` input of a manual run; empty otherwise.
    pub(crate) input: &'a str,
    /// The checkout.
    pub(crate) checkout: &'a Git<'a>,
}

impl Start<'_> {
    /// Finds the pull request and its last review, and saves both.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let mut pull = self.pull_request()?;
        let at = self.checkout.text(&["rev-parse", "HEAD"])?;
        if at != pull.head.as_str() {
            return Err(Error::review(format!(
                "The checkout is at {at}, not pull request {}'s head {}. Check out its head commit with \
                 fetch-depth 0 before the review, and run the review again after a new push.",
                pull.number, pull.head
            )));
        }
        pull.last_review = self.last_review(pull.number)?;
        pull.save(self.runner)
    }

    /// The pull request the event names, or the one the `pr` input numbers.
    fn pull_request(&self) -> Result<Pull, Error> {
        let default_branch = self.payload["repository"]["default_branch"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        // A head that is not a full commit id counts as none: no checkout's
        // head is one.
        if self.event == "pull_request" {
            let pull = &self.payload["pull_request"];
            return match (
                pull["number"].as_u64().map(PullNumber::from),
                pull["head"]["sha"]
                    .as_str()
                    .and_then(|sha| sha.parse::<Commit>().ok()),
                pull["base"]["ref"].as_str(),
            ) {
                (Some(number), Some(head), Some(base)) => Ok(Pull {
                    number,
                    head,
                    base: base.into(),
                    default_branch,
                    last_review: None,
                }),
                _ => Err(Error::review(
                    "The pull request event has no number, head, or base.",
                )),
            };
        }
        let number = self
            .input
            .trim()
            .parse::<u64>()
            .map(PullNumber::from)
            .map_err(|_| {
                Error::review("A manual review needs the pull request's number as its pr input.")
            })?;
        let data = self.github.graphql(
            "query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) { headRefOid baseRefName isCrossRepository }
              }
            }",
            &json!({ "owner": self.repo.owner(), "repo": self.repo.name(), "number": number }),
        )?;
        let pull = &data["repository"]["pullRequest"];
        if pull["isCrossRepository"] != json!(false) {
            return Err(Error::review(format!(
                "Pull request {number} comes from a fork; manual reviews run only on this repository's branches."
            )));
        }
        match (
            pull["headRefOid"]
                .as_str()
                .and_then(|sha| sha.parse::<Commit>().ok()),
            pull["baseRefName"].as_str(),
        ) {
            (Some(head), Some(base)) => Ok(Pull {
                number,
                head,
                base: base.into(),
                default_branch,
                last_review: None,
            }),
            _ => Err(Error::review(format!(
                "Pull request {number} has no head or base."
            ))),
        }
    }

    /// The body of the last review this reviewer submitted on pull request
    /// `number` with a marker. Only its own reviews count: anyone can quote a
    /// marker. A pending review is not submitted yet.
    fn last_review(&self, number: PullNumber) -> Result<Option<String>, Error> {
        let reviews = self
            .github
            .rest_pages(&format!("repos/{}/pulls/{number}/reviews", self.repo))?;
        Ok(reviews
            .iter()
            .filter(|review| {
                review["state"] != "PENDING" && github::login(&review["user"]) == self.reviewer
            })
            .filter_map(|review| review["body"].as_str())
            .rfind(|body| body.contains(marker::OPENING))
            .map(str::to_owned))
    }
}

#[cfg(test)]
mod tests {
    use super::Start;
    use crate::{
        actions::TestRunner,
        git::Git,
        github::fake::{
            FakeGitHub,
            Kind, //
        },
        state::Pull,
        testing::Repo, //
    };
    use serde_json::{
        Value,
        json, //
    };

    /// Runs the start step in `repo` with `github` and returns what it saved.
    fn start(
        repo: &Repo,
        github: &FakeGitHub,
        event: &str,
        payload: &Value,
    ) -> (TestRunner, Result<Pull, String>) {
        let test = TestRunner::new();
        let checkout = Git::new(repo.path());
        let step = Start {
            runner: &test.runner,
            github,
            repo: &"o/r".parse().expect("a repository"),
            reviewer: "github-actions",
            event,
            payload,
            input: "5",
            checkout: &checkout,
        };
        let result = step
            .run()
            .map_err(|error| error.to_string())
            .and_then(|()| Pull::load(&test.runner).map_err(|error| error.to_string()));
        (test, result)
    }

    #[test]
    fn a_manual_run_reviews_only_a_branch_of_this_repository() {
        let repo = Repo::new();
        let head = repo.commit(&[("a.rs", "a")]);
        let payload = json!({"repository": {"default_branch": "main"}});
        for (name, cross, refused) in [
            ("a branch here", json!(false), false),
            ("a fork", json!(true), true),
            ("unknown", json!(null), true),
        ] {
            let answer = json!({"repository": {"pullRequest": {"headRefOid": head, "baseRefName": "main", "isCrossRepository": cross}}});
            let github = FakeGitHub::new(move |call| match call.kind {
                Kind::GraphQl => Ok(answer.clone()),
                Kind::Pages => Ok(json!([])),
                Kind::Get | Kind::Post | Kind::Patch => panic!("no REST call"),
            });
            let (_, result) = start(&repo, &github, "workflow_dispatch", &payload);
            if refused {
                let error = result.expect_err(name);
                assert!(
                    error.contains("Pull request 5 comes from a fork"),
                    "{name}: {error}"
                );
            } else {
                let pull = result.expect(name);
                assert_eq!(
                    (pull.number, pull.head.as_str(), pull.base.as_str()),
                    (5.into(), head.as_str(), "main")
                );
            }
        }
    }

    #[test]
    fn finds_this_reviewers_last_submitted_review() {
        let repo = Repo::new();
        let head = repo.commit(&[("a.rs", "a")]);
        let payload = json!({"pull_request": {"number": 5, "head": {"sha": head}, "base": {"ref": "main"}},
                             "repository": {"default_branch": "main"}});
        let marker = |head: &str| {
            format!(r#"<!-- claude-review-summary {{"head":"{head}","partial":false}} -->"#)
        };
        let review = |login: &str, state: &str, body: String| json!({"user": {"login": login}, "state": state, "body": body});
        let reviews = json!([
            review(
                "github-actions[bot]",
                "COMMENTED",
                format!("First.\n\n{}", marker("a"))
            ),
            review(
                "snowmead",
                "COMMENTED",
                format!("Quoting it:\n> {}", marker("b"))
            ),
            review(
                "github-actions[bot]",
                "COMMENTED",
                format!("Second.\n\n{}", marker("c"))
            ),
            // A review the job posts with no marker, such as a reply alone.
            review("github-actions[bot]", "COMMENTED", String::new()),
            review(
                "other-bot[bot]",
                "COMMENTED",
                format!("Copied:\n{}", marker("d"))
            ),
            // GitHub lists the token's own pending review too.
            review("github-actions[bot]", "PENDING", marker("e")),
        ]);
        for (name, listed, expected) in [
            (
                "an earlier review",
                reviews,
                Some(format!("Second.\n\n{}", marker("c"))),
            ),
            ("none", json!([]), None),
        ] {
            let github = FakeGitHub::new(move |call| match call.kind {
                Kind::Pages if call.path == "repos/o/r/pulls/5/reviews" => Ok(listed.clone()),
                _ => panic!("unexpected call {call:?}"),
            });
            let (_, result) = start(&repo, &github, "pull_request", &payload);
            assert_eq!(result.expect(name).last_review, expected, "{name}");
        }
    }

    #[test]
    fn refuses_a_checkout_at_another_commit() {
        let repo = Repo::new();
        repo.commit(&[("a.rs", "a")]);
        let payload = json!({"pull_request": {"number": 5, "head": {"sha": "e".repeat(40)}, "base": {"ref": "main"}}});
        let github = FakeGitHub::new(|_| Ok(json!([])));
        let (_, result) = start(&repo, &github, "pull_request", &payload);
        assert!(
            result
                .expect_err("another commit")
                .contains(&format!("not pull request 5's head {}", "e".repeat(40)))
        );
    }
}
