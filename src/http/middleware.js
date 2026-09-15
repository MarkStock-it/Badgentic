import { AppError, ERROR_CODES } from '../errors.js';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Session middleware: loads the session + user for cookie-authenticated
 * requests. Mutations additionally require a custom header (CSRF defense in
 * depth alongside SameSite=Lax, spec §9 risk 9).
 */
export function createSessionMiddleware({ store, cookieName }) {
  async function loadSession(req) {
    const sid = parseCookies(req.headers.cookie)[cookieName];
    if (!sid) return null;
    const session = await store.getSession(sid);
    if (!session) return null;
    return { sessionId: sid, session };
  }

  return async function sessionMiddleware(req, res, next) {
    try {
      const loaded = await loadSession(req);
      if (loaded) {
        req.sessionId = loaded.sessionId;
        req.session = loaded.session;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireSession(req) {
  if (!req.sessionId || !req.session) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Sign in via BetterCLSS to continue');
  }
}

export function requireCsrf(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (req.headers['x-agentic-csrf'] !== '1') {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Missing CSRF header');
  }
}

export function requireBackChannel(req, config) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token !== config.backChannelToken) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Invalid back-channel token');
  }
}

/** CORS: lock to configured BetterCLSS origins; no wildcard with credentials. */
export function corsMiddleware(config) {
  return function cors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agentic-CSRF');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
