import type { Db, Delivery, Endpoint } from '../db';
import { MAX_ATTEMPTS, nextAttemptAt, retryable } from './backoff';
import { sign } from './sign';

export interface Outcome {
  status: 'delivered' | 'retrying' | 'failed';
  code: number | null;
}

/** Post one delivery to its endpoint. A failure that may pass later is retried with backoff. */
export async function deliver(db: Db, endpoint: Endpoint, delivery: Delivery, now = Date.now()): Promise<Outcome> {
  const at = Math.floor(now / 1000);
  const body = JSON.stringify(delivery.event);
  let code: number | null = null;
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-signature': sign(body, endpoint.secret, at) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    code = res.status;
  } catch {
    code = null;
  }
  const attempts = delivery.attempts + 1;
  if (code !== null && code >= 200 && code < 300) {
    await db.deliveries.update(delivery.id, { status: 'delivered', lastCode: code, attempts });
    return { status: 'delivered', code };
  }
  if (retryable(code) && attempts < MAX_ATTEMPTS) {
    await db.deliveries.update(delivery.id, { status: 'retrying', lastCode: code, attempts, nextAttemptAt: nextAttemptAt(attempts, now) });
    return { status: 'retrying', code };
  }
  await db.deliveries.update(delivery.id, { status: 'failed', lastCode: code, attempts });
  return { status: 'failed', code };
}

/** The endpoint's host, for logs. */
export function hostOf(endpoint: Endpoint): string {
  try {
    return new URL(endpoint.url).host;
  } catch {
    return 'invalid-url';
  }
}
