//! A GitHub for tests: it records every call and answers from the test's
//! handler, which can refuse a call as GitHub would.

use super::{
    GitHub,
    Method, //
};
use crate::error::Error;
use serde_json::{
    Value,
    json, //
};
use std::cell::RefCell;

/// What kind of call a step made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// A REST read.
    Get,
    /// A REST create.
    Post,
    /// A REST update.
    Patch,
    /// A read of every page of a REST list.
    Pages,
    /// A GraphQL query or mutation.
    GraphQl,
}

/// One call a step made.
#[derive(Clone, Debug)]
pub(crate) struct Call {
    /// Its kind.
    pub(crate) kind: Kind,
    /// The route under the API root; the query text of a GraphQL call.
    pub(crate) path: String,
    /// The JSON body; the variables of a GraphQL call.
    pub(crate) body: Option<Value>,
}

impl Call {
    /// Whether this is the GraphQL query or mutation whose field is `name`.
    pub(crate) fn named(&self, name: &str) -> bool {
        self.kind == Kind::GraphQl && self.path.contains(&format!("{name}("))
    }
}

/// The test's answer to a call.
type Handler = Box<dyn Fn(&Call) -> Result<Value, Error>>;

/// A GitHub that answers from a handler and keeps the calls.
pub(crate) struct FakeGitHub {
    /// The calls so far, in order.
    calls: RefCell<Vec<Call>>,
    /// The answer to each call; a list call answers with an array.
    handler: Handler,
}

impl FakeGitHub {
    /// A GitHub that answers each call with `handler`.
    pub(crate) fn new(handler: impl Fn(&Call) -> Result<Value, Error> + 'static) -> Self {
        Self {
            calls: RefCell::new(Vec::new()),
            handler: Box::new(handler),
        }
    }

    /// The calls so far, in order.
    pub(crate) fn calls(&self) -> Vec<Call> {
        self.calls.borrow().clone()
    }

    /// The calls of `kind` so far, in order.
    pub(crate) fn calls_of(&self, kind: Kind) -> Vec<Call> {
        self.calls()
            .into_iter()
            .filter(|call| call.kind == kind)
            .collect()
    }

    /// Records a call and answers it.
    fn answer(&self, kind: Kind, path: &str, body: Option<&Value>) -> Result<Value, Error> {
        let call = Call {
            kind,
            path: path.into(),
            body: body.cloned(),
        };
        let reply = (self.handler)(&call);
        self.calls.borrow_mut().push(call);
        reply
    }
}

impl GitHub for FakeGitHub {
    fn rest(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value, Error> {
        let kind = match method {
            Method::Get => Kind::Get,
            Method::Post => Kind::Post,
            Method::Patch => Kind::Patch,
        };
        self.answer(kind, path, body)
    }

    fn rest_pages(&self, path: &str) -> Result<Vec<Value>, Error> {
        match self.answer(Kind::Pages, path, None)? {
            Value::Array(items) => Ok(items),
            other => panic!("a list call answers with an array, not {other}"),
        }
    }

    fn graphql(&self, query: &str, variables: &Value) -> Result<Value, Error> {
        self.answer(Kind::GraphQl, query, Some(variables))
    }
}

/// The errors GitHub answers a GraphQL request with when it refuses it.
pub(crate) fn refused() -> Error {
    Error::GraphQl {
        detail: "Path could not be resolved".into(),
    }
}

/// A failure after which GitHub may have done what the request asked.
pub(crate) fn bad_gateway() -> Error {
    Error::GitHub {
        request: "GraphQL".into(),
        detail: "HTTP 502: Bad Gateway".into(),
        status: Some(502),
    }
}

/// What GitHub answers the post step with when it takes every call: pull
/// request `PR` with no pending review, the new review `R`, a thread whose
/// comment's URL names its path and line (`file` for one on its file), and an
/// empty description.
pub(crate) fn posting(call: &Call) -> Result<Value, Error> {
    let variables = call.body.clone().unwrap_or_default();
    if call.named("pullRequest") {
        return Ok(json!({"repository": {"pullRequest": {"id": "PR", "reviews": {"nodes": []}}}}));
    }
    if call.named("addPullRequestReview") {
        return Ok(json!({"addPullRequestReview": {"pullRequestReview": {"id": "R"}}}));
    }
    if call.named("addPullRequestReviewThread") {
        let input = &variables["input"];
        let url = format!(
            "https://x/{}#{}",
            input["path"].as_str().unwrap_or_default(),
            input["line"]
                .as_u64()
                .map_or_else(|| "file".to_owned(), |line| line.to_string())
        );
        return Ok(
            json!({"addPullRequestReviewThread": {"thread": {"id": "TH", "comments": {"nodes": [{"url": url}]}}}}),
        );
    }
    match call.kind {
        Kind::Get => Ok(json!({"body": null})),
        Kind::Pages => Ok(json!([])),
        Kind::Post | Kind::Patch | Kind::GraphQl => Ok(json!({})),
    }
}
