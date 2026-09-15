import { Router } from 'express';
import { sql } from 'drizzle-orm';

/**
 * Ops endpoints (spec §7.5): /healthz is liveness (no DB), /readyz checks the
 * DB, /internal/v1/metrics exposes plain JSON counters.
 */
export function createOpsRoutes({ dbPool, metrics }) {
  const router = Router();

  router.get('/healthz', (req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/readyz', async (req, res) => {
    try {
      if (dbPool) {
        await dbPool.query('SELECT 1');
      }
      res.json({ ok: true, db: dbPool ? 'reachable' : 'memory-store (no DB configured)' });
    } catch (err) {
      res.status(503).json({ ok: false, db: 'unreachable', error: err.message });
    }
  });

  router.get('/internal/v1/metrics', (req, res) => {
    res.json(metrics.snapshot());
  });

  return router;
}
