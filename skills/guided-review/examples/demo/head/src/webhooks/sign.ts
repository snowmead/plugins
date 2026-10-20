import { createHmac } from 'node:crypto';

/** Sign a payload so the receiver can check it came from us. */
export function sign(payload: string, secret: string, at: number): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${at}.${payload}`);
  return `t=${at},v1=${mac.digest('hex')}`;
}
