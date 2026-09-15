import { createMemoryStore } from '../src/store/memory.js';
import { createCryptoBox } from '../src/auth/crypto-box.js';
import { createHandoffVerifier } from '../src/auth/handoff.js';
import { createSessionService } from '../src/auth/sessions.js';
import { createCanvasGateway } from '../src/canvas/canvas-gateway.js';
import { createApprovalGate } from '../src/agent/approval-gate.js';
import { createOrchestrator } from '../src/agent/orchestrator.js';
import { createApp } from '../src/http/app.js';
import { signJwt } from '../src/auth/jwt.js';
import { identityHash } from '../src/util/id.js';

export const TEST_CONFIG = {
  port: 0,
  env: 'test',
  databaseUrl: '',
  jwtSecret: 'test-secret-test-secret-test-secret-test-secret',
  jwtAudience: 'betterclss-agentic',
  jwtIssuer: 'betterclss',
  jwtTtlSeconds: 120,
  tokenAesKeyHex: 'a'.repeat(64),
  backChannelToken: 'back-channel-test-token',
  allowedOrigins: ['https://betterclss.example'],
  sessionCookieName: 'agentic_session',
  sessionTtlHours: 8,
  maxConcurrentJobsPerUser: 2,
  maxConcurrentJobsGlobal: 10,
  maxToolCalls: 8,
  maxAiCalls: 10,
  maxJobWallTimeMs: 10_000,
  maxRunAttempts: 2,
  retryRunBackoffMs: 0,
  approvalExpiryHours: 24,
  approvalPollMs: 5,
  artifactMaxBytes: 10 * 1024 * 1024,
  canvasRateLimitPerMin: 100,
  logLevel: 'silent',
};

export function testUser(overrides = {}) {
  return {
    canvasUserId: '12345',
    canvasDomain: 'usc.instructure.com',
    name: 'Test Student',
    ...overrides,
  };
}

export function mintHandoffToken(user, { secret = TEST_CONFIG.jwtSecret, ttlSeconds = 120 } = {}) {
  return signJwt(
    {
      iss: TEST_CONFIG.jwtIssuer,
      aud: TEST_CONFIG.jwtAudience,
      sub: identityHash(user.canvasDomain, user.canvasUserId),
      canvasUserId: user.canvasUserId,
      canvasDomain: user.canvasDomain,
      name: user.name,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    },
    secret
  );
}

/** Canvas fake: profile, courses, one assignment; records writes. */
export function createCanvasFake({ submissionState = 'unsubmitted', failUpload = false } = {}) {
  const calls = [];
  const assignment = {
    id: 9001,
    course_id: 101,
    name: 'Essay 1: Rhetorical Analysis',
    description: '<p>Write a 1000-word analysis with a thesis.</p>',
    due_at: '2026-12-01T23:59:00Z',
    points_possible: 100,
    submission_types: ['online_upload'],
  };
  return {
    calls,
    assignment,
    uploadCalls: () => calls.filter((c) => c.type === 'upload'),
    commentCalls: () => calls.filter((c) => c.type === 'comment'),
    svc({ token, domain }) {
      return {
        async getProfile() {
          calls.push({ type: 'profile', token, domain });
          return { id: 12345, name: 'Test Student', primary_email: 'student@example.edu' };
        },
        async listCourses() {
          calls.push({ type: 'listCourses' });
          return [{ id: 101, name: 'ENGL 210', course_code: 'ENGL-210' }];
        },
        async listAssignments(courseId) {
          calls.push({ type: 'listAssignments', courseId });
          return [assignment];
        },
        async getAssignment(courseId, assignmentId) {
          calls.push({ type: 'getAssignment', courseId, assignmentId });
          return assignment;
        },
        async getSubmission(courseId, assignmentId) {
          calls.push({ type: 'getSubmission', courseId, assignmentId });
          return { workflow_state: submissionState };
        },
        async listSubmissionComments() {
          return [];
        },
        async postComment(courseId, assignmentId, comment) {
          calls.push({ type: 'comment', courseId, assignmentId, comment });
          return { ok: true };
        },
        async uploadFile({ name, contentType, size }) {
          calls.push({ type: 'upload', name, contentType, size });
          if (failUpload) {
            const err = new Error('upload failed');
            err.status = 500;
            throw err;
          }
          return { id: 777, filename: name, size };
        },
        async submitFile(courseId, assignmentId, fileId) {
          calls.push({ type: 'submit', courseId, assignmentId, fileId });
          return { id: 42, workflow_state: 'submitted' };
        },
      };
    },
  };
}

