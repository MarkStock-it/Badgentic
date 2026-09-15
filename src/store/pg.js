import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  approvals,
  artifacts,
  canvasCache,
  jobs,
  runLogs,
  runs,
  sessions,
  users,
} from './schema.js';

// Capacity counts RUNNING jobs only — QUEUED jobs are waiting, not occupying.
const ACTIVE_STATES = [
  'DISCOVERED',
  'ANALYZING',
  'CAPABILITY_CHECK',
  'PLANNING',
  'GENERATING',
  'REFINING',
  'VALIDATING',
  'READY',
  'EXECUTING',
  'USER_ACTION_REQUIRED',
];

/**
 * Postgres repositories (Drizzle + node-postgres). Same method surface as
 * createMemoryStore — swap by config, no call-site changes.
 */
export function createPgStore({ databaseUrl, log }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool);

  function fail(op, err) {
    log?.error({ err, op }, 'store error');
    throw err;
  }

  return {
    driver: 'postgres',

    // ---- users ----
    async upsertUser({ id, canvasDomain, canvasUserId, displayName = '', email = '' }) {
      try {
        const [row] = await db
          .insert(users)
          .values({ id, canvasDomain, canvasUserId, displayName, email })
          .onConflictDoUpdate({
            target: users.id,
            set: {
              displayName: sql`CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE ${users.displayName} END`,
              email: sql`CASE WHEN excluded.email <> '' THEN excluded.email ELSE ${users.email} END`,
              lastSeenAt: new Date(),
            },
          })
          .returning();
        return row;
      } catch (err) {
        return fail('upsertUser', err);
      }
    },

    async touchUserLastSeen(id) {
      try {
        await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, id));
      } catch (err) {
        return fail('touchUserLastSeen', err);
      }
    },

    async getUser(id) {
      try {
        const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        return row || null;
      } catch (err) {
        return fail('getUser', err);
      }
    },

    // ---- sessions ----
    async createSession({ userId, canvasTokenEnc = null, tokenIv = null, tokenTag = null, aiKeysEnc = null, expiresAt }) {
      try {
        const [row] = await db
          .insert(sessions)
          .values({ userId, canvasTokenEnc, tokenIv, tokenTag, aiKeysEnc, expiresAt })
          .returning();
        return row;
      } catch (err) {
        return fail('createSession', err);
      }
    },

    async getSession(id) {
      try {
        const [row] = await db
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
          .limit(1);
        return row || null;
      } catch (err) {
        return fail('getSession', err);
      }
    },

    async updateSessionCanvasToken(id, { canvasTokenEnc, tokenIv, tokenTag }) {
      try {
        const [row] = await db
          .update(sessions)
          .set({ canvasTokenEnc, tokenIv, tokenTag })
          .where(eq(sessions.id, id))
          .returning();
        return row || null;
      } catch (err) {
        return fail('updateSessionCanvasToken', err);
      }
    },

    async updateSessionAiKeys(id, aiKeysEnc) {
      try {
        const [row] = await db.update(sessions).set({ aiKeysEnc }).where(eq(sessions.id, id)).returning();
        return row || null;
      } catch (err) {
        return fail('updateSessionAiKeys', err);
      }
    },

    async deleteSession(id) {
      try {
        await db.delete(sessions).where(eq(sessions.id, id));
        return true;
      } catch (err) {
        return fail('deleteSession', err);
      }
    },

    async deleteExpiredSessions() {
      try {
        const res = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
        return res.rowCount || 0;
      } catch (err) {
        return fail('deleteExpiredSessions', err);
      }
    },

    // ---- jobs ----
    async createJob({ userId, kind, title = '', canvasCourseId = null, canvasAssignmentId = null, sessionId = null, manifest = null, plan = null }) {
      try {
        const [row] = await db
          .insert(jobs)
          .values({ userId, kind, title, canvasCourseId, canvasAssignmentId, sessionId, manifest, plan })
          .returning();
        return row;
      } catch (err) {
        return fail('createJob', err);
      }
    },

    async getJob(id) {
      try {
        const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
        return row || null;
      } catch (err) {
        return fail('getJob', err);
      }
    },

    async listJobs({ userId, state = null, limit = 50, createdBefore = null }) {
      try {
        const conds = [eq(jobs.userId, userId)];
        if (state) conds.push(eq(jobs.state, state));
        if (createdBefore) conds.push(lt(jobs.createdAt, new Date(createdBefore)));
        return await db
          .select()
          .from(jobs)
          .where(and(...conds))
          .orderBy(desc(jobs.createdAt))
          .limit(limit);
      } catch (err) {
        return fail('listJobs', err);
      }
    },

    async listJobsUpdatedSince(userId, sinceIso) {
      try {
        return await db
          .select()
          .from(jobs)
          .where(and(eq(jobs.userId, userId), gt(jobs.updatedAt, new Date(sinceIso))))
          .orderBy(desc(jobs.updatedAt))
          .limit(200);
      } catch (err) {
        return fail('listJobsUpdatedSince', err);
      }
    },

    async updateJob(id, patch) {
      try {
        const set = { ...patch, updatedAt: new Date() };
        const [row] = await db.update(jobs).set(set).where(eq(jobs.id, id)).returning();
        return row || null;
      } catch (err) {
        return fail('updateJob', err);
      }
    },

    async countActiveJobsByUser(userId) {
      try {
        const res = await db
          .select({ n: sql`count(*)::int` })
          .from(jobs)
          .where(and(eq(jobs.userId, userId), inArray(jobs.state, ACTIVE_STATES)));
        return res[0]?.n || 0;
      } catch (err) {
        return fail('countActiveJobsByUser', err);
      }
    },

    async countNonTerminalJobs() {
      try {
        const res = await db.select({ n: sql`count(*)::int` }).from(jobs).where(inArray(jobs.state, ACTIVE_STATES));
        return res[0]?.n || 0;
      } catch (err) {
        return fail('countNonTerminalJobs', err);
      }
    },

    async listJobsByState(states) {
      try {
        return await db.select().from(jobs).where(inArray(jobs.state, states));
      } catch (err) {
        return fail('listJobsByState', err);
      }
    },

    // ---- runs ----
    async createRun({ jobId, attempt }) {
      try {
        const [row] = await db.insert(runs).values({ jobId, attempt }).returning();
        return row;
      } catch (err) {
        return fail('createRun', err);
      }
    },

    async getRun(id) {
      try {
        const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
        return row || null;
      } catch (err) {
        return fail('getRun', err);
      }
    },

    async latestRunForJob(jobId) {
      try {
        const [row] = await db.select().from(runs).where(eq(runs.jobId, jobId)).orderBy(desc(runs.attempt)).limit(1);
        return row || null;
      } catch (err) {
        return fail('latestRunForJob', err);
      }
    },

    async listRunsForJob(jobId) {
      try {
        return await db.select().from(runs).where(eq(runs.jobId, jobId)).orderBy(desc(runs.attempt));
      } catch (err) {
        return fail('listRunsForJob', err);
      }
    },

    async updateRun(id, patch) {
      try {
        const [row] = await db.update(runs).set(patch).where(eq(runs.id, id)).returning();
        return row || null;
      } catch (err) {
        return fail('updateRun', err);
      }
    },

    async listRunningRuns() {
      try {
        return await db.select().from(runs).where(eq(runs.state, 'RUNNING'));
      } catch (err) {
        return fail('listRunningRuns', err);
      }
    },

    // ---- run logs ----
    async appendLog({ runId, seq, type, detail = null }) {
      try {
        await db.insert(runLogs).values({ runId, seq, type, detail });
        return true;
      } catch (err) {
        return fail('appendLog', err);
      }
    },

    async listLogs({ runId, sinceSeq = 0, limit = 500 }) {
      try {
        return await db
          .select()
          .from(runLogs)
          .where(and(eq(runLogs.runId, runId), gt(runLogs.seq, sinceSeq)))
          .orderBy(asc(runLogs.seq))
          .limit(limit);
      } catch (err) {
        return fail('listLogs', err);
      }
    },

    async listAllRunLogStrings(runId) {
      try {
        const rows = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
        return JSON.stringify(rows);
      } catch (err) {
        return fail('listAllRunLogStrings', err);
      }
    },

    // ---- artifacts ----
    async createArtifact({ jobId, runId, filename, mimeType, sizeBytes, contentBase64, checksum }) {
      try {
        const [row] = await db
          .insert(artifacts)
          .values({ jobId, runId, filename, mimeType, sizeBytes, content: contentBase64, checksum })
          .returning({ id: artifacts.id, jobId: artifacts.jobId, runId: artifacts.runId, filename: artifacts.filename, mimeType: artifacts.mimeType, sizeBytes: artifacts.sizeBytes, checksum: artifacts.checksum, createdAt: artifacts.createdAt });
        return row;
      } catch (err) {
        return fail('createArtifact', err);
      }
    },

    async listArtifactsForJob(jobId) {
      try {
        return await db
          .select({ id: artifacts.id, jobId: artifacts.jobId, runId: artifacts.runId, filename: artifacts.filename, mimeType: artifacts.mimeType, sizeBytes: artifacts.sizeBytes, checksum: artifacts.checksum, createdAt: artifacts.createdAt })
          .from(artifacts)
          .where(eq(artifacts.jobId, jobId))
          .orderBy(desc(artifacts.createdAt));
      } catch (err) {
        return fail('listArtifactsForJob', err);
      }
    },

    async getArtifactWithContent(id) {
      try {
        const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
        return row || null;
      } catch (err) {
        return fail('getArtifactWithContent', err);
      }
    },

    // ---- approvals ----
    async createApproval({ jobId, runId, type, payload = null, artifactId = null, expiresAt }) {
      try {
        const [row] = await db.insert(approvals).values({ jobId, runId, type, payload, artifactId, expiresAt }).returning();
        return row;
      } catch (err) {
        return fail('createApproval', err);
      }
    },

    async getApproval(id) {
      try {
        const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
        return row || null;
      } catch (err) {
        return fail('getApproval', err);
      }
    },

    async listApprovalsForJob(jobId) {
      try {
        return await db.select().from(approvals).where(eq(approvals.jobId, jobId)).orderBy(desc(approvals.createdAt));
      } catch (err) {
        return fail('listApprovalsForJob', err);
      }
    },

    async updateApproval(id, patch) {
      try {
        const [row] = await db.update(approvals).set(patch).where(eq(approvals.id, id)).returning();
        return row || null;
      } catch (err) {
        return fail('updateApproval', err);
      }
    },

    async listPendingApprovals() {
      try {
        return await db.select().from(approvals).where(eq(approvals.state, 'PENDING'));
      } catch (err) {
        return fail('listPendingApprovals', err);
      }
    },

    // ---- canvas cache ----
    async getCacheEntry(userId, resource) {
      try {
        const [row] = await db
          .select()
          .from(canvasCache)
          .where(and(eq(canvasCache.userId, userId), eq(canvasCache.resource, resource), gt(canvasCache.expiresAt, new Date())))
          .limit(1);
        return row || null;
      } catch (err) {
        return fail('getCacheEntry', err);
      }
    },

    async putCacheEntry(userId, resource, payload, ttlSeconds) {
      try {
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        await db
          .insert(canvasCache)
          .values({ userId, resource, payload, expiresAt })
          .onConflictDoUpdate({
            target: [canvasCache.userId, canvasCache.resource],
            set: { payload, fetchedAt: new Date(), expiresAt },
          });
      } catch (err) {
        return fail('putCacheEntry', err);
      }
    },

    async invalidateCache(userId, resource) {
      try {
        await db.delete(canvasCache).where(and(eq(canvasCache.userId, userId), eq(canvasCache.resource, resource)));
      } catch (err) {
        return fail('invalidateCache', err);
      }
    },

    async close() {
      await pool.end();
    },
  };
}
