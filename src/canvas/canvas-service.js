import { AppError, ERROR_CODES } from '../errors.js';

/**
 * Canvas REST client (spec §4). Dependency-free factory taking a fetch impl
 * and an auth provider so tests inject fakes. Mirrors BetterCLSS's
 * canvas-service.js contract: Link-header pagination, error taxonomy
 * (UNAUTHORIZED / RATE_LIMITED / UPSTREAM), domain normalization.
 */
export function createCanvasService({ auth, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  function normalizeDomain(domain) {
    const d = String(domain || '').trim().toLowerCase();
    if (!d) throw new AppError(ERROR_CODES.BAD_REQUEST, 'Canvas domain is required');
    return d.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  function baseUrl(domain) {
    return `https://${normalizeDomain(domain)}/api/v1`;
  }

  function authHeaders() {
    return { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' };
  }

  async function parseBody(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  function classify(res, body) {
    if (res.status === 401 || res.status === 403) {
      return new AppError(ERROR_CODES.UNAUTHORIZED, `Canvas ${res.status}: token lacks access`, {
        hint: 'Check that the Canvas token is valid and has the needed permissions.',
      });
    }
    if (res.status === 429) {
      return new AppError(ERROR_CODES.RATE_LIMITED, 'Canvas rate limit hit');
    }
    const msg = body?.errors ? (Array.isArray(body.errors) ? body.errors.map((e) => e.message).join('; ') : String(body.errors)) : `Canvas HTTP ${res.status}`;
    return new AppError(ERROR_CODES.UPSTREAM, msg, { details: { status: res.status } });
  }

  async function request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${baseUrl(auth.domain)}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetchImpl(url, {
      method,
      headers: {
        ...authHeaders(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await parseBody(res);
    if (!res.ok) throw classify(res, parsed);
    return parsed;
  }

  /** Paginate a list endpoint via Link rel="next". */
  async function fetchAllPages(path, { query, maxPages = 50 } = {}) {
    const out = [];
    let url = new URL(`${baseUrl(auth.domain)}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    for (let page = 0; page < maxPages; page++) {
      const res = await fetchImpl(url, { headers: authHeaders() });
      const parsed = await parseBody(res);
      if (!res.ok) throw classify(res, parsed);
      if (Array.isArray(parsed)) out.push(...parsed);
      const link = res.headers.get('link') || '';
      const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
      if (!next) break;
      url = new URL(next);
    }
    return out;
  }

  return {
    async getProfile() {
      return request('/users/self/profile');
    },

    async listCourses() {
      return fetchAllPages('/courses', {
        query: { include: ['total_scores', 'term'], enrollment_state: 'active', per_page: 50 },
      });
    },

    async listAssignments(courseId) {
      return fetchAllPages(`/courses/${courseId}/assignments`, {
        query: { include: ['submission'], per_page: 50 },
      });
    },

    async getAssignment(courseId, assignmentId) {
      return request(`/courses/${courseId}/assignments/${assignmentId}`, {
        query: { include: ['submission'] },
      });
    },

    async getSubmission(courseId, assignmentId) {
      return request(`/courses/${courseId}/assignments/${assignmentId}/submission/self`);
    },

    async listSubmissionComments(courseId, assignmentId) {
      const sub = await request(`/courses/${courseId}/assignments/${assignmentId}/submission/self`, {
        query: { include: ['submission_comments'] },
      });
      return sub?.submission_comments || [];
    },

    async postComment(courseId, assignmentId, comment) {
      return request(`/courses/${courseId}/assignments/${assignmentId}/submission/self`, {
        method: 'PUT',
        body: { comment: { text_comment: comment } },
      });
    },

    async getCourse(courseId) {
      return request(`/courses/${courseId}`, { query: { include: ['total_scores', 'term'] } });
    },

    /**
     * File upload: Canvas two-step (file → upload_url → confirm).
     * Returns the final file object (id, filename, size).
     */
    async uploadFile({ name, contentType, size, data }) {
      const init = await request(`/users/self/files`, {
        method: 'POST',
        body: { name, size, content_type: contentType, parent_folder_path: 'agentic' },
      });
      const uploadUrl = init.upload_url;
      const form = new FormData();
      const params = init.upload_params || {};
      for (const [k, v] of Object.entries(params)) form.append(k, String(v));
      form.append('file', new Blob([data], { type: contentType }), name);
      const confirm = await fetchImpl(uploadUrl, { method: 'POST', body: form });
      const confirmBody = await parseBody(confirm);
      if (!confirm.ok) throw classify(confirm, confirmBody);
      return confirmBody;
    },

    async submitFile(courseId, assignmentId, fileId) {
      return request(`/courses/${courseId}/assignments/${assignmentId}/submissions`, {
        method: 'POST',
        body: { submission: { submission_type: 'online_upload', file_ids: [fileId] } },
      });
    },

    request,
    fetchAllPages,
  };
}
