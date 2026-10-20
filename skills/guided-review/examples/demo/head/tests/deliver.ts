import { expect, test } from 'bun:test';
import { deliver } from '../src/webhooks/deliver';
import { fakeDb, serve } from './helpers';

test('a 2xx answer delivers', async () => {
  const db = fakeDb();
  const url = serve(204);
  expect((await deliver(db, { id: 'e', url, secret: 's' }, db.add())).status).toBe('delivered');
});

test('a 500 is retried later', async () => {
  const db = fakeDb();
  const url = serve(500);
  expect((await deliver(db, { id: 'e', url, secret: 's' }, db.add(), 1_000)).status).toBe('retrying');
  expect(db.last().nextAttemptAt).toBeGreaterThan(1_000);
});

test('a 404 fails at once', async () => {
  const db = fakeDb();
  const url = serve(404);
  expect((await deliver(db, { id: 'e', url, secret: 's' }, db.add())).status).toBe('failed');
});

test('the sixth failure fails for good', async () => {
  const db = fakeDb();
  const url = serve(503);
  expect((await deliver(db, { id: 'e', url, secret: 's' }, db.add({ attempts: 5 }))).status).toBe('failed');
});
