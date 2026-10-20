import type { Db } from '../db';
import { log } from '../log';
import { deliver, hostOf } from './deliver';

/** Take the deliveries that are due and post them, a batch at a time. Returns how many it took. */
export async function drain(db: Db, batch = 50, now = Date.now()): Promise<number> {
  const due = await db.deliveries.find(
    { status: ['pending', 'retrying'], nextAttemptAt: { lte: now } },
    { limit: batch, order: 'nextAttemptAt' },
  );
  for (const d of due) {
    const endpoint = await db.endpoints.get(d.endpointId);
    const outcome = await deliver(db, endpoint, d, now);
    log.info('webhook', { host: hostOf(endpoint), status: outcome.status, code: outcome.code, attempts: d.attempts + 1 });
  }
  return due.length;
}
