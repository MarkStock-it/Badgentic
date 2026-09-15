import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT sign/verify — no library weight, spec §6.1 only needs
 * HS256 + a fixed claim set. Verification is constant-time on the signature.
 */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  return body + '.' + sign(body, secret);
}

export function verifyJwt(token, { secret, audience, issuer, now = () => Math.floor(Date.now() / 1000) }) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256') return null;

  const expected = sign(`${h}.${p}`, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const ts = now();
  if (typeof payload.exp !== 'number' || payload.exp <= ts) return null;
  if (typeof payload.iat !== 'number' || payload.iat > ts + 5) return null;
  if (audience && payload.aud !== audience) return null;
  if (issuer && payload.iss !== issuer) return null;
  return payload;
}
