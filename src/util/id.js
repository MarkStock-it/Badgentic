import { createHash, randomUUID } from 'node:crypto';

export function newId() {
  return randomUUID();
}

/**
 * Shared identity hash convention (BetterCLSS user-identity.js):
 *   SHA-256(`${domain}\n${canvasUserId}`) as lowercase hex.
 * Both sides compute this locally; it is the join key across systems.
 */
export function identityHash(domain, canvasUserId) {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  return createHash('sha256').update(`${normalizedDomain}\n${String(canvasUserId)}`).digest('hex');
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
