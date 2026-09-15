import { Router } from 'express';
import { AppError, ERROR_CODES } from '../../errors.js';
import { requireSession, requireCsrf } from '../middleware.js';
import { getCapability } from '../../agent/capabilities.js';
import { TERMINAL_STATES } from '../../agent/orchestrator.js';

function requireOwnedJob(req) {
  const job = req.locals?.job;
  if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, 'Job not found');
  if (job.userId !== req.session.userId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Not your job');
  }
  return job;
}

/**
 * Job routes (spec §7.2, §7.3). All ownership-checked (artifact → job → user
 * join check pattern from the security checklist).
 */
export function createJobRoutes({ store, orchestrator, config }) {
  const router = Router();

  // POST /jobs — create + queue (concurrency-aware)
  router.post('/jobs', async (req, res, next) => {
    try {
      requireSession(req);
      requireCsrf(req);
      const { kind, canvasCourseId, canvasAssignmentId, title } = req.body || {};
      if (!getCapability(kind)) {
        throw new AppError(ERROR_CODES.VALIDATION, `Unknown job kind: ${kind}`, {
          details: { supported: ['assignment_document', 'discussion_post', 'study_deck'] },
        });
      }
      if (!canvasCourseId || !canvasAssignmentId) {
        throw new AppError(ERROR_CODES.VALIDATION, 'canvasCourseId and canvasAssignmentId are required');
      }

      const activeForUser = await store.countActiveJobsByUser(req.session.userId);
      const atLimit = activeForUser >= config.maxConcurrentJobsPerUser;

      const job = await store.createJob({
        userId: req.session.userId,
        kind,
        title: String(title || '').slice(0, 500),
        canvasCourseId: Number(canvasCourseId),
        canvasAssignmentId: Number(canvasAssignmentId),
        sessionId: req.sessionId,
      });

      if (atLimit) {
        // Park in QUEUED; the queue pump starts it when capacity frees up.
        await store.updateJob(job.id, { state: 'QUEUED' });
      } else {
        await orchestrator.scheduleAttempt({ job: { ...job, state: 'QUEUED' }, attempt: 1 });
      }

      const full = await store.getJob(job.id);
      res.status(201).json(full);
    } catch (err) {
      next(err);
    }
  });

  // GET /jobs — list own jobs (cursor pagination, newest first)
  router.get('/jobs', async (req, res, next) => {
    try {
      requireSession(req);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const state = req.query.state ? String(req.query.state) : null;
      const cursor = req.query.cursor ? String(req.query.cursor) : null;
      const jobs = await store.listJobs({
        userId: req.session.userId,
        state,
        limit: limit + 1,
        createdBefore: cursor,
      });
      const hasMore = jobs.length > limit;
      const page = hasMore ? jobs.slice(0, limit) : jobs;
      res.json({
        jobs: page,
        nextCursor: hasMore ? page[page.length - 1].createdAt : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /jobs/:jobId — full job incl. latest run
  router.get('/jobs/:jobId', async (req, res, next) => {
    try {
      requireSession(req);
      const job = await store.getJob(req.params.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      const latestRun = await store.latestRunForJob(job.id);
      res.json({ job, latestRun });
    } catch (err) {
      next(err);
    }
  });

  // POST /jobs/:jobId/cancel — non-terminal only; aborts in-flight runs
  router.post('/jobs/:jobId/cancel', async (req, res, next) => {
    try {
      requireSession(req);
      requireCsrf(req);
      const job = await store.getJob(req.params.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      if (TERMINAL_STATES.has(job.state)) {
        throw new AppError(ERROR_CODES.CONFLICT, `Job already ${job.state}`);
      }
      await orchestrator.cancelJob({ job });
      const updated = await store.getJob(job.id);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // POST /jobs/:jobId/retry — new run for a FAILED job, respecting attempt cap
  router.post('/jobs/:jobId/retry', async (req, res, next) => {
    try {
      requireSession(req);
      requireCsrf(req);
      const job = await store.getJob(req.params.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      if (job.state !== 'FAILED') {
        throw new AppError(ERROR_CODES.CONFLICT, `Retry is only available for FAILED jobs (job is ${job.state})`);
      }
      const latest = await store.latestRunForJob(job.id);
      const attempt = (latest?.attempt || 0) + 1;
      if (attempt > config.maxRunAttempts) {
        throw new AppError(ERROR_CODES.CONFLICT, `Attempt cap reached (${config.maxRunAttempts})`);
      }
      await store.updateJob(job.id, { state: 'QUEUED', failureReason: null });
      await orchestrator.scheduleAttempt({ job: { ...job, state: 'QUEUED' }, attempt });
      const updated = await store.getJob(job.id);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // GET /jobs/:jobId/runs — attempts, newest first
  router.get('/jobs/:jobId/runs', async (req, res, next) => {
    try {
      requireSession(req);
      const job = await store.getJob(req.params.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      res.json({ runs: await store.listRunsForJob(job.id) });
    } catch (err) {
      next(err);
    }
  });

  // GET /runs/:runId/logs?sinceSeq= — incremental log tail
  router.get('/runs/:runId/logs', async (req, res, next) => {
    try {
      requireSession(req);
      const run = await store.getRun(req.params.runId);
      if (!run) throw new AppError(ERROR_CODES.NOT_FOUND, 'Run not found');
      const job = await store.getJob(run.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      const sinceSeq = Number(req.query.sinceSeq) || 0;
      const logs = await store.listLogs({ runId: run.id, sinceSeq, limit: 500 });
      res.json({ logs, nextSeq: logs.length ? logs[logs.length - 1].seq : sinceSeq });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
