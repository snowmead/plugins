# Webhooks

Each event is posted to every endpoint that subscribes to it.

## Signatures

Every request carries a `webhook-signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. Check
it with the endpoint's secret before you trust the body.

## Delivery

We post each event with a 10 second timeout, and a 2xx answer delivers it. A timeout, a network error, a 408, a
429 or a 5xx is retried up to 5 more times, about 30 s, 1, 2, 4 and 8 minutes apart; then the delivery is marked
failed. Any other 4xx fails it at once.

| Post | Waits before it | Since the first post |
|-----:|----------------:|---------------------:|
| 1 | none | 0 s |
| 2 | 30 s | 30 s |
| 3 | 1 min | 1.5 min |
| 4 | 2 min | 3.5 min |
| 5 | 4 min | 7.5 min |
| 6 | 8 min | 15.5 min |

Each wait varies by up to 20%, so endpoints that fail together are not retried together.

![Six posts over about 15 minutes](retries.svg)

> [!IMPORTANT]
> Make your handler idempotent: a retry can bring an event you already handled.

## The endpoint page

The endpoint page counts deliveries by state: pending, retrying, delivered and failed. Retrying shows when the
next post is due, so you can tell a slow receiver from a broken one.

## Limits

An endpoint can subscribe to at most 20 event types.
