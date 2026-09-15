import express from 'express';
import { fileURLToPath } from 'node:url';
import { STATUS_BY_CODE, ERROR_CODES } from '../errors.js';
import { corsMiddleware, createSessionMiddleware } from './middleware.js';
import { createAuthRoutes } from './routes/auth-routes.js';
import { createJobRoutes } from './routes/job-routes.js';
import { createArtifactRoutes } from './routes/artifact-routes.js';
import { createBackChannelRoutes } from './routes/backchannel-routes.js';
import { createOpsRoutes } from './routes/ops-routes.js';
import { createMetrics } from './metrics.js';

/**
 * App assembly (spec §2.1): plain Express, factory-injected deps, one error
 * writer mapping the canonical error taxonomy to `{ error, message }` bodies.
 */
export function createApp({
  store,
  sessionService,
  handoffVerifier,
  orchestrator,
  cryptoBox = null,
  canvasServiceFactory,
  config,
  log,
  dbPool = null,
}) {
  const app = express();
  const metrics = createMetrics();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS; cookies need Secure behind proxy

  app.use(express.json({ limit: '1mb' }));
  app.use(corsMiddleware(config));
  app.use(createSessionMiddleware({ store, cookieName: config.sessionCookieName }));

  // request log (pino, redacted)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      log?.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start }, 'http');
    });
    next();
  });

  const api = express.Router();
  api.use('/auth', createAuthRoutes({ store, sessionService, handoffVerifier, cryptoBox, canvasServiceFactory, config, log }));
  api.use(createJobRoutes({ store, orchestrator, config }));
  api.use(createArtifactRoutes({ store }));
  app.use('/api/v1', api);
  app.use('/api/v1', createBackChannelRoutes({ store, config }));
  app.use(createOpsRoutes({ dbPool, metrics }));

  // Static UI shell (minimal; user redesigns CSS later)
  const uiDir = fileURLToPath(new URL('../ui/', import.meta.url));
  app.use(express.static(uiDir, { index: 'index.html' }));
  app.get('/', (req, res) => {
    res.sendFile(fileURLToPath(new URL('../ui/index.html', import.meta.url)));
  });

  // ---- error writer: { error, message } with proper status codes ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const code = err.code && STATUS_BY_CODE[err.code] ? err.code : ERROR_CODES.INTERNAL;
    const status = STATUS_BY_CODE[code] || 500;
    const level = status >= 500 ? 'error' : 'warn';
    log?.[level]({ err: err.message, code, path: req.path }, 'request failed');
    metrics.incr(`http.error.${code}`);
    res.status(status).json({
      error: code,
      message: err.message || 'Internal error',
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
  });

  return { app, metrics };
}
