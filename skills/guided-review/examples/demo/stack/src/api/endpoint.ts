import type { Db, Delivery } from '../db';

export interface DeliveryCounts {
  pending: number;
  retrying: number;
  delivered: number;
  failed: number;
  /** When the soonest retrying delivery is due, in ms since the epoch; null with none retrying. */
  nextRetryAt: number | null;
}

const STATES: Delivery['status'][] = ['pending', 'retrying', 'delivered', 'failed'];

/** The endpoint page's delivery counts, one per state, and when the next retry is due. */
export async function deliveryCounts(db: Db, endpointId: string): Promise<DeliveryCounts> {
  const counts = await Promise.all(STATES.map((status) => db.deliveries.count({ endpointId, status })));
  const [soonest] = await db.deliveries.find({ endpointId, status: 'retrying' }, { limit: 1, order: 'nextAttemptAt' });
  return {
    pending: counts[0],
    retrying: counts[1],
    delivered: counts[2],
    failed: counts[3],
    nextRetryAt: soonest?.nextAttemptAt ?? null,
  };
}
