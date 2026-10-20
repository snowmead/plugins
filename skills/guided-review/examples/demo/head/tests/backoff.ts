import { expect, test } from 'bun:test';
import { nextAttemptAt, retryable } from '../src/webhooks/backoff';

test('the delay doubles and stops at an hour', () => {
  const mid = () => 0.5;
  expect(nextAttemptAt(1, 0, mid)).toBe(30_000);
  expect(nextAttemptAt(2, 0, mid)).toBe(60_000);
  expect(nextAttemptAt(20, 0, mid)).toBe(3_600_000);
});

test('only failures that may pass later are retried', () => {
  expect([null, 408, 429, 500, 503].every((c) => retryable(c))).toBe(true);
  expect([400, 401, 404, 410].some((c) => retryable(c))).toBe(false);
});
