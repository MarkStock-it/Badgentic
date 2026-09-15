import { AppError, ERROR_CODES } from '../errors.js';
import { sleep } from '../util/result.js';
import { sha256Hex } from '../util/id.js';
import { classifyError, fetchWithTransientRetry } from './error-classifier.js';
import { createAiClient } from './prompt-templates.js';
import { buildArtifact, draftToMarkdownExport } from './doc-builder.js';
import { getCapability, assignmentSupportsCapability } from './capabilities.js';
import { PERMISSIONS, DEFAULT_PERMISSIONS, isAllowed } from './agent-permissions.js';

export const TERMINAL_STATES = new Set(['COMPLETED', 'UNSUPPORTED', 'FAILED', 'CANCELLED']);
const NON_RETRIABLE = new Set(['UNSUPPORTED', 'USER_ACTION_REQUIRED']);

const PIPELINE_STATES = [
  'QUEUED',
  'DISCOVERED',
  'ANALYZING',
  'CAPABILITY_CHECK',
  'PLANNING',
  'GENERATING',
  'REFINING',
  'VALIDATING',
  'READY',
  'EXECUTING',
];

/**
 * Orchestrator (spec §5): drives ANALYZING → … → COMPLETED with approval-gated
 * Canvas writes, an in-memory run registry for cancellation, attempt-based
 * run retries (QUEUED between attempts), and AbortSignal wall-clock bounds.
 */
