/** A delivery fails for good after this many posts, about 15 minutes after the first. */
export const MAX_ATTEMPTS = 6;
const BASE_MS = 30_000;
const CAP_MS = 60 * 60_000;

/** When to post again after `attempts` failures: 30 s, 1, 2, 4, 8 minutes, at most an hour, with ±20% jitter. */
export function nextAttemptAt(attempts: number, now: number, random = Math.random): number {
  const delay = Math.min(CAP_MS, BASE_MS * 2 ** (attempts - 1));
  return now + Math.round(delay * (0.8 + 0.4 * random()));
}

/** A network error, a timeout, rate limiting or a server error may pass later; any other 4xx will not. */
export function retryable(code: number | null): boolean {
  return code === null || code === 408 || code === 429 || code >= 500;
}
