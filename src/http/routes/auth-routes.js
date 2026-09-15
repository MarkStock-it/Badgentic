import { Router } from 'express';
import { AppError, ERROR_CODES } from '../../errors.js';
import { requireSession, requireCsrf } from '../middleware.js';
import { createCanvasService } from '../../canvas/canvas-service.js';
import { identityHash } from '../../util/id.js';
/**
 * Auth routes (spec §7.1). Bootstrap: the handoff JWT from the URL is traded
 * for a session cookie, then stripped client-side (§2.2 step 4).
 */
export function createAuthRoutes({ store, sessionService, handoffVerifier, cryptoBox, canvasServiceFactory = createCanvasService, config, log }) {
  const router = Router();

  function setSessionCookie(res, sessionId) {
    res.cookie(config.sessionCookieName, sessionId, {
      httpOnly: true,
      secure: config.env === 'production',
      sameSite: 'lax',
      maxAge: config.sessionTtlHours * 3600 * 1000,
      path: '/',
    });
  }

  // POST /auth/session — bootstrap from handoff token
  router.post('/session', async (req, res, next) => {
    try {
      const token = String(req.body?.token || '');
      if (!token) throw new AppError(ERROR_CODES.BAD_REQUEST, 'Missing handoff token');
      const claims = handoffVerifier(token);
      const session = await sessionService.bootstrapFromHandoff({ claims });
      setSessionCookie(res, session.id);
      res.json({ ok: true, userIdHash: claims.sub, name: claims.name || '' });
    } catch (err) {
      next(err);
    }
  });

  // GET /auth/session — who am I (spec §7.1)
  router.get('/session', async (req, res, next) => {
    try {
      requireSession(req);
      const user = (await store.getUser(req.session.userId)) || {};
      res.json({
        userIdHash: req.session.userId,
        name: user.displayName || '',
        email: user.email || '',
        canvasDomain: user.canvasDomain || '',
        canvasConnected: Boolean(req.session.canvasTokenEnc),
        hasGeminiKey: Boolean(req.session.aiKeysEnc?.gemini),
        hasGroqKey: Boolean(req.session.aiKeysEnc?.groq),
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/canvas-token-bootstrap — no-session fallback: the pasted
  // token itself proves the Canvas identity (spec §6.2b, "works today").
  router.post('/canvas-token-bootstrap', async (req, res, next) => {
    try {
      const token = String(req.body?.token || '').trim();
      const domain = String(req.body?.domain || '').trim();
      if (!token || !domain) throw new AppError(ERROR_CODES.VALIDATION, 'token and domain are required');
      const svc = canvasServiceFactory({ auth: { token, domain } });
      const profile = await svc.getProfile();
      if (!profile?.id) throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Canvas rejected this token');
      const claims = {
        sub: identityHash(domain, String(profile.id)),
        canvasDomain: domain,
        canvasUserId: String(profile.id),
        name: profile.name || '',
        email: profile.primary_email || profile.email || '',
      };
      const session = await sessionService.bootstrapFromHandoff({ claims });
      const enc = cryptoBox.encrypt(token);
      const { tokenIv, tokenTag } = { tokenIv: enc.iv, tokenTag: enc.tag };
      await store.updateSessionCanvasToken(session.id, { canvasTokenEnc: enc.c, tokenIv, tokenTag });
      setSessionCookie(res, session.id);
      log?.info({ sub: claims.sub }, 'session bootstrapped from pasted canvas token');
      res.json({ ok: true, userIdHash: claims.sub, name: claims.name || '' });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/canvas-token — bootstrap (b): paste token, verified live
  router.post('/canvas-token', async (req, res, next) => {
    try {
      requireSession(req);
      requireCsrf(req);
      const token = String(req.body?.token || '').trim();
      const domain = String(req.body?.domain || '').trim();
      if (!token || !domain) throw new AppError(ERROR_CODES.VALIDATION, 'token and domain are required');
      const user = (await store.getUser(req.session.userId)) || {};
      const svc = canvasServiceFactory({ auth: { token, domain: domain || user.canvasDomain } });
      await svc.getProfile();
      await sessionService.attachCanvasToken({ sessionId: req.sessionId, token, domain, canvasService: () => svc });
      log?.info({ sub: req.session.userId }, 'canvas token attached');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/ai-keys — store BYOK keys encrypted
  router.post('/ai-keys', async (req, res, next) => {
    try {
      requireSession(req);
      requireCsrf(req);
      const keys = {};
      if (req.body?.gemini) keys.gemini = String(req.body.gemini).trim();
      if (req.body?.groq) keys.groq = String(req.body.groq).trim();
      if (Object.keys(keys).length === 0) throw new AppError(ERROR_CODES.VALIDATION, 'No keys provided');
      await sessionService.setAiKeys({ sessionId: req.sessionId, keys });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/logout
  router.post('/logout', async (req, res, next) => {
    try {
      requireSession(req);
      requireCsrf(req);
      await sessionService.logout(req.sessionId);
      res.clearCookie(config.sessionCookieName, { path: '/' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