export function createOrchestrator({
  store,
  canvasGateway,
  approvalGate,
  sessionService,
  aiClientFactory = createAiClient,
  permissionOverrides = {},
  config,
  log,
}) {
  const registry = new Map(); // runId -> { controller, run, job }

  function maxAttempts() {
    return Math.max(1, Number(config.maxRunAttempts || 2));
  }

  /**
   * Start (or schedule) one attempt: fresh run row + AbortController, then
   * execute in the background. Called by routes and by the retry layer.
   */
  async function scheduleAttempt({ job, attempt }) {
    if (attempt > maxAttempts()) {
      await store.updateJob(job.id, { state: 'FAILED', failureReason: `Exceeded max attempts (${maxAttempts()})` });
      return null;
    }
    const controller = new AbortController();
    const run = await store.createRun({ jobId: job.id, attempt });
    registry.set(run.id, { controller, run, job });

    const timeout = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, config.maxJobWallTimeMs);

    executeAttempt({ job, run, controller })
      .catch((err) => log?.error({ err: err.message, runId: run.id }, 'attempt handler crashed'))
      .finally(() => {
        clearTimeout(timeout);
        registry.delete(run.id);
      });
    return run;
  }

  async function executeAttempt({ job, run, controller }) {
    const { signal } = controller;
    const backoffSleep = (ms) => sleep(ms, { signal });

    let seq = 0;
    const emit = async (type, detail = null) => {
      try {
        await store.appendLog({ runId: run.id, seq: ++seq, type, detail });
      } catch (err) {
        log?.warn({ err: err.message }, 'log append failed');
      }
    };

    const aiCounts = { calls: 0 };
    const aiBudget = Math.max(1, Number(config.maxAiCalls || 10));
    async function aiCall(templateId, ctx) {
      aiCounts.calls += 1;
      if (aiCounts.calls > aiBudget) {
        throw new AppError(ERROR_CODES.INTERNAL, `AI call budget exhausted (${aiBudget})`);
      }
      await emit('AI_CALL', { templateId, templateVersion: ai.templateVersion(templateId), call: aiCounts.calls });
      const out = await fetchWithTransientRetry(
        () => ai.generateStructured({ templateId, context: ctx, signal }),
        { sleepImpl: backoffSleep }
      );
      await emit('AI_RESULT', { templateId, usage: out.usage || null });
      return out.json;
    }

    // Credentials decrypt once per run, live only in memory, dropped after.
    let creds;
    try {
      creds = await sessionService.getRunCredentials({ sessionId: job.sessionId });
    } catch (err) {
      await finalizeFailure({ job, run, message: `Credentials unavailable: ${err.message}`, retriable: false });
      return;
    }

    let ai;
    try {
      ai = aiClientFactory({ aiKeys: creds.aiKeys, log });
    } catch (err) {
      await finalizeFailure({ job, run, message: err.message, retriable: false });
      return;
    }

    const freshJob = (await store.getJob(job.id)) || job;
    const user = (await store.getUser?.(freshJob.userId)) || null;
    const domain = user?.canvasDomain;
    const canvasToken = creds.canvasToken;

    const requireCanvasCtx = () => {
      if (!canvasToken || !domain) {
        throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Canvas token missing — paste it to continue', {
          hint: 'Open Settings and paste your Canvas token.',
        });
      }
      return { userId: freshJob.userId, token: canvasToken, domain };
    };

    try {
      await store.updateJob(freshJob.id, { state: 'ANALYZING' });
      await emit('STEP_START', { step: 'ANALYZING', attempt: run.attempt });

      // ---- 1. ANALYZING: fetch assignment + course, AI analysis ----
      const canvasCtx = requireCanvasCtx();
      const assignment = await fetchWithTransientRetry(
        () =>
          canvasGateway.getAssignment({
            ...canvasCtx,
            courseId: freshJob.canvasCourseId,
            assignmentId: freshJob.canvasAssignmentId,
          }),
        { sleepImpl: backoffSleep }
      );
      const course = await fetchWithTransientRetry(() => canvasGateway.listCourses({ ...canvasCtx }), {
        sleepImpl: backoffSleep,
      }).then((list) => list.find((c) => String(c.id) === String(freshJob.canvasCourseId)) || null);

      const analysisCtx = {
        assignment: {
          name: assignment.name,
          course: course ? { name: course.name, course_code: course.course_code } : { name: '', course_code: '' },
          due_at: assignment.due_at,
          points_possible: assignment.points_possible,
          submission_types: assignment.submission_types,
          description: stripHtml(assignment.description || ''),
        },
      };
      const analysis = await aiCall('analyze', analysisCtx);

      // ---- 2. CAPABILITY_CHECK: registry rules first, AI confirmation second ----
      await store.updateJob(freshJob.id, { state: 'CAPABILITY_CHECK' });
      await emit('STEP_START', { step: 'CAPABILITY_CHECK' });

      const capability = getCapability(freshJob.kind);
      let verdict;
      if (!capability) {
        verdict = { supported: false, reason: `Unknown capability: ${freshJob.kind}` };
      } else {
        const support = assignmentSupportsCapability(assignment, capability);
        verdict = { supported: support.ok, reason: support.reason || null };
        try {
          const aiVerdict = await aiCall('capability_check', { ...analysisCtx, analysis, kind: freshJob.kind });
          if (aiVerdict?.supported === false && verdict.supported) {
            verdict = { ...verdict, supported: false, reason: aiVerdict.reason || verdict.reason };
          }
          if (aiVerdict?.requires_user_action === true && verdict.supported) {
            verdict = { ...verdict, requires_user_action: true, user_action_reason: aiVerdict.user_action_reason || null };
          }
        } catch {
          // AI check unavailable → registry verdict stands.
        }
      }

      await store.updateJob(freshJob.id, {
        manifest: { capability: freshJob.kind, verdict, checkedAt: new Date().toISOString() },
      });

      if (!verdict.supported) {
        await store.updateJob(freshJob.id, {
          state: 'UNSUPPORTED',
          failureReason: verdict.reason || 'Capability not supported for this assignment',
        });
        await finishRun(run, 'FAILED', 'unsupported capability');
        return;
      }
      if (verdict.requires_user_action) {
        await store.updateJob(freshJob.id, {
          state: 'USER_ACTION_REQUIRED',
          failureReason: verdict.user_action_reason || 'user action required',
        });
        await finishRun(run, 'FAILED', 'user action required');
        return;
      }

      // ---- 3. PLANNING ----
      await store.updateJob(freshJob.id, { state: 'PLANNING' });
      await emit('STEP_START', { step: 'PLANNING' });
      const plan = await aiCall('plan', { ...analysisCtx, analysis });

      // ---- 4. GENERATING ----
      await store.updateJob(freshJob.id, { state: 'GENERATING' });
      await emit('STEP_START', { step: 'GENERATING' });
      const draft = await aiCall(capability.generateTemplate, { ...analysisCtx, analysis, plan });

      // ---- 5. REFINING (best-effort) ----
      await store.updateJob(freshJob.id, { state: 'REFINING' });
      await emit('STEP_START', { step: 'REFINING' });
      let refined = draft;
      try {
        refined = await aiCall('refine', { ...analysisCtx, analysis, plan, draft });
      } catch {
        await emit('STEP_SKIPPED', { step: 'REFINING', reason: 'refinement unavailable' });
      }

      // ---- 6. VALIDATING (best-effort) ----
      await store.updateJob(freshJob.id, { state: 'VALIDATING' });
      await emit('STEP_START', { step: 'VALIDATING' });
      let validation = { verdict: 'PASS', checks: [], missing: [] };
      try {
        validation = await aiCall('validate', { ...analysisCtx, analysis, draft: refined });
      } catch {
        await emit('STEP_SKIPPED', { step: 'VALIDATING', reason: 'validation unavailable' });
      }

      // ---- 7. READY: build + persist artifact ----
      await store.updateJob(freshJob.id, { state: 'READY' });
      await emit('STEP_START', { step: 'READY' });
      const built = await buildArtifact({ capability, draft: refined });
      const artifact = await store.createArtifact({
        jobId: freshJob.id,
        runId: run.id,
        filename: `${slugify(refined?.title || freshJob.title || capability.kind)}.${capability.artifact.ext}`,
        mimeType: built.mimeType,
        sizeBytes: built.content.length,
        contentBase64: built.content.toString('base64'),
        checksum: sha256Hex(built.content),
      });
      await emit('ARTIFACT_READY', { artifactId: artifact.id, filename: artifact.filename, sizeBytes: artifact.sizeBytes });

      const result = {
        summary: analysis?.summary || '',
        validationVerdict: validation?.verdict || 'PASS',
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
        },
      };
      await store.updateJob(freshJob.id, { plan, result, title: refined?.title || freshJob.title });

      // ---- 8. EXECUTING: approval-gated Canvas write (when the capability writes) ----
      if (capability.write) {
        await assertPermissions(capability);
        await store.updateJob(freshJob.id, { state: 'EXECUTING' });
        await emit('STEP_START', { step: 'EXECUTING' });
        await emit('AWAITING_APPROVAL', { type: capability.write });

        const approval = await approvalGate.requestApproval({
          jobId: freshJob.id,
          runId: run.id,
          type: capability.write,
          payload: buildWritePayload({ capability, job: freshJob, artifact, draft: refined }),
          artifactId: capability.write === 'SUBMISSION' ? artifact.id : null,
        });
        await approvalGate.awaitDecision({ approvalId: approval.id, signal, pollMs: config.approvalPollMs || 2000 });
        await emit('APPROVAL_GRANTED', { approvalId: approval.id });

        const writeCtx = requireCanvasCtx();
        const writeResult = await performWrite({
          capability,
          ctx: writeCtx,
          job: freshJob,
          artifact,
          comment: draftToMarkdownExport(refined),
        });
        await emit('CANVAS_WRITE', { type: capability.write, ok: true });
        result.canvasWrite = { type: capability.write, at: new Date().toISOString() };
        result.canvasResponse = writeResult || null;
        await store.updateJob(freshJob.id, { result });
      }

      await store.updateJob(freshJob.id, { state: 'COMPLETED' });
      await finishRun(run, 'COMPLETED');
    } catch (err) {
      await handleAttemptError({ err, job: freshJob, run, attempt: run.attempt, emit });
    }
  }

  // ---- helpers ----

  async function handleAttemptError({ err, job, run, attempt, emit }) {
    const cls = classifyError(err);
    try {
      await emit('ERROR', { message: err.message, kind: cls.kind });
    } catch {}

    if (cls.cancelled) {
      await finishRun(run, 'CANCELLED', 'cancelled');
      await store.updateJob(job.id, { state: 'CANCELLED', failureReason: 'cancelled' });
      return;
    }

    const retriable =
      attempt < maxAttempts() &&
      cls.kind !== 'UNAUTHORIZED' &&
      !cls.noRetry &&
      !NON_RETRIABLE.has(job.state);
    await finalizeFailure({ job, run, message: err.message, retriable, nextAttempt: retriable ? attempt + 1 : null });
  }

  async function finalizeFailure({ job, run, message, retriable, nextAttempt = null }) {
    await finishRun(run, 'FAILED', message);
    if (retriable && nextAttempt && nextAttempt <= maxAttempts()) {
      await store.updateJob(job.id, { state: 'QUEUED', failureReason: message });
      log?.warn({ jobId: job.id, nextAttempt }, 'run failed — scheduling retry');
      const delay = config.retryRunBackoffMs;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await scheduleAttempt({ job: { ...job, state: 'QUEUED' }, attempt: nextAttempt });
    } else {
      await store.updateJob(job.id, { state: 'FAILED', failureReason: message });
    }
  }

  async function finishRun(run, state, error = null) {
    await store.updateRun(run.id, { state, finishedAt: new Date(), error: error || null });
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
  }

  function slugify(text) {
    return (
      String(text || 'artifact')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'artifact'
    );
  }

  async function assertPermissions(capability) {
    const effective = { ...DEFAULT_PERMISSIONS, ...permissionOverrides };
    const missing = capability.requiredPermissions.filter((p) => !isAllowed(effective, p));
    if (missing.length > 0) {
      throw new AppError(ERROR_CODES.PERMISSION_REQUIRED, `Missing permissions: ${missing.join(', ')}`, {
        hint: 'Enable the needed permissions in settings before retrying.',
      });
    }
  }

  function buildWritePayload({ capability, job, artifact, draft }) {
    if (capability.write === 'SUBMISSION') {
      return {
        courseId: job.canvasCourseId,
        assignmentId: job.canvasAssignmentId,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      };
    }
    return {
      courseId: job.canvasCourseId,
      assignmentId: job.canvasAssignmentId,
      commentPreview: draftToMarkdownExport(draft).slice(0, 500),
    };
  }

  async function performWrite({ capability, ctx, job, artifact, comment }) {
    if (capability.write === 'SUBMISSION') {
      const row = await store.getArtifactWithContent(artifact.id);
      const buf = Buffer.from(row.content, 'base64');
      return canvasGateway.uploadAndSubmit({
        ...ctx,
        courseId: job.canvasCourseId,
        assignmentId: job.canvasAssignmentId,
        file: { filename: artifact.filename, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes, content: buf },
      });
    }
    if (capability.write === 'COMMENT') {
      return canvasGateway.postComment({
        ...ctx,
        courseId: job.canvasCourseId,
        assignmentId: job.canvasAssignmentId,
        comment,
      });
    }
    return null;
  }

  // ---- registry API (cancellation + sweeps) ----

  function isRunning(runId) {
    return registry.has(runId);
  }

  async function cancelJob({ job }) {
    for (const [runId, entry] of registry.entries()) {
      if (entry.job.id === job.id) {
        try {
          entry.controller.abort();
        } catch {}
        registry.delete(runId);
      }
    }
    await store.updateJob(job.id, { state: 'CANCELLED', failureReason: 'cancelled by user' });
  }

  /** Startup sweep (spec §2.4): non-terminal jobs after a restart → FAILED (interrupted). */
  async function sweepInterruptedJobs() {
    const stale = await store.listJobsByState(PIPELINE_STATES.filter((s) => s !== 'QUEUED'));
    for (const job of stale) {
      await store.updateJob(job.id, {
        state: 'FAILED',
        failureReason: 'FAILED (interrupted) — service restarted mid-job',
      });
      const run = await store.latestRunForJob(job.id);
      if (run && run.state === 'RUNNING') {
        await store.updateRun(run.id, { state: 'FAILED', finishedAt: new Date(), error: 'interrupted by restart' });
      }
    }
    return stale.length;
  }

  /** Periodic sweep: expire stale approvals. */
  async function sweepApprovals() {
    return approvalGate.expireStale();
  }

  /**
   * Queue pump: starts QUEUED jobs when capacity frees up (per-user and
   * global limits, spec §2.3). Runs on an interval; also safe to call manually.
   */
  async function pumpQueue() {
    try {
      const queued = await store.listJobsByState(['QUEUED']);
      if (queued.length === 0) return 0;
      let globalActive = await store.countNonTerminalJobs();
      let started = 0;
      for (const job of queued) {
        if (globalActive >= config.maxConcurrentJobsGlobal) break;
        const userActive = await store.countActiveJobsByUser(job.userId);
        if (userActive >= config.maxConcurrentJobsPerUser) continue;
        const latest = await store.latestRunForJob(job.id);
        const attempt = latest ? latest.attempt + 1 : 1;
        globalActive += 1;
        started += 1;
        await scheduleAttempt({ job, attempt });
      }
      return started;
    } catch (err) {
      log?.error({ err: err.message }, 'queue pump failed');
      return 0;
    }
  }

  function startQueuePump({ intervalMs = 5000 } = {}) {
    const timer = setInterval(() => {
      pumpQueue();
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  return {
    scheduleAttempt,
    isRunning,
    cancelJob,
    sweepInterruptedJobs,
    sweepApprovals,
    pumpQueue,
    startQueuePump,
    _registry: registry,
    TERMINAL_STATES,
  };
}
