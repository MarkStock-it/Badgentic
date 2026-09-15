import { newId } from '../util/id.js';

function nowIso() {
  return new Date().toISOString();
}

function clone(v) {
  if (v == null) return v;
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

/**
 * In-memory store (spec §2.1: repos implement one interface; the memory
 * implementation is the test double — the whole suite runs offline, no DB).
 */
export function createMemoryStore() {
  const users = new Map();
  const sessions = new Map();
  const jobs = new Map();
  const runs = new Map();
  const runLogs = new Map(); // runId -> logs[]
  const artifacts = new Map();
  const approvals = new Map();
  const cache = new Map(); // `${userId}|${resource}` -> { payload, expiresAt }

  function touchUser(id) {
    const u = users.get(id);
    if (u) u.lastSeenAt = nowIso();
  }

  return {
    driver: 'memory',

    // ---- users ----
    async upsertUser({ id, canvasDomain, canvasUserId, displayName = '', email = '' }) {
      const existing = users.get(id);
      if (existing) {
        existing.displayName = displayName || existing.displayName;
        existing.email = email || existing.email;
        existing.lastSeenAt = nowIso();
        return clone(existing);
      }
      const row = {
        id,
        canvasDomain,
        canvasUserId,
        displayName,
        email,
        createdAt: nowIso(),
        lastSeenAt: nowIso(),
      };
      users.set(id, row);
      return clone(row);
    },

    async touchUserLastSeen(id) {
      touchUser(id);
    },

    async getUser(id) {
      const row = users.get(id);
      return row ? clone(row) : null;
    },

    // ---- sessions ----
    async createSession({ userId, canvasTokenEnc = null, tokenIv = null, tokenTag = null, aiKeysEnc = null, expiresAt }) {
      const row = {
        id: newId(),
        userId,
        canvasTokenEnc,
        tokenIv,
        tokenTag,
        aiKeysEnc: aiKeysEnc ? clone(aiKeysEnc) : null,
        expiresAt: expiresAt.toISOString(),
        createdAt: nowIso(),
      };
      sessions.set(row.id, row);
      return clone(row);
    },

    async getSession(id) {
      const row = sessions.get(id);
      if (!row) return null;
      if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
      return clone(row);
    },

    async updateSessionCanvasToken(id, { canvasTokenEnc, tokenIv, tokenTag }) {
      const row = sessions.get(id);
      if (!row) return null;
      Object.assign(row, { canvasTokenEnc, tokenIv, tokenTag });
      return clone(row);
    },

    async updateSessionAiKeys(id, aiKeysEnc) {
      const row = sessions.get(id);
      if (!row) return null;
      row.aiKeysEnc = aiKeysEnc ? clone(aiKeysEnc) : null;
      return clone(row);
    },

    async deleteSession(id) {
      return sessions.delete(id);
    },

    async deleteExpiredSessions(now = new Date()) {
      let n = 0;
      for (const [id, s] of sessions) {
        if (new Date(s.expiresAt).getTime() <= now.getTime()) {
          sessions.delete(id);
          n += 1;
        }
      }
      return n;
    },

    // ---- jobs ----
    async createJob({ userId, kind, title = '', canvasCourseId = null, canvasAssignmentId = null, sessionId = null, manifest = null, plan = null }) {
      const row = {
        id: newId(),
        userId,
        kind,
        state: 'DISCOVERED',
        title,
        canvasCourseId,
        canvasAssignmentId,
        sessionId,
        manifest: manifest ? clone(manifest) : null,
        plan: plan ? clone(plan) : null,
        result: null,
        failureReason: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      jobs.set(row.id, row);
      return clone(row);
    },

    async getJob(id) {
      const row = jobs.get(id);
      return row ? clone(row) : null;
    },

    async listJobs({ userId, state = null, limit = 50, createdBefore = null }) {
      let rows = [...jobs.values()].filter((j) => j.userId === userId);
      if (state) rows = rows.filter((j) => j.state === state);
      if (createdBefore) rows = rows.filter((j) => new Date(j.createdAt).getTime() < new Date(createdBefore).getTime());
      rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return clone(rows.slice(0, limit));
    },

    async listJobsUpdatedSince(userId, sinceIso) {
      const since = new Date(sinceIso).getTime();
      const rows = [...jobs.values()]
        .filter((j) => j.userId === userId && new Date(j.updatedAt).getTime() >= since)
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return clone(rows);
    },

    async updateJob(id, patch) {
      const row = jobs.get(id);
      if (!row) return null;
      const allowed = ['state', 'title', 'manifest', 'plan', 'result', 'failureReason', 'canvasCourseId', 'canvasAssignmentId'];
      for (const k of allowed) {
        if (k in patch) row[k] = patch[k];
      }
      row.updatedAt = nowIso();
      return clone(row);
    },

    async countActiveJobsByUser(userId) {
      // Capacity counts RUNNING jobs only — QUEUED jobs are waiting, not occupying.
      const active = new Set(['DISCOVERED', 'ANALYZING', 'CAPABILITY_CHECK', 'PLANNING', 'GENERATING', 'REFINING', 'VALIDATING', 'READY', 'EXECUTING', 'USER_ACTION_REQUIRED']);
      let n = 0;
      for (const j of jobs.values()) {
        if (j.userId === userId && active.has(j.state)) n += 1;
      }
      return n;
    },

    async countNonTerminalJobs() {
      const active = new Set(['DISCOVERED', 'ANALYZING', 'CAPABILITY_CHECK', 'PLANNING', 'GENERATING', 'REFINING', 'VALIDATING', 'READY', 'EXECUTING', 'USER_ACTION_REQUIRED']);
      let n = 0;
      for (const j of jobs.values()) {
        if (active.has(j.state)) n += 1;
      }
      return n;
    },

    async listJobsByState(states) {
      const set = new Set(states);
      return clone([...jobs.values()].filter((j) => set.has(j.state)));
    },

    // ---- runs ----
    async createRun({ jobId, attempt }) {
      const row = { id: newId(), jobId, attempt, state: 'RUNNING', startedAt: nowIso(), finishedAt: null, error: null };
      runs.set(row.id, row);
      return clone(row);
    },

    async getRun(id) {
      const row = runs.get(id);
      return row ? clone(row) : null;
    },

    async latestRunForJob(jobId) {
      let best = null;
      for (const r of runs.values()) {
        if (r.jobId === jobId && (!best || r.attempt > best.attempt)) best = r;
      }
      return best ? clone(best) : null;
    },

    async listRunsForJob(jobId) {
      return clone([...runs.values()].filter((r) => r.jobId === jobId).sort((a, b) => b.attempt - a.attempt));
    },

    async updateRun(id, patch) {
      const row = runs.get(id);
      if (!row) return null;
      for (const k of ['state', 'finishedAt', 'error']) {
        if (k in patch) row[k] = patch[k];
      }
      return clone(row);
    },

    async listRunningRuns() {
      return clone([...runs.values()].filter((r) => r.state === 'RUNNING'));
    },

    // ---- run logs ----
    async appendLog({ runId, seq, type, detail = null }) {
      const list = runLogs.get(runId) || [];
      list.push({ id: list.length + 1, runId, seq, type, detail: clone(detail), createdAt: nowIso() });
      runLogs.set(runId, list);
      return true;
    },

    async listLogs({ runId, sinceSeq = 0, limit = 500 }) {
      const list = runLogs.get(runId) || [];
      return clone(list.filter((l) => l.seq > sinceSeq).slice(0, limit));
    },

    async listAllRunLogStrings(runId) {
      return JSON.stringify(runLogs.get(runId) || []);
    },

    // ---- artifacts ----
    async createArtifact({ jobId, runId, filename, mimeType, sizeBytes, contentBase64, checksum }) {
      const row = { id: newId(), jobId, runId, filename, mimeType, sizeBytes, content: contentBase64, checksum, createdAt: nowIso() };
      artifacts.set(row.id, row);
      return { ...row, content: undefined };
    },

    async listArtifactsForJob(jobId) {
      return clone([...artifacts.values()].filter((a) => a.jobId === jobId).map(({ content, ...meta }) => meta));
    },

    async getArtifactWithContent(id) {
      const row = artifacts.get(id);
      return row ? clone(row) : null;
    },

    // ---- approvals ----
    async createApproval({ jobId, runId, type, payload = null, artifactId = null, expiresAt }) {
      const row = {
        id: newId(),
        jobId,
        runId,
        type,
        artifactId,
        payload: payload ? clone(payload) : null,
        state: 'PENDING',
        decidedAt: null,
        expiresAt: expiresAt.toISOString(),
        createdAt: nowIso(),
      };
      approvals.set(row.id, row);
      return clone(row);
    },

    async getApproval(id) {
      const row = approvals.get(id);
      return row ? clone(row) : null;
    },

    async listApprovalsForJob(jobId) {
      return clone([...approvals.values()].filter((a) => a.jobId === jobId));
    },

    async updateApproval(id, patch) {
      const row = approvals.get(id);
      if (!row) return null;
      for (const k of ['state', 'decidedAt', 'payload']) {
        if (k in patch) row[k] = patch[k];
      }
      return clone(row);
    },

    async listPendingApprovals() {
      return clone([...approvals.values()].filter((a) => a.state === 'PENDING'));
    },

    // ---- canvas cache ----
    async getCacheEntry(userId, resource) {
      const row = cache.get(`${userId}|${resource}`);
      if (!row) return null;
      if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
      return clone(row);
    },

    async putCacheEntry(userId, resource, payload, ttlSeconds) {
      cache.set(`${userId}|${resource}`, {
        userId,
        resource,
        payload: clone(payload),
        fetchedAt: nowIso(),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      });
    },

    async invalidateCache(userId, resource) {
      cache.delete(`${userId}|${resource}`);
    },

    close() {},
  };
}
