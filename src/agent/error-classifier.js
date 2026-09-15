import { AppError, ERROR_CODES } from '../errors.js';

/**
 * Single error classifier (spec §5.4): one place mapping any thrown error to
 * TRANSIENT | PERMANENT | UNAUTHORIZED | RATE_LIMITED — replaces the scattered
 * string matching of the old orchestrator.
 */
export function classifyError(err) {
  if (!err) return { kind: 'PERMANENT', retryableInRun: false };

  if (err.name === 'AbortError') return { kind: 'PERMANENT', retryableInRun: false, cancelled: true };

  const code = err.code || '';
  if (code === ERROR_CODES.UNAUTHORIZED) return { kind: 'UNAUTHORIZED', retryableInRun: false };
  if (code === ERROR_CODES.RATE_LIMITED) return { kind: 'RATE_LIMITED', retryableInRun: true };
  if (code === ERROR_CODES.TRANSIENT) return { kind: 'TRANSIENT', retryableInRun: true };
  if (code === ERROR_CODES.CANCELLED) return { kind: 'PERMANENT', retryableInRun: false, cancelled: true };
  if (code === 'ALREADY_SUBMITTED') {
    // Nothing changed between attempts — retrying would fail identically.
    return { kind: 'PERMANENT', retryableInRun: false, noRetry: true };
  }
  if (code === ERROR_CODES.BYOK_MISSING) {
    return { kind: 'PERMANENT', retryableInRun: false, noRetry: true };
  }

  const status = err.status || err.statusCode || err.response?.status;
  if (status === 429) return { kind: 'RATE_LIMITED', retryableInRun: true };
  if (status === 401 || status === 403) return { kind: 'UNAUTHORIZED', retryableInRun: false };
  if (status >= 500) return { kind: 'TRANSIENT', retryableInRun: true };

  const msg = String(err.message || '');
  if (/econn|etimedout|eai_again|socket hang up|network/i.test(msg)) {
    return { kind: 'TRANSIENT', retryableInRun: true };
  }
  return { kind: 'PERMANENT', retryableInRun: false };
}

/** In-run transient retry policy (spec §5.4 layer 1): 2s→8s backoff, 3 attempts. */
export async function fetchWithTransientRetry(fn, { retries = 3, baseMs = 2000, capMs = 8000, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const c = classifyError(err);
      if (!c.retryableInRun || attempt === retries) throw err;
      await sleepImpl(Math.min(capMs, baseMs * 2 ** attempt));
    }
  }
  throw lastErr;
}
