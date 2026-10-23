//! The unfinished step: a review that did not finish, or whose summary was
//! not written, says so at the top of the job's section of the pull request
//! description, so the pull request does not show an older review as current.
//! The last submitted review's marker keeps the last complete review's
//! commit; a pull request without one gets a full review next time.

use crate::{
    error::Error,
    github::{
        GitHub,
        Method, //
    },
    id::Repository,
    section,
    state::Pull, //
};
use serde_json::json;

/// What opens the notice.
const OPENING: &str = "<!-- claude-review-unfinished -->";

/// What closes it.
const CLOSING: &str = "<!-- /claude-review-unfinished -->";

/// What the unfinished step reads.
pub(crate) struct Unfinished<'a> {
    /// GitHub, with the job's token.
    pub(crate) github: &'a dyn GitHub,
    /// The repository.
    pub(crate) repo: &'a Repository,
    /// The pull request.
    pub(crate) pull: &'a Pull,
    /// The run's page.
    pub(crate) run_url: &'a str,
}

impl Unfinished<'_> {
    /// Puts the notice at the top of the section, in place of an older one,
    /// or makes a section that holds only the notice; the notice alone, too,
    /// when the description has no room for the old summary under it. With
    /// no room even for the notice, the old section goes, so the description
    /// shows no older review as current.
    pub(crate) fn run(&self) -> Result<(), Error> {
        let short: String = self.pull.head.as_str().chars().take(7).collect();
        let notice = format!(
            "{OPENING}\n> [!WARNING]\n> The review of `{short}` did not finish ([run]({})). Run the job again to review \
             this commit.\n{CLOSING}",
            self.run_url
        );
        let path = format!("repos/{}/pulls/{}", self.repo, self.pull.number);
        let pull = self.github.rest(Method::Get, &path, None)?;
        let body = pull["body"].as_str().unwrap_or_default();
        let text = match section::find(body).map(without_notice) {
            Some(rest) if !rest.is_empty() => format!("{notice}\n\n{rest}"),
            _ => notice.clone(),
        };
        let fits = |text: &str| {
            Some(section::replace(body, text)).filter(|written| written.len() <= section::LIMIT)
        };
        let written = fits(&text)
            .or_else(|| fits(&notice))
            .unwrap_or_else(|| section::without(body));
        let body = json!({ "body": written });
        self.github.rest(Method::Patch, &path, Some(&body))?;
        Ok(())
    }
}

/// `text` without its first notice and the whitespace after it.
fn without_notice(text: &str) -> String {
    let Some(start) = text.find(OPENING) else {
        return text.to_owned();
    };
    let Some(length) = text[start..].find(CLOSING) else {
        return text.to_owned();
    };
    let end = start + length + CLOSING.len();
    let rest = text[end..].trim_start();
    format!("{}{rest}", &text[..start])
}

#[cfg(test)]
mod tests {
    use super::Unfinished;
    use crate::{
        github::fake::{
            FakeGitHub,
            Kind, //
        },
        section,
        state::Pull, //
    };
    use serde_json::{
        Value,
        json, //
    };

    /// The description the step writes over `description`.
    fn written(description: Value) -> String {
        let github = FakeGitHub::new(move |call| match call.kind {
            Kind::Get => Ok(json!({ "body": description })),
            Kind::Post | Kind::Patch | Kind::Pages | Kind::GraphQl => Ok(json!({})),
        });
        let pull = Pull {
            number: 5.into(),
            head: "e".repeat(40).try_into().expect("a commit"),
            base: "main".into(),
            default_branch: "main".into(),
            last_review: None,
        };
        Unfinished {
            github: &github,
            repo: &"o/r".parse().expect("a repository"),
            pull: &pull,
            run_url: "https://x/runs/1",
        }
        .run()
        .expect("the step");
        let [patch] = github.calls_of(Kind::Patch).try_into().expect("one write");
        assert_eq!(patch.path, "repos/o/r/pulls/5");
        patch
            .body
            .and_then(|body| body["body"].as_str().map(str::to_owned))
            .expect("a description")
    }

    #[test]
    fn an_unfinished_review_says_so_at_the_top_of_the_last_summary() {
        let old = "<!-- claude-review-unfinished -->\n> an older notice\n<!-- /claude-review-unfinished -->\n\n";
        let last = "## Claude review · Confidence to merge: 4/5\n\nOld findings.";
        let description = section::replace("What this does.", &format!("{old}{last}"));
        let text = written(json!(description));
        assert!(text.starts_with("What this does.\n\n"), "{text}");
        let section = section::find(&text).expect("the section");
        assert!(
            section.starts_with(
                "<!-- claude-review-unfinished -->\n> [!WARNING]\n> The review of `eeeeeee`"
            ),
            "{section}"
        );
        assert!(section.contains("([run](https://x/runs/1))"));
        assert!(!section.contains("an older notice"));
        assert!(section.ends_with(last));
    }

    #[test]
    fn without_a_summary_the_notice_is_the_whole_section() {
        for description in [json!(null), json!("What this does.")] {
            let text = written(description.clone());
            let section = section::find(&text).expect("the section");
            assert!(
                section.starts_with("<!-- claude-review-unfinished -->\n")
                    && section.ends_with("<!-- /claude-review-unfinished -->"),
                "{description}: {section}"
            );
        }
    }

    #[test]
    fn a_notice_with_no_room_for_the_old_summary_replaces_it() {
        let description = section::replace(
            &"a".repeat(65_000),
            &format!("## Claude review\n\n{}", "o".repeat(400)),
        );
        let text = written(json!(description));
        assert!(text.len() <= section::LIMIT, "{}", text.len());
        let section = section::find(&text).expect("the section");
        assert!(
            section.starts_with("<!-- claude-review-unfinished -->\n")
                && section.ends_with("<!-- /claude-review-unfinished -->"),
            "{section}"
        );
    }

    #[test]
    fn a_description_with_no_room_for_the_notice_loses_the_old_summary() {
        let author = "a".repeat(65_400);
        let description = section::replace(&author, "## Claude review\n\nOld findings.");
        assert!(description.len() <= section::LIMIT, "{}", description.len());
        assert_eq!(written(json!(description)), author);
    }
}
