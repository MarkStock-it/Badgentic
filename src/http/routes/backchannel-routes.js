import { Router } from 'express';
import { AppError, ERROR_CODES } from '../../errors.js';
import { requireBackChannel } from '../middleware.js';

/**
 * Back-channel (spec §7.4): BetterCLSS polls these with a long-lived opaque
 * Bearer token. Read-only projection — never includes tokens, keys, or
 * session ids. BetterCLSS computes userIdHash locally; no id mapping.
 */
export function createBackChannelRoutes({ store, config }) {
  const router = Router();

  function projection(job) {
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      title: job.title,
      canvasCourseId: job.canvasCourseId,
      canvasAssignmentId: job.canvasAssignmentId,
      resultSummary: job.result?.summary || null,
      hasArtifact: Boolean(job.result?.artifact),
      failureReason: job.failureReason || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  router.use('/users/:userIdHash', (req, res, next) => {
    try {
      requireBackChannel(req, config);
      next();
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/users/:userIdHash/jobs?since=<iso>
  router.get('/users/:userIdHash/jobs', async (req, res, next) => {
    try {
      const since = req.query.since ? String(req.query.since) : new Date(0).toISOString();
      const jobs = await store.listJobsUpdatedSince(req.params.userIdHash, since);
      res.json({ jobs: jobs.map(projection) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/users/:userIdHash/jobs/:jobId
  router.get('/users/:userIdHash/jobs/:jobId', async (req, res, next) => {
    try {
      const job = await store.getJob(req.params.jobId);
      if (!job || job.userId !== req.params.userIdHash) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Job not found');
      }
      res.json({ job: projection(job) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
