import pino from 'pino';

/**
 * Redaction rules (spec §6.3): logs NEVER contain Canvas tokens, AI keys,
 * full JWTs, or session ids. Paths cover the shapes we actually log.
 */
export function createLogger({ level = 'info' } = {}) {
  return pino({
    level,
    redact: {
      paths: [
        'jwt',
        'token',
        'canvasToken',
        'apiKey',
        'geminiKey',
        'groqKey',
        'byok',
        'byok.*',
        'authorization',
        'req.headers.authorization',
        'req.headers.cookie',
        'sessionId',
        'session.id',
      ],
      censor: '[REDACTED]',
    },
    base: { app: 'betterclss-agentic' },
  });
}
