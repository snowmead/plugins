import type { Db } from '../db';
import { log } from '../log';
import { deliver, hostOf } from './deliver';

/** Take pending deliveries and post them, a batch at a time. Returns how many it took. */
export async function drain(db: Db, batch = 50): Promise<number> {
  const due = await db.deliveries.find({ status: 'pending' }, { limit: batch, order: 'createdAt' });
  for (const d of due) {
    const endpoint = await db.endpoints.get(d.endpointId);
    const outcome = await deliver(db, endpoint, d);
    log.info('webhook', { host: hostOf(endpoint), status: outcome.status, code: outcome.code });
  }
  return due.length;
}
