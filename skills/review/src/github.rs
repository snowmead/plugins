//! GitHub's REST and GraphQL APIs, as the review's steps read the pull request
//! and post its review.
//!
//! The steps talk to GitHub through the [`GitHub`] trait. [`Http`] sends the
//! requests with the job's token; tests answer them with `fake::FakeGitHub`.
//!
//! [`GitHub`]: crate::github::GitHub
//! [`Http`]: crate::github::Http

#[cfg(test)]
pub(crate) mod fake;

use crate::{
    actions::var,
    error::Error, //
};
use serde_json::{
    Value,
    json, //
};
use std::{
    thread,
    time::Duration, //
};
use ureq::{
    RequestBuilder,
    typestate::WithBody, //
};

/// How many times a read is tried before its failure counts.
const ATTEMPTS: u32 = 3;

/// How long one request may take.
const TIMEOUT: Duration = Duration::from_secs(60);

/// The REST methods the steps use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Method {
    /// Reads.
    Get,
    /// Sends a GraphQL request.
    Post,
    /// Replaces a pull request's description.
    Patch,
}

/// What a request does to GitHub, which decides whether a failure is tried
/// again.
#[derive(Clone, Copy)]
enum Effect {
    /// It only reads, so one that fails in transport or with a server error
    /// is tried again.
    Read,
    /// It writes, so it is sent once: GitHub may have taken one that failed,
    /// and sending it again would post it twice.
    Write,
}

/// The API calls the steps make.
pub(crate) trait GitHub {
    /// Sends a REST request to `path` under the API root, with `body` as its
    /// JSON, and returns the response's JSON (`null` when it has none).
    fn rest(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value, Error>;

    /// Reads every page of the REST list at `path` and returns their items.
    fn rest_pages(&self, path: &str) -> Result<Vec<Value>, Error>;

    /// Runs a GraphQL query or mutation and returns its `data`.
    fn graphql(&self, query: &str, variables: &Value) -> Result<Value, Error>;
}

/// The GitHub API, reached with the job's token.
pub(crate) struct Http {
    /// The HTTP client.
    agent: ureq::Agent,
    /// The REST root, `https://api.github.com` on github.com.
    api: String,
    /// The GraphQL endpoint.
    graphql: String,
    /// The token (`GH_TOKEN`).
    token: String,
}

impl Http {
    /// The API the runner names (`GITHUB_API_URL`, `GITHUB_GRAPHQL_URL`), with
    /// the token in `GH_TOKEN`.
    pub(crate) fn from_env() -> Result<Self, Error> {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .user_agent("claude-review")
            .build();
        Ok(Self {
            agent: config.into(),
            api: std::env::var("GITHUB_API_URL")
                .unwrap_or_else(|_| "https://api.github.com".into()),
            graphql: std::env::var("GITHUB_GRAPHQL_URL")
                .unwrap_or_else(|_| "https://api.github.com/graphql".into()),
            token: var("GH_TOKEN")?,
        })
    }

    /// Sends one request and returns its status, `Link` header, and body.
    fn send(&self, method: Method, url: &str, body: Option<&Value>) -> Result<Reply, ureq::Error> {
        let send_json = |request: RequestBuilder<WithBody>| {
            self.authorized(request)
                .content_type("application/json")
                .send(body.unwrap_or(&Value::Null).to_string())
        };
        let mut response = match method {
            Method::Get => self.authorized(self.agent.get(url)).call(),
            Method::Post => send_json(self.agent.post(url)),
            Method::Patch => send_json(self.agent.patch(url)),
        }?;
        let status = response.status().as_u16();
        let link = response
            .headers()
            .get("link")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let text = response.body_mut().read_to_string()?;
        Ok(Reply { status, link, text })
    }

    /// `request` with the job's token and the API version it speaks.
    fn authorized<B>(&self, request: RequestBuilder<B>) -> RequestBuilder<B> {
        request
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
    }

