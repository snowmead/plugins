import { expect, test } from 'bun:test';
import { deliveryCounts } from '../src/api/endpoint';
import { fakeDb } from './helpers';

test('counts each state and the soonest retry', async () => {
  const db = fakeDb();
  db.add({ status: 'pending' });
  db.add({ status: 'retrying', nextAttemptAt: 9_000 });
  db.add({ status: 'retrying', nextAttemptAt: 4_000 });
  db.add({ status: 'failed' });
  expect(await deliveryCounts(db, 'e')).toEqual({ pending: 1, retrying: 2, delivered: 0, failed: 1, nextRetryAt: 4_000 });
});

test('no retrying delivery, no next retry', async () => {
  expect((await deliveryCounts(fakeDb(), 'e')).nextRetryAt).toBe(null);
});
