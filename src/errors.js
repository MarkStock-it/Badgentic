/**
 * Canonical error codes — the HTTP layer maps these to status codes and
 * `{ error, message }` bodies; canvas/ai layers throw these directly.
 */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION: 'VALIDATION',
  RATE_LIMITED: 'RATE_LIMITED',
  TRANSIENT: 'TRANSIENT',
  UNSUPPORTED: 'UNSUPPORTED',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  BYOK_MISSING: 'BYOK_MISSING',
  UPSTREAM: 'UPSTREAM', // Canvas / AI provider 4xx-5xx that isn't auth/rate
  CANCELLED: 'CANCELLED',
  INTERNAL: 'INTERNAL',
};

export const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BYOK_MISSING: 403,
  PERMISSION_REQUIRED: 403,
  NOT_FOUND: 404,
  APPROVAL_REQUIRED: 409,
  APPROVAL_EXPIRED: 409,
  CONFLICT: 409,
  CANCELLED: 409,
  RATE_LIMITED: 429,
  TRANSIENT: 502,
  UNSUPPORTED: 422,
  UPSTREAM: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(code, message, { cause, details, hint } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code in ERROR_CODES ? code : ERROR_CODES.INTERNAL;
    this.details = details;
    this.hint = hint; // UI-displayable hint (BYOK flows), never contains secrets
  }
}

export function isAppError(err) {
  return err instanceof AppError;
}
