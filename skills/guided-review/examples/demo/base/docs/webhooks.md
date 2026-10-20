# Webhooks

Each event is posted to every endpoint that subscribes to it.

## Signatures

Every request carries a `webhook-signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. Check
it with the endpoint's secret before you trust the body.

## Delivery

We post each event once, with a 10 second timeout. A delivery that does not get a 2xx answer is marked failed.

## Limits

An endpoint can subscribe to at most 20 event types.