/** AI fake: returns canned structured JSON per template. */
export function createAiFake({ overrides = {} } = {}) {
  const calls = [];
  const defaults = {
    analyze: { summary: 'A rhetorical analysis essay.', deliverable: '1000-word essay', requirements: ['thesis', '1000 words'], risks: [] },
    capability_check: { supported: true, reason: null, requires_user_action: false, user_action_reason: null },
    plan: { steps: ['outline', 'draft'], sections: [{ heading: 'Intro', purpose: 'thesis' }], tone: 'academic' },
    'generate/assignment_document': { title: 'Rhetorical Analysis Draft', sections: [{ heading: 'Intro', paragraphs: ['The thesis is…'], bullets: [] }] },
    'generate/discussion_post': { title: 'Discussion Post', sections: [{ heading: '', paragraphs: ['My take: …'], bullets: [] }] },
    'generate/study_deck': { title: 'Study Deck', sections: [{ heading: 'Key terms', paragraphs: [], bullets: ['ethos — credibility appeal'] }] },
    refine: null, // falls through to generate-shape override
    validate: { verdict: 'PASS', checks: [{ requirement: 'thesis', satisfied: true, note: 'ok' }], missing: [] },
    ...overrides,
  };
  return {
    calls,
    factory({ aiKeys }) {
      return {
        hasGemini: Boolean(aiKeys.gemini),
        hasGroq: Boolean(aiKeys.groq),
        templateVersion: () => 1,
        async generateStructured({ templateId, context }) {
          calls.push({ templateId, context: Object.keys(context) });
          const json = defaults[templateId];
          if (json === undefined) throw new Error(`no canned response for ${templateId}`);
          if (json === null) throw new Error('ai unavailable');
          return { json, usage: { provider: 'fake', promptTokens: 1, completionTokens: 1 } };
        },
        async generate({ templateId }) {
          calls.push({ templateId });
          return { text: 'plain', usage: {} };
        },
      };
    },
  };
}

/**
 * Full bundle: memory store + fakes + real auth/approvals/orchestrator.
 * Passing `orchestrator: false` skips auto-starting attempts (queue tests).
 */
export function createTestHarness({ canvasFake = createCanvasFake(), aiFake = createAiFake(), user = testUser(), permissionOverrides = {} } = {}) {
  const store = createMemoryStore();
  const cryptoBox = createCryptoBox({ keyHex: TEST_CONFIG.tokenAesKeyHex });
  const handoffVerifier = createHandoffVerifier({ config: TEST_CONFIG });
  const sessionService = createSessionService({ store, cryptoBox, config: TEST_CONFIG, log: undefined });

  // Real gateway logic (cache, live re-verify, double-submit guard) with the
  // fake Canvas service underneath.
  const canvasGateway = createCanvasGateway({
    store,
    serviceFactory: ({ auth }) => canvasFake.svc({ token: auth.token, domain: auth.domain }),
  });

  const approvalGate = createApprovalGate({ store, approvalTtlMs: TEST_CONFIG.approvalExpiryHours * 3600 * 1000 });

  const orchestrator = createOrchestrator({
    store,
    canvasGateway,
    approvalGate,
    sessionService,
    aiClientFactory: aiFake.factory,
    permissionOverrides,
    config: TEST_CONFIG,
    log: undefined,
  });

  const { app } = createApp({
    store,
    sessionService,
    handoffVerifier,
    orchestrator,
    cryptoBox,
    canvasServiceFactory: ({ auth }) => canvasFake.svc({ token: auth.token, domain: auth.domain }),
    config: TEST_CONFIG,
    log: undefined,
  });

  return { store, cryptoBox, sessionService, orchestrator, approvalGate, canvasGateway, app, canvasFake, aiFake, user, config: TEST_CONFIG };
}

/** Create a signed-in session for `user` with canvas token + gemini key. */
export async function seedSession(harness, { withCanvas = true, withAi = true } = {}) {
  const claims = {
    sub: identityHash(harness.user.canvasDomain, harness.user.canvasUserId),
    canvasDomain: harness.user.canvasDomain,
    canvasUserId: harness.user.canvasUserId,
    name: harness.user.name,
  };
  const session = await harness.sessionService.bootstrapFromHandoff({ claims });
  if (withCanvas) {
    const enc = harness.cryptoBox.encrypt('canvas-test-token');
    await harness.store.updateSessionCanvasToken(session.id, { canvasTokenEnc: enc.c, tokenIv: enc.iv, tokenTag: enc.tag });
  }
  if (withAi) {
    await harness.sessionService.setAiKeys({ sessionId: session.id, keys: { gemini: 'fake-gemini-key' } });
  }
  return session;
}
