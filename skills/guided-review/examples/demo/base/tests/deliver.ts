import { expect, test } from 'bun:test';
import { deliver } from '../src/webhooks/deliver';
import { fakeDb, serve } from './helpers';

test('a 2xx answer delivers', async () => {
  const db = fakeDb();
  const url = serve(204);
  expect((await deliver(db, { id: 'e', url, secret: 's' }, db.add())).status).toBe('delivered');
});

test('a 500 fails', async () => {
  const db = fakeDb();
  const url = serve(500);
  expect((await deliver(db, { id: 'e', url, secret: 's' }, db.add())).status).toBe('failed');
});
