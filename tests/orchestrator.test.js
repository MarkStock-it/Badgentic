import { describe, it, expect, afterEach } from 'vitest';
import { createTestHarness, seedSession, TEST_CONFIG } from './helpers.js';
import pino from 'pino';

function waitForJobState(store, jobId, states, { timeoutMs = 8000 } = {}) {
  const set = new Set(Array.isArray(states) ? states : [states]);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      const job = await store.getJob(jobId);
      if (set.has(job.state)) return resolve(job);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${[...set].join('|')}, last=${job.state} (${job.failureReason || ''})`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForRunState(store, runId, states, { timeoutMs = 5000 } = {}) {
  const set = new Set(Array.isArray(states) ? states : [states]);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      const run = await store.getRun(runId);
      if (set.has(run.state)) return resolve(run);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for run ${[...set].join('|')}, last=${run.state}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function autoApprove(harness) {
  const timer = setInterval(async () => {
    try {
      const pending = await harness.store.listPendingApprovals();
      for (const a of pending) await harness.store.updateApproval(a.id, { state: 'APPROVED', decidedAt: new Date() });
    } catch {}
  }, 5);
  return () => clearInterval(timer);
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe('orchestrator', () => {
  it('runs discussion_post end-to-end: artifact + approval + comment write', async () => {
    const harness = createTestHarness();
    const session = await seedSession(harness);
    const stopApprove = autoApprove(harness);
    cleanups.push(stopApprove);

    const job = await harness.store.createJob({
      userId: session.userId,
      kind: 'discussion_post',
      canvasCourseId: 101,
      canvasAssignmentId: 9001,
      sessionId: session.id,
    });
    await harness.orchestrator.scheduleAttempt({ job, attempt: 1 });
    const done = await waitForJobState(harness.store, job.id, 'COMPLETED');

    expect(done.result.artifact.filename).toMatch(/\.md$/);
    expect(done.result.validationVerdict).toBe('PASS');
    const comments = harness.canvasFake.commentCalls();
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toContain('My take');
    const runs = await harness.store.listRunsForJob(job.id);
    expect(runs[0].state).toBe('COMPLETED');
  });

  it('assignment_document is blocked by default submission permissions', async () => {
    const harness = createTestHarness();
    const session = await seedSession(harness);

    const job = await harness.store.createJob({
      userId: session.userId,
      kind: 'assignment_document',
      canvasCourseId: 101,
      canvasAssignmentId: 9001,
      sessionId: session.id,
    });
    await harness.orchestrator.scheduleAttempt({ job, attempt: 1 });
    const failed = await waitForJobState(harness.store, job.id, 'FAILED');

    expect(failed.failureReason).toContain('canvas_submission');
    expect(harness.canvasFake.uploadCalls()).toHaveLength(0);
  });

  it('assignment_document submits after approval with permissions enabled', async () => {
    const harness = createTestHarness({ permissionOverrides: { canvas_submission: true, canvas_file_upload: true } });
    const session = await seedSession(harness);
    const stopApprove = autoApprove(harness);
    cleanups.push(stopApprove);

    const job = await harness.store.createJob({
      userId: session.userId,
      kind: 'assignment_document',
      canvasCourseId: 101,
      canvasAssignmentId: 9001,
      sessionId: session.id,
    });
    await harness.orchestrator.scheduleAttempt({ job, attempt: 1 });
    await waitForJobState(harness.store, job.id, 'COMPLETED');

    expect(harness.canvasFake.uploadCalls()).toHaveLength(1);
    expect(harness.canvasFake.calls.some((c) => c.type === 'submit')).toBe(true);
  });

  it('refuses double-submit when the assignment is already submitted', async () => {
    const canvasFake = (await import('./helpers.js')).createCanvasFake({ submissionState: 'submitted' });
    const harness = createTestHarness({ canvasFake, permissionOverrides: { canvas_submission: true, canvas_file_upload: true } });
    const session = await seedSession(harness);
    const stopApprove = autoApprove(harness);
    cleanups.push(stopApprove);

    const job = await harness.store.createJob({
      userId: session.userId,
      kind: 'assignment_document',
      canvasCourseId: 101,
      canvasAssignmentId: 9001,
      sessionId: session.id,
    });
    await harness.orchestrator.scheduleAttempt({ job, attempt: 1 });
    const failed = await waitForJobState(harness.store, job.id, 'FAILED');

    expect(harness.canvasFake.uploadCalls()).toHaveLength(0);
    expect(failed.failureReason).toMatch(/refusing double-submit|submitted/);
  });

  it('retries a failed run once, then completes', async () => {
    const harness = createTestHarness();
    const session = await seedSession(harness);
    const stopApprove = autoApprove(harness);
    cleanups.push(stopApprove);

    let genCalls = 0;
    const inner = harness.aiFake; // not used directly; custom factory below
    const failingFactory = ({ aiKeys, log }) => {
      const real = inner.factory({ aiKeys, log });
      return {
        ...real,
        async generateStructured(args) {
          if (args.templateId === 'generate/discussion_post' && genCalls === 0) {
            genCalls += 1;
            const err = new Error('permanent generation failure');
            throw err; // PERMANENT → no in-run retry; triggers run-level retry
          }
          return real.generateStructured(args);
        },
      };
    };
    harness.orchestrator = (await import('../src/agent/orchestrator.js')).createOrchestrator({
      store: harness.store,
      canvasGateway: harness.canvasGateway,
      approvalGate: harness.approvalGate,
      sessionService: harness.sessionService,
      aiClientFactory: failingFactory,
      config: TEST_CONFIG,
      log: undefined,
    });

    const job = await harness.store.createJob({
      userId: session.userId,
      kind: 'discussion_post',
      canvasCourseId: 101,
      canvasAssignmentId: 9001,
      sessionId: session.id,
    });
    await harness.orchestrator.scheduleAttempt({ job, attempt: 1 });
    await waitForJobState(harness.store, job.id, 'COMPLETED');

    expect(genCalls).toBe(1);
    const runs = await harness.store.listRunsForJob(job.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.state).sort()).toEqual(['COMPLETED', 'FAILED']);
  });

  it('marks unsupported jobs terminally without executing writes', async () => {
    const aiFake = (await import('./helpers.js')).createAiFake({
      overrides: { capability_check: { supported: false, reason: 'video essays are not supported in v1', requires_user_action: false, user_action_reason: null } },
    });
    const harness = createTestHarness({ aiFake });
    const session = await seedSession(harness);

    const job = await harness.store.createJob({
      userId: session.userId,
      kind: 'discussion_post',
      canvasCourseId: 101,
      canvasAssignmentId: 9001,
      sessionId: session.id,
    });
    await harness.orchestrator.scheduleAttempt({ job, attempt: 1 });
    const done = await waitForJobState(harness.store, job.id, 'UNSUPPORTED');

    expect(done.failureReason).toContain('video essays');
    expect(harness.canvasFake.commentCalls()).toHaveLength(0);
  });

  it('cancels a job waiting on approval', async () => {
    const harness = createTestHarness();
    const session = await seedSession(harness);

    const job = await harness.store.createJob({
      userId: session.userId,
      kind: 'discussion_post',
      canvasCourseId: 101,
      canvasAssignmentId: 9001,
      sessionId: session.id,
    });
    await harness.orchestrator.scheduleAttempt({ job, attempt: 1 });

    // Wait until it is parked awaiting approval (approval row = wait started).
    let approval = null;
    for (let i = 0; i < 200 && !approval; i++) {
      const pending = await harness.store.listPendingApprovals();
      approval = pending.find((a) => a.jobId === job.id);
      if (!approval) await new Promise((r) => setTimeout(r, 10));
    }
    expect(approval).toBeTruthy();
    expect(harness.orchestrator.isRunning((await harness.store.latestRunForJob(job.id)).id)).toBe(true);

    await harness.orchestrator.cancelJob({ job: await harness.store.getJob(job.id) });
    await waitForJobState(harness.store, job.id, 'CANCELLED');

    const run = await waitForRunState(harness.store, (await harness.store.latestRunForJob(job.id)).id, 'CANCELLED');
    expect(run.state).toBe('CANCELLED');
    expect(harness.canvasFake.commentCalls()).toHaveLength(0);
  });

  it('startup sweep marks interrupted jobs FAILED', async () => {
    const harness = createTestHarness();
    const session = await seedSession(harness);
    const job = await harness.store.createJob({ userId: session.userId, kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001, sessionId: session.id });
    await harness.store.updateJob(job.id, { state: 'GENERATING' });
    const run = await harness.store.createRun({ jobId: job.id, attempt: 1 });

    const n = await harness.orchestrator.sweepInterruptedJobs();
    expect(n).toBe(1);
    const swept = await harness.store.getJob(job.id);
    expect(swept.state).toBe('FAILED');
    expect(swept.failureReason).toContain('interrupted');
    expect((await harness.store.getRun(run.id)).state).toBe('FAILED');
  });

  it('queue pump starts QUEUED jobs within capacity', async () => {
    const harness = createTestHarness();
    const session = await seedSession(harness);

    // Two real jobs occupying capacity, parked awaiting approval (no auto-approver).
    const occupying = [];
    for (let i = 0; i < 2; i++) {
      const j = await harness.store.createJob({ userId: session.userId, kind: 'discussion_post', canvasCourseId: 101, canvasAssignmentId: 9001, sessionId: session.id });
      await harness.orchestrator.scheduleAttempt({ job: j, attempt: 1 });
      occupying.push(j);
    }
    for (const j of occupying) {
      let approval = null;
      for (let i = 0; i < 200 && !approval; i++) {
        const pending = await harness.store.listPendingApprovals();
        approval = pending.find((a) => a.jobId === j.id);
        if (!approval) await new Promise((r) => setTimeout(r, 10));
      }
    }

    const queued = await harness.store.createJob({ userId: session.userId, kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001, sessionId: session.id });
    await harness.store.updateJob(queued.id, { state: 'QUEUED' });

    const started = await harness.orchestrator.pumpQueue();
    // user is at capacity (2 EXECUTING) → nothing starts
    expect(started).toBe(0);

    // Free a slot: cancel one occupying job.
    await harness.orchestrator.cancelJob({ job: occupying[0] });
    await waitForJobState(harness.store, occupying[0].id, 'CANCELLED');

    const started2 = await harness.orchestrator.pumpQueue();
    expect(started2).toBe(1);
    // The pump fires the attempt in the background — wait for it to leave QUEUED.
    const after = await waitForJobState(harness.store, queued.id, [
      'ANALYZING', 'CAPABILITY_CHECK', 'PLANNING', 'GENERATING', 'REFINING', 'VALIDATING', 'READY', 'EXECUTING', 'FAILED', 'UNSUPPORTED', 'COMPLETED',
    ]);
    expect(after.state).not.toBe('QUEUED');
  });

  it('run logs never contain tokens or keys (redaction regression test)', async () => {
    const harness = createTestHarness({ permissionOverrides: { canvas_submission: true, canvas_file_upload: true } });
    const session = await seedSession(harness);
    const stopApprove = autoApprove(harness);
    cleanups.push(stopApprove);

    const job = await harness.store.createJob({
      userId: session.userId,
      kind: 'assignment_document',
      canvasCourseId: 101,
      canvasAssignmentId: 9001,
      sessionId: session.id,
    });
    await harness.orchestrator.scheduleAttempt({ job, attempt: 1 });
    await waitForJobState(harness.store, job.id, 'COMPLETED');

    const run = await harness.store.latestRunForJob(job.id);
    const logBlob = await harness.store.listAllRunLogStrings(run.id);
    expect(logBlob).not.toContain('canvas-test-token');
    expect(logBlob).not.toContain('fake-gemini-key');
    expect(logBlob).not.toContain(TEST_CONFIG.jwtSecret);
  });

  it('pino redact paths censor token-shaped fields', () => {
    const chunks = [];
    const stream = { write: (c) => chunks.push(c) };
    const logger = pino({ level: 'info', redact: { paths: ['token', 'byok.*', 'canvasToken', 'apiKey'], censor: '[REDACTED]' } }, stream);
    logger.info({ token: 'secret-token-value', byok: { g: 'gemini-secret' }, ok: 'fine' }, 'hello');
    const out = chunks.join('');
    expect(out).not.toContain('secret-token-value');
    expect(out).not.toContain('gemini-secret');
    expect(out).toContain('fine');
  });
});
