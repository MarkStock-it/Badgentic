export function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal) {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  err.signalReason = signal?.reason;
  return err;
}

/** Exponential backoff: base * 2^attempt, capped. */
export function backoffMs(attempt, { baseMs = 2000, capMs = 8000 } = {}) {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