    /// Sends a request, retrying a read that fails in transport or with a
    /// server error, and returns the reply of a 2xx status.
    fn request(
        &self,
        method: Method,
        url: &str,
        body: Option<&Value>,
        effect: Effect,
    ) -> Result<Reply, Error> {
        let label = format!("{} {url}", method.name());
        let mut failure = String::new();
        let mut status = None;
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                thread::sleep(Duration::from_secs(2 << attempt));
            }
            match self.send(method, url, body) {
                Ok(reply) if (200..300).contains(&reply.status) => return Ok(reply),
                Ok(reply) => {
                    failure = format!("HTTP {}: {}", reply.status, excerpt(&reply.text));
                    status = Some(reply.status);
                    if reply.status < 500 || !effect.retries() {
                        break;
                    }
                }
                Err(error) => {
                    failure = error.to_string();
                    status = None;
                    if !effect.retries() {
                        break;
                    }
                }
            }
        }
        Err(Error::GitHub {
            request: label,
            detail: failure,
            status,
        })
    }
}

impl GitHub for Http {
    fn rest(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value, Error> {
        let url = format!("{}/{path}", self.api);
        let reply = self.request(method, &url, body, method.effect())?;
        parse(&reply.text, &url)
    }

    fn rest_pages(&self, path: &str) -> Result<Vec<Value>, Error> {
        let separator = if path.contains('?') { '&' } else { '?' };
        let mut url = Some(format!("{}/{path}{separator}per_page=100", self.api));
        let mut items = Vec::new();
        while let Some(page) = url.take() {
            let reply = self.request(Method::Get, &page, None, Effect::Read)?;
            match parse(&reply.text, &page)? {
                Value::Array(values) => items.extend(values),
                other => {
                    return Err(Error::GitHub {
                        request: format!("GET {page}"),
                        detail: format!("expected a list, got {}", excerpt(&other.to_string())),
                        status: None,
                    });
                }
            }
            url = reply.link.as_deref().and_then(next_page);
        }
        Ok(items)
    }

    fn graphql(&self, query: &str, variables: &Value) -> Result<Value, Error> {
        let body = json!({ "query": query, "variables": variables });
        // A mutation is not retried, so a reply is never posted twice.
        let effect = if query.trim_start().starts_with("mutation") {
            Effect::Write
        } else {
            Effect::Read
        };
        let reply = self.request(Method::Post, &self.graphql, Some(&body), effect)?;
        let mut response = parse(&reply.text, &self.graphql)?;
        let data = response.get_mut("data").map_or(Value::Null, Value::take);
        let Some(errors) = response
            .get("errors")
            .and_then(Value::as_array)
            .filter(|errors| !errors.is_empty())
        else {
            return Ok(data);
        };
        let messages: Vec<&str> = errors
            .iter()
            .filter_map(|error| error.get("message").and_then(Value::as_str))
            .collect();
        let detail = messages.join("; ");
        // An error inside a mutation's result comes after GitHub did the
        // mutation, as when it adds a thread but fails on its comment's URL.
        // A read with any error is not read.
        let inside = |error: &Value| {
            error
                .get("path")
                .and_then(Value::as_array)
                .is_some_and(|path| path.len() > 1)
        };
        match effect {
            Effect::Write if errors.iter().all(inside) => {
                Err(Error::GraphQlPartial { detail, data })
            }
            Effect::Write | Effect::Read => Err(Error::GraphQl { detail }),
        }
    }
}

impl Method {
    /// The method's name in an HTTP request.
    fn name(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Patch => "PATCH",
        }
    }

    /// What a request with this method does to GitHub.
    fn effect(self) -> Effect {
        match self {
            Self::Get => Effect::Read,
            Self::Post | Self::Patch => Effect::Write,
        }
    }
}

impl Effect {
    /// Whether a request that fails in transport or with a server error is
    /// tried again.
    fn retries(self) -> bool {
        match self {
            Self::Read => true,
            Self::Write => false,
        }
    }
}

/// A response's status, `Link` header, and body.
struct Reply {
    /// The HTTP status.
    status: u16,
    /// The `Link` header, which names the next page of a list.
    link: Option<String>,
    /// The body.
    text: String,
}

/// `login` without the `[bot]` an app's login ends with, as the review names
/// every author, itself included.
pub(crate) fn without_bot(login: &str) -> &str {
    login.strip_suffix("[bot]").unwrap_or(login)
}

