import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createStore } from './store/index.js';
import { createCryptoBox } from './auth/crypto-box.js';
import { createHandoffVerifier } from './auth/handoff.js';
import { createSessionService } from './auth/sessions.js';
import { createCanvasGateway } from './canvas/canvas-gateway.js';
import { createApprovalGate } from './agent/approval-gate.js';
import { createOrchestrator } from './agent/orchestrator.js';
import { createApp } from './http/app.js';

/**
 * Boot sequence (spec §2.4): config → deps → startup sweeps (interrupted
 * jobs, stale approvals, expired sessions) → listen.
 */
const config = loadConfig();
const log = createLogger({ level: config.logLevel });

if (!config.jwtSecret) {
  log.error('AGENTIC_JWT_SECRET is required');
  process.exit(1);
}

const store = createStore({ config, log });
const cryptoBox = config.tokenAesKeyHex ? createCryptoBox({ keyHex: config.tokenAesKeyHex }) : null;
if (!cryptoBox) {
  log.error('AGENTIC_TOKEN_AES_KEY is required');
  process.exit(1);
}

const sessionService = createSessionService({ store, cryptoBox, config, log });
const handoffVerifier = createHandoffVerifier({ config });
const canvasGateway = createCanvasGateway({ store });
const approvalGate = createApprovalGate({ store, approvalTtlMs: config.approvalExpiryHours * 3600 * 1000 });
const orchestrator = createOrchestrator({
  store,
  canvasGateway,
  approvalGate,
  sessionService,
  config,
  log,
});

const { app } = createApp({ store, sessionService, handoffVerifier, orchestrator, cryptoBox, config, log });

// ---- startup sweeps ----
const interrupted = await orchestrator.sweepInterruptedJobs();
if (interrupted > 0) log.warn({ interrupted }, 'marked interrupted jobs FAILED');
const expiredApprovals = await orchestrator.sweepApprovals();
if (expiredApprovals > 0) log.info({ expiredApprovals }, 'expired stale approvals');
const expiredSessions = await store.deleteExpiredSessions?.();
if (expiredSessions > 0) log.info({ expiredSessions }, 'deleted expired sessions');

// queue pump + periodic sweeps
orchestrator.startQueuePump({ intervalMs: 5000 });
const sweepTimer = setInterval(() => {
  orchestrator.sweepApprovals();
  store.deleteExpiredSessions?.();
}, 10 * 60 * 1000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

const server = app.listen(config.port, () => {
  log.info({ port: config.port, env: config.env, store: store.driver }, 'betterclss-agentic listening');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
