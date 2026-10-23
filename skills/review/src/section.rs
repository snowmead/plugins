//! The job's section of the pull request description: the summary of the last
//! review, between two markers, below the author's text.
//!
//! The author can edit the description, so the job changes only the text
//! between its markers, and keeps nothing there that a later review relies
//! on: the marker the next review reads ends the review's body instead
//! ([`marker`]). Text in the section that reads as one of the markers is
//! escaped, so nothing the review wrote can end the section early.
//!
//! [`marker`]: crate::marker

use std::ops::Range;

/// The most bytes the job lets a pull request description hold: GitHub keeps
/// 65,536 characters, and bytes are never fewer than characters or the UTF-16
/// units GitHub may count.
pub(crate) const LIMIT: usize = 65_536;

/// What opens the section.
const OPENING: &str = "<!-- claude-review-section -->";

/// What closes the section.
const CLOSING: &str = "<!-- /claude-review-section -->";

/// The text of the job's section in the description `body`, without its
/// markers; `None` when the description has no section.
pub(crate) fn find(body: &str) -> Option<&str> {
    scan(body)
        .section
        .map(|range| body[range.start + OPENING.len()..range.end - CLOSING.len()].trim())
}

/// The description `body` with `text` as the job's section: in place of the
/// section it has, or after the author's text. A code block the author's
/// text leaves open would hold the section, so the job closes it first.
pub(crate) fn replace(body: &str, text: &str) -> String {
    let text = text
        .trim()
        .replace(OPENING, "&lt;!-- claude-review-section -->")
        .replace(CLOSING, "&lt;!-- /claude-review-section -->");
    let section = format!("{OPENING}\n{text}\n{CLOSING}");
    let found = scan(body);
    match (found.section, found.fence) {
        (Some(range), _) => format!("{}{section}{}", &body[..range.start], &body[range.end..]),
        (None, _) if body.trim().is_empty() => section,
        (None, Some(open)) => format!(
            "{}\n{}\n\n{section}",
            body.trim_end(),
            open.mark.to_string().repeat(open.length)
        ),
        (None, None) => format!("{}\n\n{section}", body.trim_end()),
    }
}

/// The description `body` without the job's section.
pub(crate) fn without(body: &str) -> String {
    match scan(body).section {
        Some(range) => format!("{}{}", body[..range.start].trim_end(), &body[range.end..]),
        None => body.to_owned(),
    }
}

/// What a scan of a description found.
struct Scan {
    /// Where the job's section is, markers included.
    section: Option<Range<usize>>,
    /// The code block the description leaves open at its end, outside the
    /// section.
    fence: Option<Fence>,
}

/// Where the job's section is in `body`, markers included: from an opening
/// marker on a line of its own outside a fenced code block, to the first
/// closing marker on a line of its own after it; the last such pair when there
/// are more. A marker an author quotes in a sentence, a quote, or a code block
/// is on no line of its own outside a code block, so it is never taken for the
/// section. An opening marker inside an open section starts the section again:
/// the job escapes the markers in its own text, so that one is a section that
/// lost its closing marker.
fn scan(body: &str) -> Scan {
    let mut section = None;
    let mut opened = None;
    let mut fence = None;
    let mut start = 0;
    for line in body.split_inclusive('\n') {
        let text = line.trim_end_matches(['\n', '\r']);
        if let Some(open) = opened {
            // The section's own code blocks are its own: only the markers
            // count.
            if text == CLOSING {
                section = Some(open..start + text.len());
                opened = None;
            } else if text == OPENING {
                opened = Some(start);
            }
        } else if let Some(open) = fence {
            if fence_of(text).is_some_and(|close: Fence| close.closes(open)) {
                fence = None;
            }
        } else if text == OPENING {
            opened = Some(start);
        } else {
            fence = fence_of(text);
        }
        start += line.len();
    }
    Scan { section, fence }
}

/// A line of backticks or tildes that opens or closes a fenced code block.
#[derive(Clone, Copy)]
struct Fence {
    /// The character it repeats.
    mark: char,
    /// How many times, at least three.
    length: usize,
    /// Whether text follows it, as an info string does after an opening fence.
    text: bool,
}

