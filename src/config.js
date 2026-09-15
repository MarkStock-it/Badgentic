import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * All knobs in one object — factories take slices of this as deps, so tests
 * construct their own config objects instead of importing this module.
 */
export function loadConfig(env = process.env) {
  const isTest = env.NODE_ENV === 'test';
  return {
    port: num('PORT', 3000),
    env: env.NODE_ENV || 'development',
    databaseUrl: env.AGENTIC_DB_URL || '',
    jwtSecret: env.AGENTIC_JWT_SECRET || (isTest ? 'test-secret-test-secret-test-secret-test-secret' : ''),
    jwtAudience: env.AGENTIC_ALLOWED_AUD || 'betterclss-agentic',
    jwtIssuer: env.AGENTIC_JWT_ISSUER || 'betterclss',
    jwtTtlSeconds: num('AGENTIC_JWT_TTL_SECONDS', 120),
    tokenAesKeyHex: env.AGENTIC_TOKEN_AES_KEY || '',
    backChannelToken: env.AGENTIC_BACK_CHANNEL_TOKEN || '',
    allowedOrigins: (env.AGENTIC_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sessionCookieName: env.AGENTIC_SESSION_COOKIE || 'agentic_session',
    sessionTtlHours: num('AGENTIC_SESSION_TTL_HOURS', 8),
    // Concurrency (spec §2.3)
    maxConcurrentJobsPerUser: num('AGENTIC_MAX_JOBS_PER_USER', 2),
    maxConcurrentJobsGlobal: num('AGENTIC_MAX_JOBS_GLOBAL', 10),
    // Orchestrator hard limits (spec §5.4)
    maxToolCalls: num('AGENTIC_MAX_TOOL_CALLS', 8),
    maxAiCalls: num('AGENTIC_MAX_AI_CALLS', 10),
    maxJobWallTimeMs: num('AGENTIC_MAX_JOB_WALL_TIME_MS', 5 * 60 * 1000),
    maxRunAttempts: num('AGENTIC_MAX_RUN_ATTEMPTS', 2),
    retryRunBackoffMs: num('AGENTIC_RETRY_RUN_BACKOFF_MS', 30_000),
    approvalExpiryHours: num('AGENTIC_APPROVAL_EXPIRY_HOURS', 24),
    artifactMaxBytes: num('AGENTIC_ARTIFACT_MAX_BYTES', 10 * 1024 * 1024),
    canvasRateLimitPerMin: num('AGENTIC_CANVAS_RPM', 100),
    logLevel: env.LOG_LEVEL || (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  };
}
