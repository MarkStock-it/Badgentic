import { createCanvasService } from './canvas-service.js';
import { createRateLimiter } from './rate-limiter.js';

/**
 * Canvas gateway (spec §4.2): every read goes through getOrFetch with the
 * per-resource TTL table; every write path re-verifies live state first.
 * All requests pass a per-user token bucket. `serviceFactory` is injectable
 * for tests (same surface as createCanvasService).
 */
export function createCanvasGateway({ store, rateLimiter = createRateLimiter({ perMinute: 100 }), serviceFactory = createCanvasService }) {
  const TTL = {
    profile: 3600,
    courses: 900,
    assignments: 900,
    submissions: 300,
  };

  function svcFor({ token, domain }) {
    return serviceFactory({ auth: { token, domain } });
  }

  async function throttled(userId, svc, fn) {
    if (!rateLimiter.take(userId)) {
      const waitMs = rateLimiter.msUntilToken(userId);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 5000)));
      rateLimiter.take(userId);
    }
    return fn(svc);
  }

  async function getOrFetch({ userId, resource, ttl, fetcher }) {
    const hit = await store.getCacheEntry(userId, resource);
    if (hit) return hit.payload;
    const payload = await fetcher();
    await store.putCacheEntry(userId, resource, payload, ttl);
    return payload;
  }

  return {
    async getProfile({ userId, token, domain, forceLive = false }) {
      const svc = svcFor({ token, domain });
      if (forceLive) return throttled(userId, svc, (s) => s.getProfile());
      return getOrFetch({
        userId,
        resource: 'profile',
        ttl: TTL.profile,
        fetcher: () => throttled(userId, svc, (s) => s.getProfile()),
      });
    },

    async listCourses({ userId, token, domain }) {
      const svc = svcFor({ token, domain });
      return getOrFetch({
        userId,
        resource: 'courses',
        ttl: TTL.courses,
        fetcher: () => throttled(userId, svc, (s) => s.listCourses()),
      });
    },

    async listAssignments({ userId, token, domain, courseId }) {
      const svc = svcFor({ token, domain });
      return getOrFetch({
        userId,
        resource: `assignments:${courseId}`,
        ttl: TTL.assignments,
        fetcher: () => throttled(userId, svc, (s) => s.listAssignments(courseId)),
      });
    },

    async getAssignment({ userId, token, domain, courseId, assignmentId }) {
      const svc = svcFor({ token, domain });
      return getOrFetch({
        userId,
        resource: `assignment:${courseId}:${assignmentId}`,
        ttl: TTL.assignments,
        fetcher: () => throttled(userId, svc, (s) => s.getAssignment(courseId, assignmentId)),
      });
    },

    /** Always live — used before any write and inside jobs for fresh state. */
    async getSubmissionLive({ userId, token, domain, courseId, assignmentId }) {
      const svc = svcFor({ token, domain });
      return throttled(userId, svc, (s) => s.getSubmission(courseId, assignmentId));
    },

    async listSubmissionComments({ userId, token, domain, courseId, assignmentId }) {
      const svc = svcFor({ token, domain });
      return getOrFetch({
        userId,
        resource: `comments:${courseId}:${assignmentId}`,
        ttl: TTL.submissions,
        fetcher: () => throttled(userId, svc, (s) => s.listSubmissionComments(courseId, assignmentId)),
      });
    },

    // ---- writes: live re-verify then act, then invalidate cache ----

    async postComment({ userId, token, domain, courseId, assignmentId, comment }) {
      const svc = svcFor({ token, domain });
      // Live re-verify first (spec §4.2): fresh submission read before the write.
      await throttled(userId, svc, (s) => s.getSubmission(courseId, assignmentId));
      const res = await throttled(userId, svc, (s) => s.postComment(courseId, assignmentId, comment));
      await store.invalidateCache(userId, `comments:${courseId}:${assignmentId}`);
      return res;
    },

    async uploadAndSubmit({ userId, token, domain, courseId, assignmentId, file }) {
      const svc = svcFor({ token, domain });
      const sub = await throttled(userId, svc, (s) => s.getSubmission(courseId, assignmentId));
      if (sub && sub.workflow_state !== 'unsubmitted') {
        const err = new Error(`Assignment is ${sub.workflow_state}, refusing double-submit`);
        err.code = 'ALREADY_SUBMITTED';
        throw err;
      }
      const fileObj = await throttled(userId, svc, (s) =>
        s.uploadFile({ name: file.filename, contentType: file.mimeType, size: file.sizeBytes, data: file.content })
      );
      const res = await throttled(userId, svc, (s) => s.submitFile(courseId, assignmentId, fileObj.id));
      await store.invalidateCache(userId, `submissions:${courseId}:${assignmentId}`);
      await store.invalidateCache(userId, `assignment:${courseId}:${assignmentId}`);
      return res;
    },

    _svcFor: svcFor,
  };
}
