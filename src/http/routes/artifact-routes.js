import { Router } from 'express';
import { AppError, ERROR_CODES } from '../../errors.js';
import { requireSession, requireCsrf } from '../middleware.js';
import { sha256Hex } from '../../util/id.js';

function requireOwnedJob(req) {
  const job = req.locals?.job;
  if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, 'Job not found');
  if (job.userId !== req.session.userId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Not your job');
  }
  return job;
}

/** Artifact + approval routes (spec §7.3). */
export function createArtifactRoutes({ store }) {
  const router = Router();

  // GET /jobs/:jobId/artifacts — metadata only
  router.get('/jobs/:jobId/artifacts', async (req, res, next) => {
    try {
      requireSession(req);
      const job = await store.getJob(req.params.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      res.json({ artifacts: await store.listArtifactsForJob(job.id) });
    } catch (err) {
      next(err);
    }
  });

  // GET /artifacts/:artifactId/download — stream content, checksum verified
  router.get('/artifacts/:artifactId/download', async (req, res, next) => {
    try {
      requireSession(req);
      const artifact = await store.getArtifactWithContent(req.params.artifactId);
      if (!artifact) throw new AppError(ERROR_CODES.NOT_FOUND, 'Artifact not found');
      const job = await store.getJob(artifact.jobId);
      req.locals = { job };
      requireOwnedJob(req); // artifact → job → user join check (§9 risk 9)

      const buf = Buffer.from(artifact.content, 'base64');
      if (sha256Hex(buf) !== artifact.checksum) {
        throw new AppError(ERROR_CODES.INTERNAL, 'Artifact checksum mismatch');
      }
      res.setHeader('Content-Type', artifact.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
      res.setHeader('Content-Length', String(buf.length));
      res.send(buf);
    } catch (err) {
      next(err);
    }
  });

  // GET /jobs/:jobId/approvals — pending + history
  router.get('/jobs/:jobId/approvals', async (req, res, next) => {
    try {
      requireSession(req);
      const job = await store.getJob(req.params.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      res.json({ approvals: await store.listApprovalsForJob(job.id) });
    } catch (err) {
      next(err);
    }
  });

  // POST /approvals/:approvalId/approve — triggers the gated Canvas write
  router.post('/approvals/:approvalId/approve', async (req, res, next) => {
    try {
      requireSession(req);
      requireCsrf(req);
      const approval = await store.getApproval(req.params.approvalId);
      if (!approval) throw new AppError(ERROR_CODES.NOT_FOUND, 'Approval not found');
      const job = await store.getJob(approval.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      if (approval.state !== 'PENDING') {
        throw new AppError(ERROR_CODES.CONFLICT, `Approval already ${approval.state}`);
      }
      if (new Date(approval.expiresAt).getTime() <= Date.now()) {
        await store.updateApproval(approval.id, { state: 'EXPIRED' });
        throw new AppError(ERROR_CODES.APPROVAL_EXPIRED, 'Approval window has expired');
      }
      const updated = await store.updateApproval(approval.id, { state: 'APPROVED', decidedAt: new Date() });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // POST /approvals/:approvalId/deny
  router.post('/approvals/:approvalId/deny', async (req, res, next) => {
    try {
      requireSession(req);
      requireCsrf(req);
      const approval = await store.getApproval(req.params.approvalId);
      if (!approval) throw new AppError(ERROR_CODES.NOT_FOUND, 'Approval not found');
      const job = await store.getJob(approval.jobId);
      req.locals = { job };
      requireOwnedJob(req);
      if (approval.state !== 'PENDING') {
        throw new AppError(ERROR_CODES.CONFLICT, `Approval already ${approval.state}`);
      }
      const updated = await store.updateApproval(approval.id, {
        state: 'DENIED',
        decidedAt: new Date(),
        payload: { ...(approval.payload || {}), denyReason: String(req.body?.reason || '') },
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