/// The login of a REST `user`, without the `[bot]` an app's carries; empty
/// when the user has none.
pub(crate) fn login(user: &Value) -> &str {
    without_bot(user["login"].as_str().unwrap_or_default())
}

/// Every node of the GraphQL connection at `connection` (a path of field names
/// under `data`), following its pages. `query` takes the connection's cursor
/// as `$cursor` and asks for `pageInfo { hasNextPage endCursor }` and `nodes`.
pub(crate) fn nodes(
    github: &dyn GitHub,
    query: &str,
    mut variables: Value,
    connection: &[&str],
) -> Result<Vec<Value>, Error> {
    let mut nodes = Vec::new();
    loop {
        let mut data = github.graphql(query, &variables)?;
        let page = connection
            .iter()
            .try_fold(&mut data, |value, field| value.get_mut(field))
            .ok_or_else(|| Error::GitHub {
                request: "GraphQL".into(),
                detail: format!("the response has no {}", connection.join(".")),
                status: None,
            })?;
        if let Some(Value::Array(found)) = page.get_mut("nodes").map(Value::take) {
            nodes.extend(found);
        }
        let info = &page["pageInfo"];
        match (info["hasNextPage"].as_bool(), info["endCursor"].as_str()) {
            (Some(true), Some(cursor)) => variables["cursor"] = json!(cursor),
            _ => return Ok(nodes),
        }
    }
}

/// The next page's URL in a `Link` header.
fn next_page(link: &str) -> Option<String> {
    link.split(',').find_map(|part| {
        let (target, params) = part.split_once(';')?;
        params
            .split(';')
            .any(|param| param.trim() == "rel=\"next\"")
            .then(|| {
                target
                    .trim()
                    .trim_start_matches('<')
                    .trim_end_matches('>')
                    .to_owned()
            })
    })
}

/// The JSON of a response body from `url`; `null` for an empty body.
fn parse(text: &str, url: &str) -> Result<Value, Error> {
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text).map_err(|error| Error::GitHub {
        request: url.into(),
        detail: format!("the response is not JSON: {error}"),
        status: None,
    })
}

