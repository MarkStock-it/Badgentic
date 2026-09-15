import { AppError, ERROR_CODES } from '../errors.js';

/**
 * Approval gate (spec §5.3): every Canvas write (SUBMISSION | COMMENT |
 * FILE_UPLOAD) blocks on a PENDING approval row that the user approves or
 * denies. Approvals expire after 24h (auto-expired by the startup sweep).
 */
export function createApprovalGate({ store, approvalTtlMs = 24 * 3600 * 1000 }) {
  async function requestApproval({ jobId, runId, type, payload, artifactId = null }) {
    return store.createApproval({
      jobId,
      runId,
      type,
      payload,
      artifactId,
      expiresAt: new Date(Date.now() + approvalTtlMs),
    });
  }

  /** Wait for a decision, with polling; supports abort + expiry. */
  async function awaitDecision({ approvalId, signal, pollMs = 2000, timeoutMs = 24 * 3600 * 1000 }) {
    const start = Date.now();
    while (!signal?.aborted && Date.now() - start < timeoutMs) {
      const approval = await store.getApproval(approvalId);
      if (!approval) throw new AppError(ERROR_CODES.INTERNAL, 'Approval record vanished');
      if (new Date(approval.expiresAt).getTime() <= Date.now()) {
        await store.updateApproval(approvalId, { state: 'EXPIRED' });
        throw new AppError(ERROR_CODES.APPROVAL_EXPIRED, 'Approval expired');
      }
      if (approval.state === 'APPROVED') return approval;
      if (approval.state === 'DENIED') {
        throw new AppError(ERROR_CODES.CANCELLED, 'User denied the Canvas write');
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new AppError(ERROR_CODES.CANCELLED, 'Approval wait aborted');
  }

  async function expireStale() {
    const pending = await store.listPendingApprovals();
    let n = 0;
    for (const a of pending) {
      if (new Date(a.expiresAt).getTime() <= Date.now()) {
        await store.updateApproval(a.id, { state: 'EXPIRED' });
        n += 1;
      }
    }
    return n;
  }

  return { requestApproval, awaitDecision, expireStale };
}
