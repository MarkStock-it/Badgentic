/**
 * Per-user Canvas rate limiting (spec §4.4): conservative token bucket,
 * 100 req/min default, in-memory per process.
 */
export function createRateLimiter({ perMinute = 100 } = {}) {
  const buckets = new Map(); // key -> { tokens, last }

  const CAPACITY = perMinute;
  const REFILL_PER_MS = perMinute / 60_000;

  function take(key, now = Date.now()) {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: CAPACITY, last: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(CAPACITY, b.tokens + (now - b.last) * REFILL_PER_MS);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function msUntilToken(key, now = Date.now()) {
    const b = buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / REFILL_PER_MS);
  }

  return { take, msUntilToken };
}
