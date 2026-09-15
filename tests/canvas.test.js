import { describe, it, expect } from 'vitest';
import { createCanvasService } from '../src/canvas/canvas-service.js';
import { createRateLimiter } from '../src/canvas/rate-limiter.js';
import { AppError, ERROR_CODES } from '../src/errors.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('canvas service', () => {
  it('normalizes the domain and authenticates with the bearer token', async () => {
    let seenUrl, seenHeaders;
    const svc = createCanvasService({
      auth: { token: 'tok', domain: 'HTTPS://USC.Instructure.COM/' },
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenHeaders = init.headers;
        return jsonResponse({ id: 1, name: 'Me' });
      },
    });
    const profile = await svc.getProfile();
    expect(profile.id).toBe(1);
    expect(seenUrl).toContain('https://usc.instructure.com/api/v1/users/self/profile');
    expect(seenHeaders.Authorization).toBe('Bearer tok');
  });

  it('paginates via Link headers', async () => {
    const pages = [
      { body: [{ id: 1 }, { id: 2 }], headers: { Link: '<https://x/api/v1/courses?page=2>; rel="next"' } },
      { body: [{ id: 3 }], headers: {} },
    ];
    let page = 0;
    const svc = createCanvasService({
      auth: { token: 'tok', domain: 'x.instructure.com' },
      fetchImpl: async () => {
        const p = pages[page++];
        return jsonResponse(p.body, { headers: p.headers });
      },
    });
    const courses = await svc.listCourses();
    expect(courses.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(page).toBe(2);
  });

  it('maps 401 to UNAUTHORIZED and 429 to RATE_LIMITED', async () => {
    const svc = createCanvasService({
      auth: { token: 'tok', domain: 'x.instructure.com' },
      fetchImpl: async () => jsonResponse({ errors: [{ message: 'Invalid token' }] }, { status: 401 }),
    });
    await expect(svc.getProfile()).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    const svc2 = createCanvasService({
      auth: { token: 'tok', domain: 'x.instructure.com' },
      fetchImpl: async () => jsonResponse({}, { status: 429 }),
    });
    await expect(svc2.getProfile()).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMITED });
  });
});

describe('rate limiter', () => {
  it('allows bursts up to capacity then throttles per user independently', () => {
    const rl = createRateLimiter({ perMinute: 3 });
    expect(rl.take('user-a')).toBe(true);
    expect(rl.take('user-a')).toBe(true);
    expect(rl.take('user-a')).toBe(true);
    expect(rl.take('user-a')).toBe(false);
    expect(rl.take('user-b')).toBe(true);
    expect(rl.msUntilToken('user-a')).toBeGreaterThan(0);
  });
});