impl Fence {
    /// Whether this fence closes the block `open` opened: the same character,
    /// at least as many, and nothing after it.
    fn closes(self, open: Self) -> bool {
        self.mark == open.mark && self.length >= open.length && !self.text
    }
}

/// The fence `line` holds: three or more backticks or tildes after at most
/// three spaces. A backtick in the text after backticks makes the line inline
/// code, such as ```` ```foo``` ````, not a fence.
fn fence_of(line: &str) -> Option<Fence> {
    let rest = line.trim_start_matches(' ');
    let mark = rest
        .chars()
        .next()
        .filter(|mark| ['`', '~'].contains(mark))?;
    let length = rest.chars().take_while(|char| *char == mark).count();
    let after = &rest[length * mark.len_utf8()..];
    let inline = mark == '`' && after.contains('`');
    (line.len() - rest.len() <= 3 && length >= 3 && !inline).then(|| Fence {
        mark,
        length,
        text: !after.trim().is_empty(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        find,
        replace,
        without, //
    };

    #[test]
    fn the_section_follows_the_authors_text_and_replaces_only_itself() {
        let first = replace("What this does.\r\n\r\n", "## Claude review\n\nOld.");
        assert_eq!(
            first,
            "What this does.\n\n<!-- claude-review-section -->\n## Claude review\n\nOld.\n<!-- /claude-review-section -->"
        );
        // The author added a line above the section and one below it.
        let edited = format!("Now with a video.\n\n{first}\n\nA note after.");
        let second = replace(&edited, "## Claude review\n\nNew.");
        assert_eq!(
            second,
            "Now with a video.\n\nWhat this does.\n\n<!-- claude-review-section -->\n## Claude review\n\nNew.\n<!-- /claude-review-section -->\n\nA note after."
        );
        assert_eq!(find(&second), Some("## Claude review\n\nNew."));
        assert_eq!(
            without(&second),
            "Now with a video.\n\nWhat this does.\n\nA note after."
        );
        assert_eq!(
            replace("", "s"),
            "<!-- claude-review-section -->\ns\n<!-- /claude-review-section -->"
        );
        assert_eq!(find("No section."), None);
        assert_eq!(without("No section."), "No section.");
    }

    #[test]
    fn a_description_saved_with_crlf_line_endings_keeps_one_section() {
        // GitHub's editor saves a description with CRLF line endings.
        let body = format!("{}\n\nA note after.\n", replace("What this does.", "Old."))
            .replace('\n', "\r\n");
        assert_eq!(find(&body), Some("Old."));
        let next = replace(&body, "New.");
        assert_eq!(
            next,
            "What this does.\r\n\r\n<!-- claude-review-section -->\nNew.\n<!-- /claude-review-section -->\r\n\r\nA note after.\r\n"
        );
        assert_eq!(without(&next), "What this does.\r\n\r\nA note after.\r\n");
    }

    #[test]
    fn text_in_the_section_cannot_end_it_early() {
        // A finding's title can quote the closing marker.
        let body = replace(
            "Intro.",
            "Title <!-- /claude-review-section --> and <!-- claude-review-section --> end.",
        );
        let section = find(&body).expect("the section");
        assert_eq!(
            section,
            "Title &lt;!-- /claude-review-section --> and &lt;!-- claude-review-section --> end."
        );
        // The next review replaces all of it, and nothing of it is left behind.
        assert_eq!(
            replace(&body, "New."),
            "Intro.\n\n<!-- claude-review-section -->\nNew.\n<!-- /claude-review-section -->"
        );
        // An author's quote of the opening marker above the section does not
        // move it.
        let quoted = format!("Quoting <!-- claude-review-section --> here.\n\n{body}");
        assert!(
            replace(&quoted, "New.")
                .starts_with("Quoting <!-- claude-review-section --> here.\n\n"),
            "{quoted}"
        );
    }

    #[test]
    fn markers_an_author_quotes_are_not_the_section() {
        let sentence = "It sits between `<!-- claude-review-section -->` and \
                        `<!-- /claude-review-section -->`.";
        let fenced = "For example:\n\n```markdown\n<!-- claude-review-section -->\nSummary.\n\
                      <!-- /claude-review-section -->\n```";
        let quoted =
            "> <!-- claude-review-section -->\n> Summary.\n> <!-- /claude-review-section -->";
        for author in [sentence, fenced, quoted] {
            assert_eq!(find(author), None, "{author}");
            assert_eq!(without(author), author);
            // The first review adds its section after the author's text, and
            // the next one replaces only that.
            let first = replace(author, "Old.");
            assert_eq!(
                first,
                format!(
                    "{author}\n\n<!-- claude-review-section -->\nOld.\n<!-- /claude-review-section -->"
                )
            );
            assert_eq!(find(&first), Some("Old."));
            assert_eq!(
                replace(&first, "New."),
                format!(
                    "{author}\n\n<!-- claude-review-section -->\nNew.\n<!-- /claude-review-section -->"
                )
            );
        }
        // A line of inline code opens no fence, so the section after it is
        // still found, and replaced rather than added again.
        let inline = replace("Run ```just lint``` first.\n```foo```", "Old.");
        assert_eq!(find(&inline), Some("Old."));
        assert_eq!(
            replace(&inline, "New.")
                .matches("<!-- claude-review-section -->")
                .count(),
            1
        );
        // A fence in the section, such as the diagram's, is the section's own.
        let body = replace("Intro.", "```mermaid\nflowchart LR\n```\nAfter.");
        assert_eq!(find(&replace(&body, "New.")), Some("New."), "{body}");
    }

    #[test]
    fn the_author_s_code_blocks_never_hide_or_eat_the_section() {
        let section = "<!-- claude-review-section -->\nx\n<!-- /claude-review-section -->";
        // (author's text, the fence the job adds to close a block it left open)
        for (author, closer) in [
            // Unclosed, by the author or by a closer of another kind, length,
            // or with text after it.
            ("```\ncode", Some("```")),
            ("~~~\ncode", Some("~~~")),
            ("```\ncode\n~~~", Some("```")),
            ("````\ncode\n```", Some("````")),
            ("```\ncode\n``` js", Some("```")),
            // Closed, with the markers inside as an example.
            (&format!("~~~\n{section}\n~~~") as &str, None),
            (&format!("````\n```\n{section}\n````") as &str, None),
            // A fence after three spaces opens a block; after four it is code.
            (&format!("   ```\n{section}\n   ```") as &str, None),
            (&format!("    ```\n    {section}") as &str, None),
            // Line endings from a description edited on GitHub.
            ("Intro.\r\n\r\n```\r\ncode\r\n```\r\n", None),
        ] {
            assert_eq!(find(author), None, "{author}");
            let first = replace(author, "Old.");
            let added = closer
                .map(|closer| format!("\n{closer}"))
                .unwrap_or_default();
            assert!(
                first.starts_with(&format!(
                    "{}{added}\n\n<!-- claude-review-section -->\n",
                    author.trim_end()
                )),
                "{author}: {first}"
            );
            assert_eq!(find(&first), Some("Old."), "{author}");
            let second = replace(&first, "New.");
            assert_eq!(find(&second), Some("New."), "{author}");
            assert_eq!(
                second.matches("<!-- claude-review-section -->").count(),
                1 + author.matches("<!-- claude-review-section -->").count(),
                "{author}"
            );
        }
    }

    #[test]
    fn a_section_that_lost_its_closing_marker_keeps_the_text_below_it() {
        // The author deleted the closing line, so the next review adds a new
        // section; the one after that replaces only the new one.
        let body = "A\n\n<!-- claude-review-section -->\nold\n\nB";
        let first = replace(body, "New.");
        assert_eq!(find(&first), Some("New."));
        let second = replace(&first, "Newer.");
        assert!(second.starts_with(&format!("{body}\n\n")), "{second}");
        assert_eq!(find(&second), Some("Newer."));
        assert_eq!(without(&second), body);
    }
}
