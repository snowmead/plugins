import { createHmac } from 'node:crypto';
import type { Db, Delivery, Endpoint } from '../db';

export interface Outcome {
  status: 'delivered' | 'failed';
  code: number | null;
}

/** Post one delivery to its endpoint, once. */
export async function deliver(db: Db, endpoint: Endpoint, delivery: Delivery): Promise<Outcome> {
  const at = Math.floor(Date.now() / 1000);
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
  const ok = code !== null && code >= 200 && code < 300;
  await db.deliveries.update(delivery.id, { status: ok ? 'delivered' : 'failed', lastCode: code });
  return { status: ok ? 'delivered' : 'failed', code };
}

/** The endpoint's host, for logs. */
export function hostOf(endpoint: Endpoint): string {
  try {
    return new URL(endpoint.url).host;
  } catch {
    return 'invalid-url';
  }
}

/** Sign a payload so the receiver can check it came from us. */
export function sign(payload: string, secret: string, at: number): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${at}.${payload}`);
  return `t=${at},v1=${mac.digest('hex')}`;
}
