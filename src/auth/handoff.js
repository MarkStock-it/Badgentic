import { AppError, ERROR_CODES } from '../errors.js';
import { identityHash } from '../util/id.js';
import { verifyJwt } from './jwt.js';

/**
 * Handoff-token verification (spec §6.1): BetterCLSS mints, we verify.
 * Claims checked: iss, aud, exp, sub; identity hash recomputed from
 * canvasDomain + canvasUserId must equal sub (tamper check).
 */
export function createHandoffVerifier({ config }) {
  return function verifyHandoffToken(token) {
    const payload = verifyJwt(token, {
      secret: config.jwtSecret,
      audience: config.jwtAudience,
      issuer: config.jwtIssuer,
    });
    if (!payload) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Invalid or expired handoff token', {
        hint: 'Re-open Agentic Helper from BetterCLSS to get a fresh link.',
      });
    }
    if (!payload.canvasDomain || !payload.canvasUserId || !payload.sub) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Handoff token missing identity claims');
    }
    const recomputed = identityHash(payload.canvasDomain, payload.canvasUserId);
    if (recomputed !== payload.sub) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Handoff token identity mismatch');
    }
    return payload;
  };
}
