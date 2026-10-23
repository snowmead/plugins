//! The post step: posts the review the result step read.
//!
//! A secret a review agent printed would be public, so every posted string
//! drops the job's secrets first. Each push gets one review. The step deletes
//! the pending review a cancelled run left, as GitHub allows each person one
//! on a pull request, and starts its own. It adds each finding on its lines,
//! or on its file when GitHub refuses the lines, and in the threads this
//! reviewer raised it replies only as the lists the prepare step made before
//! the review ran allow: once when the new commits fix one, and with an answer
//! to a person who commented last. Then it writes the summary to the job's
//! section of the pull request description, where each issue links to its
//! comment, and only then submits the review, whose body ends with the marker
//! for the next review: a marker never names a commit whose findings nobody
//! could read. A finding that fits nowhere on the diff stays in the summary,
//! and its carried entry in the marker, so the next review keeps it. The
//! step's `resolve` output lists the threads the review calls settled, for a
//! job whose token may resolve them. A partial review, or one GitHub did not
//! take, writes what it can, then fails so the author knows to run it again.

use crate::{
    actions::{
        Annotation,
        Runner, //
    },
    error::Error,
    github::{
        GitHub,
        Method, //
    },
    id::{
        Commit,
        Repository,
        ReviewId,
        ThreadId, //
    },
    marker,
    result::review_path,
    section,
    state::{
        Own,
        Pull,
        read_json, //
    },
    stream::{
        Events,
        text, //
    }, //
};
use serde_json::{
    Map,
    Value,
    json, //
};
use std::collections::HashSet;

/// The shortest value redaction treats as a secret: shorter ones are not
/// secrets the job holds.
const SHORTEST_SECRET: usize = 8;

/// The query for the pull request's node id and the pending reviews the
/// token can see, which are only its own.
const PENDING: &str = "query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      reviews(states: [PENDING], first: 100) { nodes { id viewerDidAuthor body } }
    }
  }
}";

/// The mutation that starts a pending review at a commit, with a body that
/// marks it as this job's until the submit replaces it.
const START: &str = "mutation($pr: ID!, $head: GitObjectID!, $body: String!) {
  addPullRequestReview(input: {pullRequestId: $pr, commitOID: $head, body: $body}) { pullRequestReview { id } }
}";

/// The body of the job's pending review, by which the next run knows one a
/// cancelled run left from any other pending review of the same token.
const PENDING_BODY: &str = "<!-- claude-review-pending -->";

/// The mutation that adds a thread to a pending review. GitHub answers a
/// thread it cannot place on the diff with none, not with an error.
const THREAD: &str = "mutation($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id comments(first: 1) { nodes { url } } } }
}";

/// The mutation that adds a reply in a review thread to a pending review.
const REPLY: &str = "mutation($review: ID!, $thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body}) {
    clientMutationId
  }
}";

/// The mutation that submits a pending review as a comment.
const SUBMIT: &str = "mutation($review: ID!, $body: String!) {
  submitPullRequestReview(input: {pullRequestReviewId: $review, event: COMMENT, body: $body}) { clientMutationId }
}";

/// The query for a review's state, which says whether GitHub took a review
/// whose submit failed in transport.
const STATE: &str = "query($review: ID!) {
  node(id: $review) { ... on PullRequestReview { state } }
}";

/// The mutation that deletes a pending review.
const DELETE: &str = "mutation($review: ID!) {
  deletePullRequestReview(input: {pullRequestReviewId: $review}) { clientMutationId }
}";

/// The ways a comment can sit on the diff, tried in order until GitHub takes
/// one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Form {
    /// On the lines from `start_line` to `line`.
    Range,
    /// On `line`.
    Line,
    /// On a range's last line, with a suggestion shown as plain code, since
    /// applying it there would replace that one line.
    LastLine,
    /// On the file.
    File,
}

/// Where a finding went.
#[derive(Debug)]
enum Placed {
    /// On the diff, in a thread of the review.
    Inline {
        /// The URL of the thread's comment; `None` when GitHub gave none.
        url: Option<String>,
    },
    /// Only in the summary: GitHub refused each form, or failed on one.
    Summary,
}

impl Placed {
    /// Whether the finding is on the diff.
    fn is_inline(&self) -> bool {
        match self {
            Self::Inline { url: _ } => true,
            Self::Summary => false,
        }
    }
}

/// What became of the review's submit.
#[derive(Clone, Copy, Debug)]
enum Submitted {
    /// GitHub took the review.
    Taken,
    /// GitHub did not take it, and the pending review is deleted.
    Refused,
    /// GitHub failed on the submit and on the check after it, so the review
    /// may or may not be on the pull request.
    Unknown,
}

/// How much of the summary the pull request description has room for.
#[derive(Clone, Copy, Debug)]
enum Room {
    /// All of it.
    Full,
    /// All but the text of the findings that fit nowhere on the diff, which
    /// goes on the run's summary page.
    Lists,
    /// The heading and a link to the run's summary page, which holds the rest.
    Heading,
}

/// Where the summary is.
#[derive(Clone, Copy, Debug)]
enum Shown {
    /// At the bottom of the pull request description, whole or as a heading
    /// with a link to the run's summary page.
    Description,
    /// Only on the run's summary page: the description has no room for it.
    Run,
}

/// Where an issue's title links.
#[derive(Clone, Copy, Debug)]
enum Link<'a> {
    /// To its comment or thread.
    To {
        /// The URL; `None` when there is none.
        url: Option<&'a str>,
    },
    /// Nowhere: its comment could not be posted inline, which its note says.
    Unposted,
}

/// What the post step did in the review's threads.
#[derive(Default)]
struct Replied {
    /// How many replies GitHub took into the review.
    posted: usize,
    /// The threads to resolve.
    settled: Vec<ThreadId>,
    /// The settled threads whose reply is in the review, which the author
    /// sees only once GitHub takes the review.
    answered: Vec<ThreadId>,
}

/// What the post step reads.
pub(crate) struct Post<'a> {
    /// The runner.
    pub(crate) runner: &'a Runner,
    /// GitHub, with the job's token.
    pub(crate) github: &'a dyn GitHub,
    /// The repository.
    pub(crate) repo: &'a Repository,
    /// The job's secrets, which no posted text may hold.
    pub(crate) secrets: &'a [String],
    /// Whether the job has a Greptile key, so the agents should have reached
    /// Greptile.
    pub(crate) greptile: bool,
    /// The GitHub server's address (`GITHUB_SERVER_URL`), for the link to the
    /// reviewed commit.
    pub(crate) server: &'a str,
    /// The run's page.
    pub(crate) run_url: &'a str,
}

