import { describe, it, expect, afterAll } from 'vitest';
import { createTestHarness, seedSession, mintHandoffToken, testUser } from './helpers.js';

const servers = [];
afterAll(() => {
  for (const s of servers) {
    try {
      s.close();
    } catch {}
  }
});

async function listen(harness) {
  const server = harness.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async req(method, path, { body, cookies, headers = {} } = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookies ? { Cookie: cookies } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const setCookie = res.headers.get('set-cookie');
      return { status: res.status, body: json ?? text, setCookie };
    },
  };
}

describe('auth API', () => {
  it('bootstraps a session from the handoff token and sets the cookie', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const token = mintHandoffToken(testUser());
    const res = await client.req('POST', '/api/v1/auth/session', { body: { token } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userIdHash).toBeTruthy();
    expect(res.setCookie).toContain('agentic_session=');
  });

  it('rejects an invalid handoff token with 401', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const res = await client.req('POST', '/api/v1/auth/session', { body: { token: 'garbage' } });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('GET /auth/session requires a session; with cookie returns identity', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const anon = await client.req('GET', '/api/v1/auth/session');
    expect(anon.status).toBe(401);

    const session = await seedSession(harness);
    const who = await client.req('GET', '/api/v1/auth/session', {
      cookies: `agentic_session=${session.id}`,
    });
    expect(who.status).toBe(200);
    expect(who.body.canvasConnected).toBe(true);
    expect(who.body.hasGeminiKey).toBe(true);
    expect(who.body.name).toBe('Test Student');
  });

  it('canvas-token-bootstrap verifies live and signs in', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const res = await client.req('POST', '/api/v1/auth/canvas-token-bootstrap', {
      body: { token: 'any-token', domain: 'usc.instructure.com' },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // session must hold the encrypted token
    expect(res.setCookie).toContain('agentic_session=');
  });
});

describe('jobs API', () => {
  it('creates, lists, and shows a job with cookie auth', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const session = await seedSession(harness);
    const cookie = `agentic_session=${session.id}`;

    const created = await client.req('POST', '/api/v1/jobs', {
      body: { kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001, title: 'Unit 3 deck' },
      cookies: cookie,
      headers: { 'X-Agentic-CSRF': '1' },
    });
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('DISCOVERED');

    const list = await client.req('GET', '/api/v1/jobs', { cookies: cookie });
    expect(list.status).toBe(200);
    expect(list.body.jobs).toHaveLength(1);

    const one = await client.req('GET', `/api/v1/jobs/${created.body.id}`, { cookies: cookie });
    expect(one.status).toBe(200);
    expect(one.body.job.kind).toBe('study_deck');
  });

  it('rejects unknown job kinds with VALIDATION', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const session = await seedSession(harness);
    const res = await client.req('POST', '/api/v1/jobs', {
      body: { kind: 'video_essay', canvasCourseId: 101, canvasAssignmentId: 9001 },
      cookies: `agentic_session=${session.id}`,
      headers: { 'X-Agentic-CSRF': '1' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('rejects mutation without the CSRF header', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const session = await seedSession(harness);
    const res = await client.req('POST', '/api/v1/jobs', {
      body: { kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001 },
      cookies: `agentic_session=${session.id}`,
    });
    expect(res.status).toBe(403);
  });

  it('blocks access to another user job (ownership check)', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const sessionA = await seedSession(harness);
    const sessionB = await harness.sessionService.bootstrapFromHandoff({
      claims: { sub: 'otheruserhash', canvasDomain: 'x.instructure.com', canvasUserId: '999', name: 'Other' },
    });
    const jobA = await harness.store.createJob({ userId: sessionA.userId, kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001, sessionId: sessionA.id });

    const res = await client.req('GET', `/api/v1/jobs/${jobA.id}`, {
      cookies: `agentic_session=${sessionB.id}`,
    });
    expect([403, 404]).toContain(res.status);
  });

  it('cancel + retry endpoints respect state rules', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const session = await seedSession(harness);
    const cookie = `agentic_session=${session.id}`;
    const job = await harness.store.createJob({ userId: session.userId, kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001, sessionId: session.id });
    await harness.store.updateJob(job.id, { state: 'COMPLETED' });

    const cancel = await client.req('POST', `/api/v1/jobs/${job.id}/cancel`, { cookies: cookie, headers: { 'X-Agentic-CSRF': '1' }, body: {} });
    expect(cancel.status).toBe(409);

    const retry = await client.req('POST', `/api/v1/jobs/${job.id}/retry`, { cookies: cookie, headers: { 'X-Agentic-CSRF': '1' }, body: {} });
    expect(retry.status).toBe(409);
  });
});

describe('artifacts + approvals API', () => {
  it('downloads an artifact with ownership enforcement', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const session = await seedSession(harness);
    const job = await harness.store.createJob({ userId: session.userId, kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001, sessionId: session.id });
    const run = await harness.store.createRun({ jobId: job.id, attempt: 1 });
    const artifact = await harness.store.createArtifact({
      jobId: job.id,
      runId: run.id,
      filename: 'deck.md',
      mimeType: 'text/markdown',
      sizeBytes: 3,
      contentBase64: Buffer.from('abc').toString('base64'),
      checksum: (await import('node:crypto')).createHash('sha256').update('abc').digest('hex'),
    });

    const res = await client.req('GET', `/api/v1/artifacts/${artifact.id}/download`, {
      cookies: `agentic_session=${session.id}`,
    });
    expect(res.status).toBe(200);
    expect(String(res.body)).toBe('abc');
  });

  it('deny → job cancels without writing to Canvas', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const session = await seedSession(harness);
    const cookie = `agentic_session=${session.id}`;

    const created = await client.req('POST', '/api/v1/jobs', {
      body: { kind: 'discussion_post', canvasCourseId: 101, canvasAssignmentId: 9001 },
      cookies: cookie,
      headers: { 'X-Agentic-CSRF': '1' },
    });
    const jobId = created.body.id;

    // Wait for the approval to appear, then DENY via the API.
    let approval = null;
    for (let i = 0; i < 100 && !approval; i++) {
      const pending = await harness.store.listPendingApprovals();
      approval = pending.find((a) => a.jobId === jobId);
      if (!approval) await new Promise((r) => setTimeout(r, 20));
    }
    expect(approval).toBeTruthy();
    const denied = await client.req('POST', `/api/v1/approvals/${approval.id}/deny`, {
      cookies: cookie,
      headers: { 'X-Agentic-CSRF': '1' },
      body: { reason: 'not happy with it' },
    });
    expect(denied.status).toBe(200);

    for (let i = 0; i < 100; i++) {
      const j = await harness.store.getJob(jobId);
      if (j.state === 'CANCELLED') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const final = await harness.store.getJob(jobId);
    expect(final.state).toBe('CANCELLED');
    expect(harness.canvasFake.commentCalls()).toHaveLength(0);
  });

  it('approval approve/deny enforce ownership and state rules', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const session = await seedSession(harness);
    const job = await harness.store.createJob({ userId: session.userId, kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001, sessionId: session.id });
    const run = await harness.store.createRun({ jobId: job.id, attempt: 1 });
    const approval = await harness.store.createApproval({ jobId: job.id, runId: run.id, type: 'COMMENT', payload: {}, expiresAt: new Date(Date.now() + 3_600_000) });

    const res = await client.req('POST', `/api/v1/approvals/${approval.id}/approve`, {
      cookies: `agentic_session=${session.id}`,
      headers: { 'X-Agentic-CSRF': '1' },
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('APPROVED');

    const again = await client.req('POST', `/api/v1/approvals/${approval.id}/approve`, {
      cookies: `agentic_session=${session.id}`,
      headers: { 'X-Agentic-CSRF': '1' },
      body: {},
    });
    expect(again.status).toBe(409);
  });
});

describe('back-channel API', () => {
  it('returns a safe projection with a valid bearer token', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const session = await seedSession(harness);
    const job = await harness.store.createJob({ userId: session.userId, kind: 'study_deck', canvasCourseId: 101, canvasAssignmentId: 9001, sessionId: session.id });
    await harness.store.updateJob(job.id, { state: 'COMPLETED', result: { summary: 'done', artifact: { id: 'a' } } });

    const res = await client.req('GET', `/api/v1/users/${session.userId}/jobs?since=1970-01-01T00:00:00Z`, {
      headers: { Authorization: `Bearer ${harness.config.backChannelToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].state).toBe('COMPLETED');
    expect(res.body.jobs[0].hasArtifact).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('canvas-test-token');
    expect(JSON.stringify(res.body)).not.toContain('session');
  });

  it('rejects a bad bearer token', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const res = await client.req('GET', '/api/v1/users/abc/jobs', { headers: { Authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });
});

describe('ops', () => {
  it('healthz + metrics respond', async () => {
    const harness = createTestHarness();
    const client = await listen(harness);
    const health = await client.req('GET', '/healthz');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    const metrics = await client.req('GET', '/internal/v1/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
