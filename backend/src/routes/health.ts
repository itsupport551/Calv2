// ============================================================
// Enterprise Calendar Sync — Health Check Route
// ============================================================
// Liveness check used by Railway/Docker: always returns 200 if the
// server is up and answering requests. DB status is reported in the
// body so a degraded DB is visible without taking the whole service
// down. Use /health/ready for a strict readiness check.
// ============================================================

import { Router, Request, Response } from 'express';
import { checkDatabaseHealth } from '../database/client';
import logger from '../utils/logger';

const router = Router();

/**
 * Liveness — Railway healthcheck hits this.
 * Returns 200 if the server can respond. DB status is reported but
 * doesn't fail the check, so deployments aren't blocked by a transient
 * DB issue and you can still reach logs/admin to diagnose.
 */
router.get('/', async (_req: Request, res: Response) => {
  let dbHealth: { status: 'up' | 'down'; latency: number } = { status: 'down', latency: 0 };
  try {
    dbHealth = await checkDatabaseHealth();
  } catch (err) {
    logger.warn({ err }, 'Health check: DB probe threw');
  }

  if (dbHealth.status !== 'up') {
    logger.warn({ dbHealth }, 'Health check: DB reports degraded — returning 200 (liveness only)');
  }

  res.status(200).json({
    status: 'alive',
    version: '1.0.0',
    uptime: process.uptime(),
    services: {
      database: {
        status: dbHealth.status,
        latency: dbHealth.latency,
        lastChecked: new Date().toISOString(),
      },
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Strict readiness — for monitoring / load-balancer pre-flight.
 * Returns 503 if any dependency is down.
 */
router.get('/ready', async (_req: Request, res: Response) => {
  const dbHealth = await checkDatabaseHealth().catch(() => ({ status: 'down' as const, latency: 0 }));
  const ready = dbHealth.status === 'up';
  res.status(ready ? 200 : 503).json({
    ready,
    services: { database: dbHealth },
    timestamp: new Date().toISOString(),
  });
});

export default router;
