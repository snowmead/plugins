//! The marker that ends the body of each review the job submits: the commit
//! the review covered, whether it was partial, and the findings only the
//! summary holds, for the next review to read; and the one that ends an
//! answer in a review thread.
//!
//! The marker is `<!-- claude-review-summary {json} -->`, with `<` and `>` in
//! the JSON escaped so no text in it can end the HTML comment early. The post
//! step writes it last, so the last one in a body is the job's own; text
//! above it, such as a quoted marker, can hold others.

use serde_json::{
    Value,
    json, //
};

/// What opens the marker, up to its JSON.
pub(crate) const OPENING: &str = "<!-- claude-review-summary ";

/// What closes the marker.
const CLOSING: &str = " -->";

/// What ends a reply in a review thread that holds only an answer. The job's
/// other replies hold its "Fixed" line, so a later review tells the two apart
/// by this, whatever the answer says.
pub(crate) const ANSWER: &str = "<!-- claude-review-answer -->";

/// The marker of the last review, whose body is `review`: `{}` when there is
/// no earlier review, the marker's fields when it reads, and
/// `{unreadable: true}` when it does not.
pub(crate) fn read(review: Option<&str>) -> Value {
    let Some(body) = review else {
        return json!({});
    };
    match last_marker(body).and_then(|text| serde_json::from_str::<Value>(text).ok()) {
        Some(Value::Object(fields)) => Value::Object(fields),
        _ => json!({ "unreadable": true }),
    }
}

/// The marker line for `marker`.
pub(crate) fn write(marker: &Value) -> String {
    let json = marker
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    format!("{OPENING}{json}{CLOSING}")
}

/// The JSON of the last marker in `body`: the shortest `{...}` on one line
/// after [`OPENING`] that [`CLOSING`] follows, matched from the start of the
/// body without overlap.
///
/// [`OPENING`]: crate::marker::OPENING
/// [`CLOSING`]: crate::marker::CLOSING
fn last_marker(body: &str) -> Option<&str> {
    let mut found = None;
    let mut from = 0;
    while let Some(offset) = body[from..].find(OPENING) {
        let start = from + offset + OPENING.len();
        from = start;
        if !body[start..].starts_with('{') {
            continue;
        }
        let line = body[start..].split('\n').next().unwrap_or_default();
        let matched = line
            .match_indices('}')
            .map(|(index, _)| index)
            .find(|index| line[index + 1..].starts_with(CLOSING));
        if let Some(end) = matched {
            found = Some(&body[start..=start + end]);
            from = start + end + 1 + CLOSING.len();
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::{
        read,
        write, //
    };
    use serde_json::json;

    #[test]
    fn reads_the_last_marker_and_keeps_text_that_looks_like_one() {
        // A finding's title can hold the end of an HTML comment, or what looks
        // like a marker; the escaping keeps both inside the marker.
        let carried =
            json!([{"title": "kept <b>, then --> and <!-- claude-review-summary {} -->"}]);
        let marker = json!({"head": "abc", "partial": false, "carried": carried});
        let body = format!(
            "Quoting an older one:\n> <!-- claude-review-summary {{\"head\":\"old\"}} -->\n\n{}",
            write(&marker)
        );
        assert_eq!(read(Some(&body)), marker);
    }

    #[test]
    fn says_when_there_is_no_marker_to_read() {
        assert_eq!(read(None), json!({}));
        for body in [
            "<!-- claude-review-summary {\"head\": --> -->",
            "## Claude review\nno marker",
            "<!-- claude-review-summary [1] -->",
        ] {
            assert_eq!(read(Some(body)), json!({"unreadable": true}), "{body}");
        }
    }
}