/// The start of a response, for an error message.
fn excerpt(text: &str) -> String {
    text.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        GitHub,
        Http,
        Method,
        next_page, //
    };
    use crate::error::Error;
    use serde_json::json;
    use std::{
        io::{
            BufRead,
            BufReader,
            Read,
            Write, //
        },
        net::TcpListener,
        sync::{
            Arc,
            Mutex, //
        },
        thread,
    };

    /// A local server that answers its requests with `replies` (a status and
    /// a JSON body) in turn, one connection each, and the client that reaches
    /// it. The list holds the first line of each request it got.
    fn server(replies: &[(u16, &'static str)]) -> (Http, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
        let root = format!("http://{}", listener.local_addr().expect("an address"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let replies = replies.to_vec();
        thread::spawn(move || {
            for (status, answer) in replies {
                let (stream, _) = listener.accept().expect("a request");
                let mut reader = BufReader::new(stream);
                let mut length = 0;
                let mut first = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("a header");
                    if line.trim().is_empty() {
                        break;
                    }
                    if first.is_empty() {
                        first = line.trim().to_owned();
                    }
                    if let Some((name, value)) = line.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse().expect("a length");
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).expect("the body");
                seen.lock().expect("the list").push(first);
                let reply = format!(
                    "HTTP/1.1 {status} S\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                reader
                    .get_mut()
                    .write_all(reply.as_bytes())
                    .expect("the reply");
            }
        });
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .proxy(None)
            .build()
            .into();
        let http = Http {
            agent,
            graphql: format!("{root}/graphql"),
            api: root,
            token: "t".into(),
        };
        (http, requests)
    }

    #[test]
    fn retries_a_read_that_meets_a_server_error_and_never_a_write() {
        // A description or a reply that failed may still have been written,
        // so a write is sent once.
        let (github, requests) = server(&[(502, "{}")]);
        let error = github
            .rest(
                Method::Patch,
                "repos/o/r/pulls/5",
                Some(&json!({"body": "b"})),
            )
            .expect_err("a failed write");
        assert!(error.to_string().contains("HTTP 502"), "{error}");
        let (github, mutations) = server(&[(502, "{}")]);
        github
            .graphql("mutation { reply }", &json!({}))
            .expect_err("a failed mutation");
        // A read is tried again after a server error, but not after a refusal.
        let (github, reads) = server(&[(502, "{}"), (200, "{}")]);
        assert_eq!(
            github
                .rest(Method::Get, "repos/o/r/pulls/5", None)
                .expect("the read"),
            json!({})
        );
        let (github, refused) = server(&[(404, "{}")]);
        github
            .rest(Method::Get, "repos/o/r/pulls/5", None)
            .expect_err("a refused read");
        let count = |requests: &Arc<Mutex<Vec<String>>>| requests.lock().expect("the list").len();
        assert_eq!(
            (
                count(&requests),
                count(&mutations),
                count(&reads),
                count(&refused)
            ),
            (1, 1, 2, 1)
        );
        assert_eq!(
            requests.lock().expect("the list")[0],
            "PATCH /repos/o/r/pulls/5 HTTP/1.1"
        );
    }

    #[test]
    fn a_graphql_reply_with_errors_is_a_refusal_and_a_server_error_is_not() {
        // The post step tries a thread's next form only after a refusal: a
        // server error may come after GitHub took the thread.
        let (github, _) = server(&[(
            200,
            r#"{"data": {"addPullRequestReviewThread": null}, "errors": [{"message": "a", "path": ["addPullRequestReviewThread"]}, {"message": "b"}]}"#,
        )]);
        let refused = github.graphql("mutation { add }", &json!({}));
        assert!(
            matches!(&refused, Err(Error::GraphQl { detail }) if detail == "a; b"),
            "{refused:?}"
        );
        // GitHub added the thread and failed only on its comment's URL: not
        // a refusal, and the result goes with the error.
        let (github, _) = server(&[(
            200,
            r#"{"data": {"addPullRequestReviewThread": {"thread": {"id": "T", "comments": {"nodes": [{"url": null}]}}}},
                "errors": [{"message": "c", "path": ["addPullRequestReviewThread", "thread", "comments", "nodes", 0, "url"]}]}"#,
        )]);
        let added = github.graphql("mutation { add }", &json!({}));
        assert!(
            matches!(
                &added,
                Err(Error::GraphQlPartial { detail, data })
                    if detail == "c" && data["addPullRequestReviewThread"]["thread"]["id"] == "T"
            ),
            "{added:?}"
        );
        assert!(!added.is_err_and(|error| error.is_refusal()));
        // A read with an error deep in its result is not read at all.
        let (github, _) = server(&[(
            200,
            r#"{"data": {"repository": {"pullRequest": {"reviewThreads": null}}},
                "errors": [{"message": "d", "path": ["repository", "pullRequest", "reviewThreads"]}]}"#,
        )]);
        let read = github.graphql("query { repository }", &json!({}));
        assert!(
            matches!(&read, Err(Error::GraphQl { detail }) if detail == "d"),
            "{read:?}"
        );
        let (github, _) = server(&[(502, "{}")]);
        let failed = github.graphql("mutation { add }", &json!({}));
        assert!(
            matches!(
                &failed,
                Err(Error::GitHub {
                    request: _,
                    detail: _,
                    status: Some(502),
                })
            ),
            "{failed:?}"
        );
    }

    #[test]
    fn follows_the_next_link_of_a_list() {
        let link = "<https://api.github.com/repositories/1/issues/5/comments?per_page=100&page=2>; rel=\"next\", \
                    <https://api.github.com/repositories/1/issues/5/comments?per_page=100&page=4>; rel=\"last\"";
        assert_eq!(
            next_page(link).as_deref(),
            Some("https://api.github.com/repositories/1/issues/5/comments?per_page=100&page=2")
        );
        let last = "<https://api.github.com/x?page=1>; rel=\"prev\", <https://api.github.com/x?page=1>; rel=\"first\"";
        assert_eq!(next_page(last), None);
    }
}
