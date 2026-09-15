import { AppError, ERROR_CODES } from '../errors.js';
import { identityHash } from '../util/id.js';

/**
 * Session service (spec §2.2 steps 4-5, §6.2, §7.1).
 * A session can exist before the Canvas token is attached (bootstrap path b:
 * user-paste). Secrets are encrypted via cryptoBox before they hit the store.
 */
export function createSessionService({ store, cryptoBox, config, log }) {
  const TTL_MS = config.sessionTtlHours * 3600 * 1000;
  const APPROVAL_TTL_MS = config.approvalExpiryHours * 3600 * 1000;

  async function bootstrapFromHandoff({ claims }) {
    const user = await store.upsertUser({
      id: claims.sub,
      canvasDomain: claims.canvasDomain,
      canvasUserId: claims.canvasUserId,
      displayName: claims.name || '',
      email: claims.email || '',
    });
    const expiresAt = new Date(Date.now() + TTL_MS);
    const session = await store.createSession({ userId: user.id, expiresAt });
    log?.info({ sub: claims.sub }, 'session bootstrapped from handoff');
    return session;
  }

  /** Verify a pasted Canvas token live, then attach it encrypted to the session. */
  async function attachCanvasToken({ sessionId, token, domain, canvasService }) {
    const session = await requireSession(sessionId);
    try {
      const profile = await canvasService({ token, domain }).getProfile();
      if (!profile?.id) throw new Error('no profile id');
    } catch (err) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Canvas rejected this token', {
        cause: err,
        hint: 'Generate a new Canvas token with at least read permissions and try again.',
      });
    }
    const enc = cryptoBox.encrypt(token);
    await store.updateSessionCanvasToken(sessionId, enc);
    return { ok: true, domain };
  }

  async function setAiKeys({ sessionId, keys }) {
    const session = await requireSession(sessionId);
    const enc = {};
    if (keys.gemini) enc.gemini = cryptoBox.encrypt(keys.gemini);
    if (keys.groq) enc.groq = cryptoBox.encrypt(keys.groq);
    await store.updateSessionAiKeys(sessionId, enc);
    return { ok: true };
  }

  function decryptAiKeys(session) {
    if (!session?.aiKeysEnc) return {};
    const out = {};
    for (const k of ['gemini', 'groq']) {
      if (session.aiKeysEnc[k]) {
        try {
          out[k] = cryptoBox.decrypt(session.aiKeysEnc[k]);
        } catch {
          // Corrupt entry: drop it rather than failing the run.
        }
      }
    }
    return out;
  }

  function decryptCanvasToken(session) {
    if (!session?.canvasTokenEnc || !session?.tokenIv || !session?.tokenTag) return null;
    try {
      return cryptoBox.decrypt({ c: session.canvasTokenEnc, iv: session.tokenIv, tag: session.tokenTag });
    } catch {
      return null;
    }
  }

  async function requireSession(id) {
    const session = await store.getSession(id);
    if (!session) throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Session expired or not found');
    return session;
  }

  /** Full per-run credential bundle; plaintext lives only in memory for the run. */
  async function getRunCredentials({ sessionId }) {
    const session = await requireSession(sessionId);
    return {
      session,
      canvasToken: decryptCanvasToken(session),
      aiKeys: decryptAiKeys(session),
    };
  }

  async function logout(sessionId) {
    await store.deleteSession(sessionId);
  }

  return {
    bootstrapFromHandoff,
    attachCanvasToken,
    setAiKeys,
    getRunCredentials,
    decryptCanvasToken,
    logout,
    APPROVAL_TTL_MS,
  };
}