impl Post<'_> {
    /// Posts the review and writes its summary.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let pull = Pull::load(self.runner)?;
        let review = redact(read_json(&review_path(self.runner))?, self.secrets);
        let own = Own::load(self.runner)?;
        self.check_greptile()?;
        let comments = review["comments"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let pending = self.start(&pull)?;
        let mut placed = Vec::with_capacity(comments.len());
        let mut failures = Vec::new();
        for comment in comments {
            placed.push(self.place(&pending, comment).unwrap_or_else(|error| {
                failures.push(error);
                Placed::Summary
            }));
        }
        let mut replied = self.reply(&review, &own, &pending);
        let inline = placed.iter().filter(|place| place.is_inline()).count();
        let shown = match self.describe(
            &pull,
            &review["summary"],
            comments,
            &placed,
            Submitted::Taken,
        ) {
            Ok(shown) => shown,
            Err(error) => {
                self.discard(&pending);
                return Err(error);
            }
        };
        let body = format!(
            "{}\n\n{}\n",
            self.review_line(&pull.head, inline, replied.posted, shown),
            marker::write(&next_marker(&review, comments, &placed))
        );
        match self.submit(&pending, &body) {
            Submitted::Taken => {}
            Submitted::Refused => {
                // The author would not see why a thread whose reply was in
                // the review closed.
                replied
                    .settled
                    .retain(|thread| !replied.answered.contains(thread));
                self.runner
                    .set_output("resolve", &json!(replied.settled).to_string())?;
                placed.fill_with(|| Placed::Summary);
                let described = self.describe(
                    &pull,
                    &review["summary"],
                    comments,
                    &placed,
                    Submitted::Refused,
                );
                let place = match &described {
                    Ok(Shown::Description) => "in the summary in the pull request description",
                    Ok(Shown::Run) => "in the summary on the run's summary page",
                    Err(_) => {
                        "on the run's summary page, as the pull request description could not be written"
                    }
                };
                match &described {
                    Ok(_) => self.runner.set_output("summary", "written")?,
                    Err(_) => self.record(comments)?,
                }
                self.runner.annotate(
                    Annotation::Error,
                    "Claude review not posted",
                    &format!(
                        "GitHub did not take the review, so its findings are only {place}. Re-run this job to \
                         post them."
                    ),
                );
                described?;
                return Err(Error::Reported);
            }
            Submitted::Unknown => {
                replied
                    .settled
                    .retain(|thread| !replied.answered.contains(thread));
                self.runner
                    .set_output("resolve", &json!(replied.settled).to_string())?;
                // The comments may still be pending, which only this job can
                // read, so the run's page holds their text.
                self.record(comments)?;
                let described = self.describe(
                    &pull,
                    &review["summary"],
                    comments,
                    &placed,
                    Submitted::Unknown,
                );
                if described.is_ok() {
                    self.runner.set_output("summary", "written")?;
                }
                self.runner.annotate(
                    Annotation::Error,
                    "Claude review may not be posted",
                    "GitHub failed on the submit and on the check of the review after it. Look for this \
                     review on the pull request before you re-run this job, which would post it again.",
                );
                described?;
                return Err(Error::Reported);
            }
        }
        self.runner.set_output("summary", "written")?;
        self.runner.summarize(&format!(
            "Posted {inline} of {} findings inline, replied in {} threads, and found {} settled.\n",
            comments.len(),
            replied.posted,
            replied.settled.len()
        ))?;
        self.runner
            .set_output("resolve", &json!(replied.settled).to_string())?;
        let refused = comments.len() - inline - failures.len();
        if refused > 0 {
            self.runner.warning(&format!(
                "{refused} finding(s) did not fit the diff and were added to the summary."
            ));
        }
        if let Some(first) = failures.first() {
            self.runner.warning(&format!(
                "{} finding(s) could not be posted inline and were added to the summary: {first}",
                failures.len()
            ));
        }
        if !matches!(review["partial"], Value::Null | Value::Bool(false)) {
            let failed: Vec<String> = review["failed"]
                .as_array()
                .map(|failed| failed.iter().map(text).collect())
                .unwrap_or_default();
            self.runner.annotate(
                Annotation::Error,
                "Claude review incomplete",
                &format!(
                    "{} did not finish. Re-run this job for a full review.",
                    failed.join(", ")
                ),
            );
            return Err(Error::Reported);
        }
        Ok(())
    }

    /// Warns when the job has a Greptile key but no agent connected to
    /// Greptile: the summary says the review did not read the knowledge base,
    /// and a key that no longer connects is a fault in the job.
    fn check_greptile(&self) -> Result<(), Error> {
        if !self.greptile {
            return Ok(());
        }
        let events = Events::load(self.runner)?;
        let status = events
            .as_ref()
            .and_then(Events::last_result)
            .and_then(|result| result["mcp_servers"].as_array())
            .and_then(|servers| servers.iter().find(|server| server["name"] == "greptile"))
            .and_then(|server| server["status"].as_str());
        if status != Some("connected") {
            self.runner.warning(&format!(
                "Greptile's MCP server did not connect: {}.",
                status.unwrap_or("not started")
            ));
        }
        Ok(())
    }

    /// Starts this push's pending review at the head commit, after deleting
    /// the pending review that a cancelled run of this job left. A pending
    /// review of the same token that is not the job's stays, and GitHub then
    /// refuses to start another.
    fn start(&self, pull: &Pull) -> Result<ReviewId, Error> {
        let variables =
            json!({ "owner": self.repo.owner(), "repo": self.repo.name(), "number": pull.number });
        let data = self.github.graphql(PENDING, &variables)?;
        let found = &data["repository"]["pullRequest"];
        let stale = found["reviews"]["nodes"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let own = |review: &&Value| {
            review["viewerDidAuthor"] == json!(true)
                && review["body"]
                    .as_str()
                    .is_some_and(|body| body.contains(PENDING_BODY))
        };
        for id in stale
            .iter()
            .filter(own)
            .filter_map(|review| review["id"].as_str())
        {
            self.github.graphql(DELETE, &json!({ "review": id }))?;
            self.runner
                .print("Deleted the pending review that a cancelled run left.");
        }
        let id = found["id"].as_str().ok_or_else(|| {
            Error::review(format!(
                "GitHub gave no id for pull request {}.",
                pull.number
            ))
        })?;
        let data = self.github.graphql(
            START,
            &json!({ "pr": id, "head": pull.head, "body": PENDING_BODY }),
        )?;
        data["addPullRequestReview"]["pullRequestReview"]["id"]
            .as_str()
            .map(ReviewId::from)
            .ok_or_else(|| Error::review("GitHub did not start the review."))
    }

    /// Adds `comment` to the pending `review` in the first form GitHub takes.
    /// GitHub refuses a form with no thread, or with a GraphQL error; after
    /// every form it refuses, the finding goes in the summary. Any other
    /// failure stops there, as GitHub may have taken the thread, and a next
    /// form would add it twice.
    fn place(&self, review: &ReviewId, comment: &Value) -> Result<Placed, Error> {
        let range = match (comment["start_line"].as_f64(), comment["line"].as_f64()) {
            (Some(start), Some(line)) => start < line,
            _ => false,
        };
        let forms: &[Form] = if range {
            &[Form::Range, Form::LastLine, Form::File]
        } else {
            &[Form::Line, Form::File]
        };
        for form in forms {
            let input = json!({ "input": thread(comment, *form, review) });
            match self.github.graphql(THREAD, &input) {
                Ok(data) => {
                    if let Some(placed) = inline(&data) {
                        return Ok(placed);
                    }
                }
                // GitHub added the thread and failed on part of the result:
                // one the result names is on the diff, and without one, the
                // thread may be, so no other form is tried.
                Err(Error::GraphQlPartial { detail, data }) => {
                    return inline(&data).ok_or(Error::GraphQlPartial { detail, data });
                }
                Err(error) if error.is_refusal() => {}
                Err(error) => return Err(error),
            }
        }
        Ok(Placed::Summary)
    }

    /// Submits the pending `review` with `body`. GitHub refuses with a
    /// GraphQL error; any other failure can come after GitHub took the
    /// review, so the review's state settles it, and when that cannot be read
    /// either, the outcome is unknown. A refused review is deleted.
    fn submit(&self, review: &ReviewId, body: &str) -> Submitted {
        let error = match self
            .github
            .graphql(SUBMIT, &json!({ "review": review, "body": body }))
        {
            Ok(_) => return Submitted::Taken,
            Err(error) => error,
        };
        if !error.is_refusal() {
            let state = self.github.graphql(STATE, &json!({ "review": review }));
            match state.as_ref().map(|data| data["node"]["state"].as_str()) {
                Ok(Some("PENDING")) => {}
                Ok(Some(_)) => return Submitted::Taken,
                Ok(None) | Err(_) => {
                    self.runner.warning(&format!(
                        "GitHub failed on the submit ({error}), and the review's state could not be read after it."
                    ));
                    return Submitted::Unknown;
                }
            }
        }
        self.runner.warning(&format!(
            "GitHub did not take the review, so the summary lists its findings: {error}"
        ));
        self.discard(review);
        Submitted::Refused
    }

    /// Puts the text of every finding in `comments` on the run's summary page.
    fn record(&self, comments: &[Value]) -> Result<(), Error> {
        let texts: Vec<String> = comments.iter().map(finding).collect();
        self.runner.summarize(&format!(
            "### Findings of this review\n\n{}\n",
            texts.join("\n\n")
        ))
    }

    /// Deletes the pending `review`, or warns that it could not.
    fn discard(&self, review: &ReviewId) {
        if let Err(error) = self.github.graphql(DELETE, &json!({ "review": review })) {
            self.runner
                .warning(&format!("Could not delete the pending review: {error}"));
        }
    }

    /// Adds one reply to the pending `review` in each thread the review
    /// replies in, with only what the prepare step's lists allow there: its
    /// "Fixed" line in a thread without one yet, and its answer in a thread
    /// where a person commented last. An answer without the "Fixed" line ends
    /// with [`marker::ANSWER`]. Lists to resolve the threads the review calls
    /// settled that are this reviewer's open threads, unless the reply there
    /// failed.
    ///
    /// [`marker::ANSWER`]: crate::marker::ANSWER
    fn reply(&self, review: &Value, own: &Own, pending: &ReviewId) -> Replied {
        let replies = review["replies"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut seen = HashSet::new();
        let mut replied = Replied::default();
        for reply in replies {
            let Some(id) = reply["thread_id"].as_str() else {
                continue;
            };
            let thread = ThreadId::from(id);
            let part = |key: &str, listed: &[ThreadId]| {
                reply[key]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .filter(|_| listed.contains(&thread))
            };
            let body = match (part("fixed", &own.fixed), part("answer", &own.waiting)) {
                (Some(fixed), Some(answer)) => Some(format!("{fixed}\n\n{answer}")),
                (Some(fixed), None) => Some(fixed.to_owned()),
                (None, Some(answer)) => Some(format!("{answer}\n\n{}", marker::ANSWER)),
                (None, None) => None,
            };
            let resolve = reply["resolve"] == json!(true) && own.open.contains(&thread);
            if (body.is_none() && !resolve) || !seen.insert(id) {
                continue;
            }
            if let Some(body) = body {
                let variables = json!({ "review": pending, "thread": thread, "body": body });
                if self.github.graphql(REPLY, &variables).is_err() {
                    self.runner.warning("Could not reply in a review thread.");
                    continue;
                }
                replied.posted += 1;
                if resolve {
                    replied.answered.push(ThreadId::from(id));
                }
            }
            if resolve {
                replied.settled.push(thread);
            }
        }
        replied
    }

    /// Writes the summary to the job's section of the pull request
    /// description, read just before, so the author's own text stays as they
    /// left it. When the description would pass GitHub's limit, the text of
    /// the findings that fit nowhere on the diff goes to the run's summary
    /// page instead, and the section links there; when it still would, so
    /// does all but the heading. When even that would not fit, as when the
    /// author's text fills the description, the summary is only on the run's
    /// page and the description loses its stale section. The write sets the
    /// whole description, so one that fails is tried once more. Returns where
    /// the summary is.
    fn describe(
        &self,
        pull: &Pull,
        summary: &Value,
        comments: &[Value],
        placed: &[Placed],
        submitted: Submitted,
    ) -> Result<Shown, Error> {
        let path = format!("repos/{}/pulls/{}", self.repo, pull.number);
        let current = self.github.rest(Method::Get, &path, None)?;
        let author = current["body"].as_str().unwrap_or_default();
        let unplaced = unplaced(comments, placed);
        let text = |room| self.summary(pull, summary, placed, submitted, &unplaced, room);
        let fits = |room| {
            let body = section::replace(author, &text(room));
            (body.len() <= section::LIMIT).then_some((room, body))
        };
        let chosen = fits(Room::Full)
            .or_else(|| fits(Room::Lists))
            .or_else(|| fits(Room::Heading));
        let (shown, body) = match chosen {
            Some((Room::Full, body)) => (Shown::Description, body),
            Some((Room::Lists, body)) => {
                self.runner.summarize(&format!(
                    "### Findings that could not be posted inline\n\n{}\n",
                    unplaced.join("\n\n")
                ))?;
                (Shown::Description, body)
            }
            Some((Room::Heading, body)) => {
                self.runner.summarize(&format!("{}\n", text(Room::Full)))?;
                (Shown::Description, body)
            }
            None => {
                self.runner.warning(
                    "The pull request description has no room for the summary, so it is only on the run's \
                     summary page.",
                );
                self.runner.summarize(&format!("{}\n", text(Room::Full)))?;
                (Shown::Run, section::without(author))
            }
        };
        let write = || {
            self.github
                .rest(Method::Patch, &path, Some(&json!({ "body": body })))
        };
        write().or_else(|_| write())?;
        Ok(shown)
    }

    /// The visible line of the review's body: the commit, what the review
    /// holds, and where its summary is.
    fn review_line(&self, head: &Commit, comments: usize, replies: usize, shown: Shown) -> String {
        let short: String = head.as_str().chars().take(7).collect();
        let count =
            |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        let place = match shown {
            Shown::Description => "at the bottom of the pull request description".to_owned(),
            Shown::Run => format!(
                "on the [run's summary page]({}), as the pull request description has no room for it",
                self.run_url
            ),
        };
        format!(
            "**Claude review** of `{short}`: {} and {}. The summary, with the confidence score and every issue, is \
             {place}.",
            count(comments, "new comment", "new comments"),
            count(
                replies,
                "reply in an earlier thread",
                "replies in earlier threads"
            )
        )
    }

    /// The summary for the description: the workflow's, with each issue
    /// linked to its comment, the `unplaced` findings, and a footer that
    /// names the reviewed commit and the run; as much of it as `room` allows.
    fn summary(
        &self,
        pull: &Pull,
        summary: &Value,
        placed: &[Placed],
        submitted: Submitted,
        unplaced: &[String],
        room: Room,
    ) -> String {
        let mut parts = Vec::new();
        match submitted {
            Submitted::Taken => {}
            Submitted::Refused => parts.push(
                "> [!WARNING]\n> GitHub did not take this review's comments, so its findings are listed only \
                 here, and their ids are not kept. Run the job again to post them."
                    .to_owned(),
            ),
            Submitted::Unknown => parts.push(format!(
                "> [!WARNING]\n> GitHub failed while it took this review, so its comments may not be on the \
                 pull request, and their ids may not be kept. The [run's summary page]({}) has the text of every \
                 finding.",
                self.run_url
            )),
        }
        let short: String = pull.head.as_str().chars().take(7).collect();
        let footer = format!(
            "<sub>Last reviewed commit: [`{short}`]({}/{}/commit/{}) · [Run]({})</sub>",
            self.server, self.repo, pull.head, self.run_url
        );
        match room {
            Room::Heading => {
                let top = string(&summary["top"]);
                parts.push(top.lines().next().unwrap_or_default().to_owned());
                parts.push(format!(
                    "The summary does not fit in the pull request description, so it is on the \
                     [run's summary page]({}).",
                    self.run_url
                ));
                parts.push(footer);
                return parts.join("\n\n");
            }
            Room::Full | Room::Lists => {}
        }
        parts.push(string(&summary["top"]).to_owned());
        let issues = summary["issues"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        if issues.is_empty() {
            parts.push("No issues.".into());
        } else {
            let mut table = vec![
                "### Issues".to_owned(),
                String::new(),
                "| | Issue | Location |".into(),
                "|---|---|---|".into(),
            ];
            for issue in issues {
                let comment = issue["comment"]
                    .as_u64()
                    .and_then(|index| usize::try_from(index).ok());
                table.push(match comment {
                    None => row(
                        issue,
                        Link::To {
                            url: issue["link"].as_str(),
                        },
                    ),
                    Some(index) => match placed.get(index) {
                        Some(Placed::Inline { url }) => row(
                            issue,
                            Link::To {
                                url: url.as_deref(),
                            },
                        ),
                        Some(Placed::Summary) | None => row(issue, Link::Unposted),
                    },
                });
            }
            parts.push(table.join("\n"));
        }
        match (unplaced.len(), room) {
            (0, _) => {}
            (count, Room::Full) => parts.push(format!(
                "<details><summary>Findings that could not be posted inline: {count}</summary>\n\n{}\n\n</details>",
                unplaced.join("\n\n")
            )),
            (count, Room::Lists | Room::Heading) => parts.push(format!(
                "The text of the {count} finding(s) that could not be posted inline is on the \
                 [run's summary page]({}), as the description has no room for it.",
                self.run_url
            )),
        }
        parts.push(string(&summary["bottom"]).to_owned());
        parts.push(footer);
        parts.retain(|part| !part.trim().is_empty());
        parts.join("\n\n")
    }
}

/// The thread a reply to [`THREAD`] names, on the diff; `None` when it names
/// none.
fn inline(data: &Value) -> Option<Placed> {
    let thread = &data["addPullRequestReviewThread"]["thread"];
    thread["id"].is_string().then(|| Placed::Inline {
        url: thread["comments"]["nodes"][0]["url"]
            .as_str()
            .map(str::to_owned),
    })
}

/// The text of each finding that fits nowhere on the diff.
fn unplaced(comments: &[Value], placed: &[Placed]) -> Vec<String> {
    comments
        .iter()
        .zip(placed)
        .filter(|(_, place)| !place.is_inline())
        .map(|(comment, _)| finding(comment))
        .collect()
}

/// The text of the finding `comment` holds: where it is, then the comment.
fn finding(comment: &Value) -> String {
    format!(
        "`{}:{}`\n\n{}",
        string(&comment["path"]),
        text(&comment["line"]),
        string(&comment["body"])
    )
}

/// The marker for the next review: the workflow's, with the findings that fit
/// nowhere on the diff added to those it carries.
fn next_marker(review: &Value, comments: &[Value], placed: &[Placed]) -> Value {
    let mut next = match &review["marker"] {
        Value::Object(fields) => fields.clone(),
        _ => Map::new(),
    };
    let mut carried = match next.remove("carried") {
        Some(Value::Array(carried)) => carried,
        _ => Vec::new(),
    };
    carried.extend(
        comments
            .iter()
            .zip(placed)
            .filter(|(comment, place)| !place.is_inline() && !comment["carry"].is_null())
            .map(|(comment, _)| comment["carry"].clone()),
    );
    next.insert("carried".into(), Value::Array(carried));
    Value::Object(next)
}

/// An issue's row: its badge, its title with its `link`, its note, and
/// where it is. The workflow escaped each part for a table cell. A comment
/// GitHub refused says so, with the id the summary keeps it under.
fn row(issue: &Value, link: Link<'_>) -> String {
    let title = string(&issue["title"]);
    let (url, unposted) = match link {
        Link::To { url } => (url.filter(|url| !url.is_empty()), None),
        Link::Unposted => (
            None,
            Some(match string(&issue["id"]) {
                "" => "not posted inline".to_owned(),
                id => format!("{id}: not posted inline"),
            }),
        ),
    };
    // A bracket in a link's text would end it early.
    let title = match url {
        Some(url) => format!("[{}]({url})", title.replace('[', "\\[").replace(']', "\\]")),
        None => title.to_owned(),
    };
    let notes: Vec<&str> = [string(&issue["note"])]
        .into_iter()
        .chain(unposted.as_deref())
        .filter(|note| !note.is_empty())
        .collect();
    let note = if notes.is_empty() {
        String::new()
    } else {
        format!(" ({})", notes.join("; "))
    };
    format!(
        "| {} | {title}{note} | {} |",
        string(&issue["badge"]),
        string(&issue["where"])
    )
}

/// The input of the thread for `comment` in `form` on the pending `review`.
fn thread(comment: &Value, form: Form, review: &ReviewId) -> Value {
    let side = match &comment["side"] {
        Value::Null | Value::Bool(false) => json!("RIGHT"),
        side => side.clone(),
    };
    let body = match form {
        Form::LastLine => json!(text(&comment["body"]).replace("```suggestion\n", "```\n")),
        Form::Range | Form::Line | Form::File => comment["body"].clone(),
    };
    let path = &comment["path"];
    match form {
        Form::File => {
            json!({"pullRequestReviewId": review, "path": path, "body": body, "subjectType": "FILE"})
        }
        Form::Line | Form::LastLine => json!({
            "pullRequestReviewId": review, "path": path, "body": body, "line": comment["line"], "side": side,
        }),
        Form::Range => json!({
            "pullRequestReviewId": review, "path": path, "body": body, "line": comment["line"], "side": side,
            "startLine": comment["start_line"], "startSide": side,
        }),
    }
}

/// The text of `value`; empty when it is not text.
fn string(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// `value` with each of `secrets` in every string replaced by `[redacted]`.
fn redact(value: Value, secrets: &[String]) -> Value {
    let secrets: Vec<&str> = secrets
        .iter()
        .map(String::as_str)
        .filter(|secret| secret.chars().count() >= SHORTEST_SECRET)
        .collect();
    walk(value, &|text: String| {
        secrets
            .iter()
            .fold(text, |text, secret| text.replace(secret, "[redacted]"))
    })
}

/// `value` with `change` applied to every string in it.
fn walk(value: Value, change: &dyn Fn(String) -> String) -> Value {
    match value {
        Value::String(text) => Value::String(change(text)),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|item| walk(item, change)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, item)| (key, walk(item, change)))
                .collect(),
        ),
        other @ (Value::Null | Value::Bool(_) | Value::Number(_)) => other,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Post,
        redact, //
    };
    use crate::{
        actions::TestRunner,
        error::Error,
        github::fake::{
            self,
            Call,
            FakeGitHub,
            Kind, //
        },
        marker,
        result::review_path,
        section,
        state::{
            Own,
            Pull,
            write_json, //
        },
        stream::Events,
        testing, //
    };
    use serde_json::{
        Value,
        json, //
    };
    use std::fs;

    const SECRET: &str = "sk-ant-api-secret-0123";

    fn head() -> String {
        "e".repeat(40)
    }

    fn carry(title: &str) -> Value {
        json!({"id": "S1", "severity": "nit", "path": "src/a.rs", "line": 1, "title": title, "note": "n", "from": head()})
    }

    /// A review of `comments`, with an issue row for each, and `replies`.
    fn review(comments: Value, replies: Value) -> Value {
        let issues: Vec<Value> = comments
            .as_array()
            .expect("comments")
            .iter()
            .enumerate()
            .map(|(index, comment)| json!({"badge": "B", "title": comment["carry"]["title"], "where": "W", "note": "", "comment": index}))
            .collect();
        json!({
            "head": head(), "partial": false, "failed": [],
            "summary": {"top": "## Claude review · Confidence to merge: 4/5", "issues": issues, "bottom": "Segments."},
            "marker": {"head": head(), "partial": false, "failed": [], "carried": [carry("summary only")]},
            "comments": comments, "replies": replies,
        })
    }

    /// A GitHub that refuses what GitHub would: a line outside the diff and a
    /// range that starts outside it, with no thread, and a file the pull
    /// request does not have, with an error. `more` answers first.
    fn github(more: impl Fn(&Call) -> Option<Result<Value, Error>> + 'static) -> FakeGitHub {
        FakeGitHub::new(move |call| {
            if let Some(answer) = more(call) {
                return answer;
            }
            if call.named("addPullRequestReviewThread") {
                let input = &call.body.as_ref().expect("variables")["input"];
                if input["path"] == "gone.rs" {
                    return Err(fake::refused());
                }
                if (input["path"] == "unchanged.rs" && input.get("line").is_some())
                    || (input["path"] == "range.rs" && input.get("startLine").is_some())
                {
                    return Ok(json!({"addPullRequestReviewThread": {"thread": null}}));
                }
            }
            fake::posting(call)
        })
    }

    /// Runs the step over `review`; with `greptile`, the job has a Greptile
    /// key and the engine reported that status for Greptile's server.
    fn post(
        review: &Value,
        github: &FakeGitHub,
        greptile: Option<&str>,
    ) -> (TestRunner, Result<(), String>) {
        let test = TestRunner::new();
        Pull {
            number: 5.into(),
            head: head().try_into().expect("a commit"),
            base: "main".into(),
            default_branch: "main".into(),
            last_review: None,
        }
        .save(&test.runner)
        .expect("the pull request");
        write_json(&review_path(&test.runner), review).expect("the review");
        Own {
            open: vec!["T1".into(), "T2".into(), "T3".into(), "T5".into()],
            fixed: vec!["T1".into(), "T3".into()],
            waiting: vec!["T2".into(), "T3".into()],
        }
        .save(&test.runner)
        .expect("the threads");
        let result = json!({"type": "result", "mcp_servers": [{"name": "greptile", "status": greptile.unwrap_or("failed")}]});
        fs::write(Events::path(&test.runner), format!("{result}\n")).expect("the events");
        let secrets = [SECRET.to_owned(), String::new(), "short".into()];
        let step = Post {
            runner: &test.runner,
            github,
            repo: &"o/r".parse().expect("a repository"),
            secrets: &secrets,
            greptile: greptile.is_some(),
            server: "https://github.com",
            run_url: "https://x/runs/1",
        };
        let result = step.run().map_err(|error| error.to_string());
        (test, result)
    }

    /// The variables of each call to the GraphQL field `name`.
    fn sent(github: &FakeGitHub, name: &str) -> Vec<Value> {
        github
            .calls()
            .into_iter()
            .filter(|call| call.named(name))
            .filter_map(|call| call.body)
            .collect()
    }

    /// The thread and text of each reply the step added to review `R`.
    fn replies(github: &FakeGitHub) -> Vec<(Value, Value)> {
        sent(github, "addPullRequestReviewThreadReply")
            .into_iter()
            .map(|variables| {
                assert_eq!(variables["review"], "R");
                (variables["thread"].clone(), variables["body"].clone())
            })
            .collect()
    }

    /// The body of the one review the step submitted.
    fn submitted(github: &FakeGitHub) -> String {
        let [variables] = sent(github, "submitPullRequestReview")
            .try_into()
            .expect("one review");
        assert_eq!(variables["review"], "R");
        variables["body"].as_str().expect("a body").to_owned()
    }

    /// The job's section of the description the step wrote.
    fn summary(github: &FakeGitHub) -> String {
        let patch = github.calls_of(Kind::Patch).pop().expect("a description");
        assert_eq!(patch.path, "repos/o/r/pulls/5");
        let body = patch.body.expect("a body")["body"]
            .as_str()
            .expect("a description")
            .to_owned();
        section::find(&body).expect("the section").to_owned()
    }

    /// The threads the step's output says to resolve.
    fn resolved(test: &TestRunner) -> Value {
        let outputs = test.outputs();
        let list = outputs
            .lines()
            .find_map(|line| line.strip_prefix("resolve="))
            .expect("the resolve output");
        serde_json::from_str(list).expect("a list")
    }

    #[test]
    fn a_finding_github_refuses_comes_back_to_the_next_review_from_the_marker() {
        let args = json!({"pr": 5, "repo": "o/r", "threads": "/t.json", "base": "b".repeat(40), "head": head(), "changed": ["src/a.rs"]});
        let first = testing::workflow(&args);
        let github = github(|call| {
            call.named("addPullRequestReviewThread")
                .then(|| Ok(json!({"addPullRequestReviewThread": {"thread": null}})))
        });
        let (test, result) = post(&first, &github, None);
        result.expect("the step");
        // The next push changes only README.md, so the security segment does
        // not run again and the finding stays, as the marker carries it.
        let previous = marker::read(Some(&submitted(&github)));
        let next = json!({
            "pr": 5, "repo": "o/r", "threads": "/t.json", "base": "b".repeat(40), "head": "f".repeat(40),
            "changed": ["README.md", "src/a.rs"], "since": head(), "reviewed": head(), "changed_since": ["README.md"],
            "carried": previous["carried"], "last_id": previous["last_id"],
        });
        let second = testing::workflow(&next);
        let kept: Vec<(&Value, &Value)> = second["marker"]["carried"]
            .as_array()
            .expect("carried")
            .iter()
            .map(|carry| (&carry["id"], &carry["title"]))
            .collect();
        assert_eq!(kept, [(&json!("S1"), &json!("refused inline"))]);
        assert_eq!(previous["last_id"], json!(1));
        // The issue row says the finding is not inline, with the id an answer
        // names it by.
        let text = summary(&github);
        assert!(
            text.contains("| refused inline (S1: not posted inline) |"),
            "{text}"
        );
        // The workflow said thread T1 is fixed and answered a person in T2,
        // and the lists let the review reply in both and send the fixed one
        // to be resolved.
        assert_eq!(resolved(&test), json!(["T1"]));
        assert_eq!(
            replies(&github),
            [
                (
                    json!("T1"),
                    json!(format!("Fixed in {}: n", &"d".repeat(7)))
                ),
                (
                    json!("T2"),
                    json!(format!(
                        "Fixed only for a full list: `src/a.rs:3` still reads an empty one.\n\n{}",
                        marker::ANSWER
                    ))
                ),
            ]
        );
    }

    #[test]
    fn posts_every_finding_in_one_review_and_links_each_issue_to_its_comment() {
        let review = review(
            json!([
                {"path": "src/a.rs", "line": 3, "body": format!("on its line, with {SECRET}"), "carry": carry("line")},
                {"path": "unchanged.rs", "line": 4, "start_line": 2, "body": "on its file", "carry": carry("file")},
                {"path": "range.rs", "line": 6, "start_line": 5, "body": "on its last line\n\n```suggestion\nnew\n```",
                 "carry": carry("last line")},
                {"path": "gone.rs", "line": 9, "body": "nowhere", "carry": carry("nowhere")},
            ]),
            json!([]),
        );
        let github = github(|_| None);
        let (test, result) = post(&review, &github, None);
        result.expect("the step");
        // Each finding goes on its lines, a refused range on its last line,
        // then on its file, else only in the summary; all in review R.
        let threads = sent(&github, "addPullRequestReviewThread");
        let place = |variables: &Value| {
            let input = &variables["input"];
            assert_eq!(input["pullRequestReviewId"], "R");
            let form = if input.get("startLine").is_some() {
                "range"
            } else if input.get("line").is_some() {
                "line"
            } else {
                "file"
            };
            (input["path"].as_str().expect("a path").to_owned(), form)
        };
        assert_eq!(
            threads.iter().map(place).collect::<Vec<_>>(),
            [
                ("src/a.rs".into(), "line"),
                ("unchanged.rs".into(), "range"),
                ("unchanged.rs".into(), "line"),
                ("unchanged.rs".into(), "file"),
                ("range.rs".into(), "range"),
                ("range.rs".into(), "line"),
                ("gone.rs".into(), "line"),
                ("gone.rs".into(), "file"),
            ]
        );
        // On its last line, a suggestion for the range would replace that line alone.
        assert_eq!(
            threads[5]["input"]["body"],
            "on its last line\n\n```\nnew\n```"
        );
        assert_eq!(threads[0]["input"]["body"], "on its line, with [redacted]");
        assert_eq!(
            threads[1]["input"],
            json!({"pullRequestReviewId": "R", "path": "unchanged.rs", "body": "on its file",
                   "line": 4, "side": "RIGHT", "startLine": 2, "startSide": "RIGHT"})
        );
        assert_eq!(threads[3]["input"]["subjectType"], "FILE");
        // One review, submitted after every thread, says what it holds and
        // where the summary is, and ends with the marker, which carries the
        // summary's own findings and the one GitHub refused.
        let body = submitted(&github);
        assert!(
            body.starts_with(
                "**Claude review** of `eeeeeee`: 3 new comments and 0 replies in earlier threads. The summary, \
                 with the confidence score and every issue, is at the bottom of the pull request description.\n"
            ),
            "{body}"
        );
        let titles: Vec<Value> = marker::read(Some(&body))["carried"]
            .as_array()
            .expect("carried")
            .iter()
            .map(|carried| carried["title"].clone())
            .collect();
        assert_eq!(titles, [json!("summary only"), json!("nowhere")]);
        // The summary goes up first, so the marker never names a commit
        // whose findings nobody could read.
        let order: Vec<Kind> = github
            .calls()
            .into_iter()
            .filter(|call| call.named("submitPullRequestReview") || call.kind == Kind::Patch)
            .map(|call| call.kind)
            .collect();
        assert_eq!(order, [Kind::Patch, Kind::GraphQl]);
        // Each issue links to its comment; the one GitHub refused says so, and
        // its text follows the list.
        let text = summary(&github);
        for row in [
            "| B | [line](https://x/src/a.rs#3) | W |",
            "| B | [file](https://x/unchanged.rs#file) | W |",
            "| B | [last line](https://x/range.rs#6) | W |",
            "| B | nowhere (not posted inline) | W |",
        ] {
            assert!(text.contains(row), "{row}: {text}");
        }
        assert!(
            text.contains("<summary>Findings that could not be posted inline: 1</summary>\n\n`gone.rs:9`\n\nnowhere\n"),
            "{text}"
        );
        assert!(text.starts_with(
            "## Claude review · Confidence to merge: 4/5\n\n### Issues\n\n| | Issue | Location |"
        ));
        assert!(text.ends_with(
            "Segments.\n\n<sub>Last reviewed commit: [`eeeeeee`](https://github.com/o/r/commit/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee) · [Run](https://x/runs/1)</sub>"
        ));
        assert!(
            test.log()
                .contains("::warning title=Claude review::1 finding(s) did not fit the diff"),
            "{}",
            test.log()
        );
        assert!(test.outputs().contains("summary=written\n"));
        assert!(test.step_summary().contains(
            "Posted 3 of 4 findings inline, replied in 0 threads, and found 0 settled.\n"
        ));
    }

    #[test]
    fn a_thread_github_fails_on_is_not_added_again_in_another_form() {
        let review = review(
            json!([
                {"path": "flaky.rs", "line": 6, "start_line": 5, "body": "maybe posted", "carry": carry("maybe posted")},
                {"path": "src/a.rs", "line": 3, "body": "on its line", "carry": carry("line")},
            ]),
            json!([]),
        );
        // A gateway error can come after GitHub took the thread.
        let github = github(|call| {
            let flaky = call.named("addPullRequestReviewThread")
                && call
                    .body
                    .as_ref()
                    .is_some_and(|variables| variables["input"]["path"] == "flaky.rs");
            flaky.then(|| Err(fake::bad_gateway()))
        });
        let (test, result) = post(&review, &github, None);
        result.expect("the step");
        let paths: Vec<Value> = sent(&github, "addPullRequestReviewThread")
            .into_iter()
            .map(|variables| variables["input"]["path"].clone())
            .collect();
        assert_eq!(paths, [json!("flaky.rs"), json!("src/a.rs")]);
        let text = summary(&github);
        assert!(text.contains("`flaky.rs:6`\n\nmaybe posted\n"), "{text}");
        let log = test.log();
        assert!(
            log.contains(
                "::warning title=Claude review::1 finding(s) could not be posted inline and were added to the summary: \
                 GitHub GraphQL failed: HTTP 502: Bad Gateway"
            ),
            "{log}"
        );
        assert!(!log.contains("did not fit the diff"), "{log}");
    }

    #[test]
    fn a_thread_github_added_but_failed_on_part_of_is_not_added_again() {
        let review = review(
            json!([
                {"path": "named.rs", "line": 6, "body": "added", "carry": carry("added")},
                {"path": "unnamed.rs", "line": 4, "body": "maybe added", "carry": carry("maybe added")},
            ]),
            json!([]),
        );
        let github = github(|call| {
            if !call.named("addPullRequestReviewThread") {
                return None;
            }
            let path = call.body.as_ref().expect("variables")["input"]["path"].clone();
            let thread = match path.as_str() {
                Some("named.rs") => json!({"id": "T", "comments": {"nodes": [{"url": null}]}}),
                _ => Value::Null,
            };
            Some(Err(Error::GraphQlPartial {
                detail: "c".into(),
                data: json!({"addPullRequestReviewThread": {"thread": thread}}),
            }))
        });
        let (test, result) = post(&review, &github, None);
        result.expect("the step");
        // Each is sent once: GitHub may hold the one its result does not
        // name, so it goes in the summary without a second form.
        let paths: Vec<Value> = sent(&github, "addPullRequestReviewThread")
            .into_iter()
            .map(|variables| variables["input"]["path"].clone())
            .collect();
        assert_eq!(paths, [json!("named.rs"), json!("unnamed.rs")]);
        assert!(
            submitted(&github).starts_with("**Claude review** of `eeeeeee`: 1 new comment and")
        );
        let text = summary(&github);
        assert!(text.contains("| B | added | W |"), "{text}");
        assert!(!text.contains("`named.rs:6`"), "{text}");
        assert!(text.contains("`unnamed.rs:4`\n\nmaybe added\n"), "{text}");
        assert!(
            test.log().contains(
                "1 finding(s) could not be posted inline and were added to the summary: GitHub did a GraphQL \
                 mutation but failed on part of its result: c"
            ),
            "{}",
            test.log()
        );
    }

    #[test]
    fn deletes_the_pending_review_a_cancelled_run_left_and_submits_one_with_nothing_new() {
        // Only the job's own: another workflow of the same token can have a
        // pending review of its own.
        let github = github(|call| {
            call.named("pullRequest").then(|| {
                Ok(
                    json!({"repository": {"pullRequest": {"id": "PR", "reviews": {"nodes": [
                        {"id": "OLD", "viewerDidAuthor": true, "body": "<!-- claude-review-pending -->"},
                        {"id": "OTHER", "viewerDidAuthor": true, "body": "Another bot's."},
                        {"id": "THEIRS", "viewerDidAuthor": false, "body": "<!-- claude-review-pending -->"},
                    ]}}}}),
                )
            })
        });
        let (_, result) = post(&review(json!([]), json!([])), &github, None);
        result.expect("the step");
        let calls: Vec<String> = github
            .calls()
            .into_iter()
            .filter_map(|call| {
                [
                    "deletePullRequestReview",
                    "addPullRequestReview",
                    "submitPullRequestReview",
                ]
                .into_iter()
                .find(|name| call.named(name))
                .map(|name| {
                    format!(
                        "{name} {}",
                        call.body
                            .as_ref()
                            .map_or(Value::Null, |v| v["review"].clone())
                    )
                })
            })
            .collect();
        assert_eq!(
            calls,
            [
                "deletePullRequestReview \"OLD\"",
                "addPullRequestReview null",
                "submitPullRequestReview \"R\"",
            ]
        );
        let start = sent(&github, "addPullRequestReview");
        assert_eq!(
            start,
            [json!({"pr": "PR", "head": head(), "body": "<!-- claude-review-pending -->"})]
        );
        // A push with nothing new still gets its review, for the marker.
        let body = submitted(&github);
        assert!(body.starts_with("**Claude review** of `eeeeeee`: 0 new comments and 0 replies"));
        assert_eq!(marker::read(Some(&body))["head"], json!(head()));
        assert!(summary(&github).contains("\n\nNo issues.\n\n"));
    }

    #[test]
    fn replies_once_in_a_thread_with_only_what_its_lists_allow() {
        let review = review(
            json!([]),
            json!([
                // T1 may get its "Fixed" line, and no answer.
                {"thread_id": "T1", "fixed": "Fixed in abc.", "answer": "Also, thanks."},
                // A blank answer says nothing.
                {"thread_id": "T2", "answer": " "},
                // A person commented last in T2, which has its "Fixed" line.
                {"thread_id": "T2", "fixed": "Fixed in abc.", "answer": "It holds for an empty list too."},
                // T3 may get both, in one reply, once.
                {"thread_id": "T3", "fixed": "Fixed in def: n.", "answer": "The test covers it."},
                {"thread_id": "T3", "answer": "Again."},
                // T4 is not this reviewer's.
                {"thread_id": "T4", "fixed": "Fixed in abc.", "answer": "Agreed."},
            ]),
        );
        let github = github(|call| {
            let failing = call.named("addPullRequestReviewThreadReply")
                && call
                    .body
                    .as_ref()
                    .is_some_and(|variables| variables["thread"] == "T2");
            failing.then(|| Err(fake::bad_gateway()))
        });
        let (test, result) = post(&review, &github, None);
        result.expect("the step");
        assert_eq!(
            replies(&github),
            [
                (json!("T1"), json!("Fixed in abc.")),
                (
                    json!("T2"),
                    json!(format!(
                        "It holds for an empty list too.\n\n{}",
                        marker::ANSWER
                    ))
                ),
                (
                    json!("T3"),
                    json!("Fixed in def: n.\n\nThe test covers it.")
                ),
            ]
        );
        let log = test.log();
        assert!(
            log.contains("::warning title=Claude review::Could not reply in a review thread."),
            "{log}"
        );
        assert!(submitted(&github).contains("0 new comments and 2 replies in earlier threads."));
        assert!(test.step_summary().contains(
            "Posted 0 of 0 findings inline, replied in 2 threads, and found 0 settled.\n"
        ));
    }

    #[test]
    fn sends_this_reviewers_settled_threads_to_be_resolved_unless_its_reply_failed() {
        let review = review(
            json!([]),
            json!([
                // Resolved after its "Fixed" line.
                {"thread_id": "T1", "fixed": "Fixed in abc.", "resolve": true},
                // Its answer fails, so the author would not see why it closed.
                {"thread_id": "T2", "answer": "It holds.", "resolve": true},
                // Its "Fixed" line was posted before, so only resolved.
                {"thread_id": "T5", "fixed": "Fixed in abc.", "resolve": true},
                // Not settled.
                {"thread_id": "T3", "answer": "Not for an empty list."},
                // Not this reviewer's.
                {"thread_id": "T4", "fixed": "Fixed in abc.", "resolve": true},
            ]),
        );
        let github = github(|call| {
            let failing = call.named("addPullRequestReviewThreadReply")
                && call
                    .body
                    .as_ref()
                    .is_some_and(|variables| variables["thread"] == "T2");
            failing.then(|| Err(fake::bad_gateway()))
        });
        let (test, result) = post(&review, &github, None);
        result.expect("the step");
        assert_eq!(resolved(&test), json!(["T1", "T5"]));
        assert_eq!(
            replies(&github),
            [
                (json!("T1"), json!("Fixed in abc.")),
                (
                    json!("T2"),
                    json!(format!("It holds.\n\n{}", marker::ANSWER))
                ),
                (
                    json!("T3"),
                    json!(format!("Not for an empty list.\n\n{}", marker::ANSWER))
                ),
            ]
        );
        assert!(test.step_summary().contains(
            "Posted 0 of 0 findings inline, replied in 2 threads, and found 2 settled.\n"
        ));
    }

    #[test]
    fn a_review_github_does_not_take_lists_every_finding_in_the_summary_and_fails() {
        let review = review(
            json!([{"path": "src/a.rs", "line": 3, "body": "on its line", "carry": carry("line")}]),
            json!([
                {"thread_id": "T1", "fixed": "Fixed in abc.", "resolve": true},
                {"thread_id": "T5", "fixed": "Fixed in abc.", "resolve": true},
            ]),
        );
        let github = github(|call| {
            if call.named("node") {
                return Some(Ok(json!({"node": {"state": "PENDING"}})));
            }
            call.named("submitPullRequestReview")
                .then(|| Err(fake::bad_gateway()))
        });
        let (test, result) = post(&review, &github, None);
        assert_eq!(result, Err("the step failed".into()));
        // GitHub says the review is still pending, so it did not take it.
        assert_eq!(sent(&github, "node"), [json!({"review": "R"})]);
        assert_eq!(github.calls_of(Kind::Patch).len(), 2);
        // The pending review goes, and with it the "Fixed" line in T1, so only
        // T5, whose line came before, is resolved.
        assert_eq!(
            sent(&github, "deletePullRequestReview"),
            [json!({"review": "R"})]
        );
        assert_eq!(resolved(&test), json!(["T5"]));
        let text = summary(&github);
        // No marker keeps the ids it gave, so the warning says so.
        assert!(
            text.starts_with(
                "> [!WARNING]\n> GitHub did not take this review's comments, so its findings are listed only \
                 here, and their ids are not kept."
            ),
            "{text}"
        );
        assert!(
            text.contains("| B | line (not posted inline) | W |"),
            "{text}"
        );
        assert!(text.contains("`src/a.rs:3`\n\non its line"), "{text}");
        let log = test.log();
        assert!(
            log.contains(
                "::error title=Claude review not posted::GitHub did not take the review, so its findings are \
                 only in the summary in the pull request description."
            ),
            "{log}"
        );
        assert!(test.outputs().contains("summary=written\n"));
    }

    #[test]
    fn a_submit_that_fails_after_github_took_it_counts_as_taken() {
        let review = review(
            json!([{"path": "src/a.rs", "line": 3, "body": "on its line", "carry": carry("line")}]),
            json!([]),
        );
        let github = github(|call| {
            if call.named("node") {
                return Some(Ok(json!({"node": {"state": "COMMENTED"}})));
            }
            call.named("submitPullRequestReview")
                .then(|| Err(fake::bad_gateway()))
        });
        let (test, result) = post(&review, &github, None);
        result.expect("the step");
        assert!(sent(&github, "deletePullRequestReview").is_empty());
        assert_eq!(github.calls_of(Kind::Patch).len(), 1);
        assert!(!summary(&github).contains("did not take"));
        assert!(!test.log().contains("did not take"), "{}", test.log());
    }

    #[test]
    fn a_description_github_refuses_leaves_no_review() {
        let review = review(
            json!([{"path": "src/a.rs", "line": 3, "body": "on its line", "carry": carry("line")}]),
            json!([{"thread_id": "T5", "fixed": "Fixed in abc.", "resolve": true}]),
        );
        let github = github(|call| (call.kind == Kind::Patch).then(|| Err(fake::bad_gateway())));
        let (test, result) = post(&review, &github, None);
        assert_eq!(result, Err(fake::bad_gateway().to_string()));
        // Nothing is submitted, so no marker counts this commit as reviewed,
        // and no thread the review called settled is resolved.
        assert!(sent(&github, "submitPullRequestReview").is_empty());
        assert_eq!(
            sent(&github, "deletePullRequestReview"),
            [json!({"review": "R"})]
        );
        let outputs = test.outputs();
        assert!(!outputs.contains("summary=written"), "{outputs}");
        assert!(!outputs.contains("resolve="), "{outputs}");
    }

    #[test]
    fn a_summary_too_long_for_the_description_moves_the_findings_text_to_the_run() {
        let long = "x".repeat(70_000);
        let review = review(
            json!([{"path": "gone.rs", "line": 9, "body": long, "carry": carry("long")}]),
            json!([]),
        );
        let github = github(|_| None);
        let (test, result) = post(&review, &github, None);
        result.expect("the step");
        let text = summary(&github);
        assert!(!text.contains(&long));
        assert!(
            text.contains("The text of the 1 finding(s) that could not be posted inline is on the [run's summary page](https://x/runs/1)"),
            "{text}"
        );
        assert!(test.step_summary().contains(&format!(
            "### Findings that could not be posted inline\n\n`gone.rs:9`\n\n{long}"
        )));
    }

    #[test]
    fn a_summary_too_long_even_without_the_findings_text_keeps_only_its_heading() {
        let mut review = review(json!([]), json!([]));
        let row = json!({"badge": "B", "title": "t".repeat(300), "where": "W", "note": ""});
        review["summary"]["issues"] = json!(vec![row; 300]);
        let github = github(|_| None);
        let (test, result) = post(&review, &github, None);
        result.expect("the step");
        assert_eq!(
            summary(&github),
            "## Claude review · Confidence to merge: 4/5\n\nThe summary does not fit in the pull request \
             description, so it is on the [run's summary page](https://x/runs/1).\n\n<sub>Last reviewed commit: \
             [`eeeeeee`](https://github.com/o/r/commit/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee) · \
             [Run](https://x/runs/1)</sub>"
        );
        // The review still goes up, and the run's page holds the summary.
        assert_eq!(sent(&github, "submitPullRequestReview").len(), 1);
        assert!(
            test.step_summary()
                .contains(&format!("| B | {} | W |", "t".repeat(300)))
        );
    }

    #[test]
    fn a_bracket_in_a_title_does_not_end_its_link() {
        let mut review = review(
            json!([{"path": "src/a.rs", "line": 3, "body": "b", "carry": carry("Reject stray ] in [expressions")}]),
            json!([]),
        );
        review["summary"]["issues"]
            .as_array_mut()
            .expect("issues")
            .push(json!({"badge": "B", "title": "Thread [x]", "where": "W", "note": "", "link": "https://x/t"}));
        let github = github(|_| None);
        let (_, result) = post(&review, &github, None);
        result.expect("the step");
        let text = summary(&github);
        assert!(
            text.contains("| B | [Reject stray \\] in \\[expressions](https://x/src/a.rs#3) | W |"),
            "{text}"
        );
        assert!(
            text.contains("| B | [Thread \\[x\\]](https://x/t) | W |"),
            "{text}"
        );
    }

    #[test]
    fn a_submit_github_refuses_is_not_checked_and_a_second_failed_write_still_sets_the_outputs() {
        let review = review(
            json!([{"path": "src/a.rs", "line": 3, "body": "on its line", "carry": carry("line")}]),
            json!([{"thread_id": "T5", "fixed": "Fixed in abc.", "resolve": true}]),
        );
        let writes = std::cell::Cell::new(0);
        let github = github(move |call| {
            if call.named("submitPullRequestReview") {
                return Some(Err(fake::refused()));
            }
            // The first description goes up; the one after the refusal fails.
            if call.kind == Kind::Patch {
                writes.set(writes.get() + 1);
                return (writes.get() > 1).then(|| Err(fake::bad_gateway()));
            }
            None
        });
        let (test, result) = post(&review, &github, None);
        assert!(result.is_err());
        // A refusal needs no check of the review's state.
        assert!(sent(&github, "node").is_empty());
        assert_eq!(
            sent(&github, "deletePullRequestReview"),
            [json!({"review": "R"})]
        );
        // T5 needed no new reply, so it is still listed to resolve.
        assert_eq!(resolved(&test), json!(["T5"]));
        assert!(!test.outputs().contains("summary=written"));
        // The description could not take the findings, so the run's page
        // holds them, and the annotation says so.
        assert!(
            test.step_summary()
                .contains("### Findings of this review\n\n`src/a.rs:3`\n\non its line\n")
        );
        assert!(
            test.log().contains(
                "::error title=Claude review not posted::GitHub did not take the review, so its findings are \
                 only on the run's summary page, as the pull request description could not be written."
            ),
            "{}",
            test.log()
        );
    }

    #[test]
    fn a_submit_whose_outcome_github_cannot_tell_is_not_called_refused() {
        let review = review(
            json!([{"path": "src/a.rs", "line": 3, "body": "on its line", "carry": carry("line")}]),
            json!([{"thread_id": "T1", "fixed": "Fixed in abc.", "resolve": true}]),
        );
        let github = github(|call| {
            if call.named("node") {
                return Some(Err(fake::bad_gateway()));
            }
            call.named("submitPullRequestReview")
                .then(|| Err(fake::bad_gateway()))
        });
        let (test, result) = post(&review, &github, None);
        assert!(result.is_err());
        // Nothing is deleted, as the review may be on the pull request. Its
        // comments may still be pending, which no reader sees, so the section
        // says so and the run's page has their text.
        assert!(sent(&github, "deletePullRequestReview").is_empty());
        let text = summary(&github);
        assert!(
            text.starts_with(
                "> [!WARNING]\n> GitHub failed while it took this review, so its comments may not be on the \
                 pull request, and their ids may not be kept."
            ),
            "{text}"
        );
        assert!(
            text.contains("| B | [line](https://x/src/a.rs#3) | W |"),
            "{text}"
        );
        assert!(
            test.step_summary()
                .contains("### Findings of this review\n\n`src/a.rs:3`\n\non its line\n")
        );
        // T1's "Fixed" line may be lost, so T1 is not resolved.
        assert_eq!(resolved(&test), json!([]));
        assert!(test.outputs().contains("summary=written\n"));
        assert!(
            test.log()
                .contains("::error title=Claude review may not be posted::"),
            "{}",
            test.log()
        );
    }

    #[test]
    fn a_description_write_that_fails_once_is_tried_again() {
        let failed = std::cell::Cell::new(false);
        let github = github(move |call| {
            (call.kind == Kind::Patch && !failed.replace(true)).then(|| Err(fake::bad_gateway()))
        });
        let (_, result) = post(&review(json!([]), json!([])), &github, None);
        result.expect("the step");
        assert_eq!(github.calls_of(Kind::Patch).len(), 2);
        assert_eq!(sent(&github, "submitPullRequestReview").len(), 1);
    }

    #[test]
    fn a_description_with_no_room_keeps_the_review_and_drops_its_stale_section() {
        let author = "a".repeat(65_500);
        let description = section::replace(&author, "## Claude review\n\nOld.");
        let github = github(move |call| {
            (call.kind == Kind::Get).then(|| Ok(json!({ "body": description })))
        });
        let (test, result) = post(&review(json!([]), json!([])), &github, None);
        result.expect("the step");
        let patch = github.calls_of(Kind::Patch).pop().expect("a description");
        assert_eq!(patch.body.expect("a body")["body"], json!(author));
        // The review's body and the output say where the summary went.
        assert!(
            submitted(&github).contains(
                "is on the [run's summary page](https://x/runs/1), as the pull request description has no room \
                 for it."
            ),
            "{}",
            submitted(&github)
        );
        assert!(test.outputs().contains("summary=written\n"));
        assert!(
            test.log().contains("has no room for the summary"),
            "{}",
            test.log()
        );
        assert!(
            test.step_summary()
                .contains("## Claude review · Confidence to merge: 4/5")
        );
    }

    #[test]
    fn a_partial_review_writes_its_summary_and_then_fails() {
        let mut review = review(json!([]), json!([]));
        review["partial"] = json!(true);
        review["failed"] = json!(["tests"]);
        review["marker"]["partial"] = json!(true);
        let github =
            github(|call| (call.kind == Kind::Get).then(|| Ok(json!({"body": "What this does."}))));
        let (test, result) = post(&review, &github, None);
        assert_eq!(result, Err("the step failed".into()));
        assert!(
            test.log().contains("::error title=Claude review incomplete::tests did not finish. Re-run this job for a full review."),
            "{}",
            test.log()
        );
        assert_eq!(
            marker::read(Some(&submitted(&github)))["partial"],
            json!(true)
        );
        let [patch] = github
            .calls_of(Kind::Patch)
            .try_into()
            .expect("one description");
        let body = patch.body.expect("a body")["body"].clone();
        assert!(
            body.as_str().is_some_and(
                |body| body.starts_with("What this does.\n\n<!-- claude-review-section -->\n")
            ),
            "{body}"
        );
        assert!(test.outputs().contains("summary=written\n"));
    }

    #[test]
    fn warns_when_greptile_did_not_connect() {
        for (greptile, warning) in [
            (
                Some("failed"),
                Some("Greptile's MCP server did not connect: failed."),
            ),
            (Some("connected"), None),
            // Without a key, no agent starts the server.
            (None, None),
        ] {
            let (test, result) = post(&review(json!([]), json!([])), &github(|_| None), greptile);
            result.expect("the step");
            let log = test.log();
            match warning {
                Some(warning) => assert!(log.contains(warning), "{greptile:?}: {log}"),
                None => assert!(!log.contains("Greptile"), "{greptile:?}: {log}"),
            }
        }
    }

    #[test]
    fn removes_every_secret_from_every_string() {
        let secrets = [
            "sk-ant-api-0123456789".to_owned(),
            "sk-ant-oat-abcdefghij".into(),
            "greptile-key-0123".into(),
            "ghs_token0123456789".into(),
        ];
        let document = json!({
            "summary": format!("start {} middle {}end", secrets[3], secrets[3]),
            "comments": [{"body": secrets[0], "line": 3}],
            "replies": [{"answer": format!("key={}{}", secrets[2], secrets[1])}],
            "partial": false,
        });
        assert_eq!(
            redact(document, &secrets),
            json!({
                "summary": "start [redacted] middle [redacted]end",
                "comments": [{"body": "[redacted]", "line": 3}],
                "replies": [{"answer": "key=[redacted][redacted]"}],
                "partial": false,
            })
        );
        // Without secrets, or with a value too short to be one, text stays.
        let document = json!({"summary": "No blocking issues", "comments": [], "replies": []});
        assert_eq!(redact(document.clone(), &[]), document);
        assert_eq!(
            redact(document.clone(), &["issues".into(), String::new()]),
            document
        );
    }
}
