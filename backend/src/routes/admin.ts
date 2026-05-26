// ============================================================
// Enterprise Calendar Sync — Admin Routes
// ============================================================

import { Router, Request, Response } from 'express';
import { authenticateSupabase, requireSupabaseRole } from '../middleware/supabaseAuth';
import getDatabase from '../database/client';
import { queryAuditLogs } from '../audit/logger';
import { UserRole } from '../types';

const router = Router();

// All admin routes require Supabase-authenticated session + ADMIN role
router.use(authenticateSupabase);
router.use(requireSupabaseRole(UserRole.ADMIN));

/** Get system dashboard stats */
router.get('/dashboard/stats', async (_req: Request, res: Response) => {
  const db = getDatabase();

  const [
    totalUsers,
    activeUsers,
    totalEvents,
    syncedEvents,
    failedSyncs,
    conflictsToday,
    recentTransactions,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { isActive: true } }),
    db.event.count(),
    db.event.count({ where: { syncState: 'SYNCED' } }),
    db.syncTransaction.count({ where: { status: 'FAILED' } }),
    db.conflictLog.count({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
    db.syncTransaction.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, transactionId: true, direction: true, action: true,
        status: true, createdAt: true, completedAt: true,
      },
    }),
  ]);

  res.json({
    success: true,
    data: {
      users: { total: totalUsers, active: activeUsers },
      events: { total: totalEvents, synced: syncedEvents },
      sync: { failed: failedSyncs, recentTransactions },
      conflicts: { today: conflictsToday },
    },
  });
});

/** List all users */
router.get('/users', async (req: Request, res: Response) => {
  const db = getDatabase();
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  const [users, total] = await Promise.all([
    db.user.findMany({
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, displayName: true, role: true,
        googleConnected: true, microsoftConnected: true,
        emailProvider: true,
        isActive: true, lastSyncAt: true, createdAt: true,
        _count: { select: { calendars: true } },
      },
    }),
    db.user.count(),
  ]);

  res.json({ success: true, data: { users, total, page, limit } });
});

/** Get sync transactions (monitoring) */
router.get('/sync/transactions', async (req: Request, res: Response) => {
  const db = getDatabase();
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const status = req.query.status as string;

  const where: any = {};
  if (status) where.status = status.toUpperCase();

  const [transactions, total] = await Promise.all([
    db.syncTransaction.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    db.syncTransaction.count({ where }),
  ]);

  res.json({ success: true, data: { transactions, total, page, limit } });
});

/** Get failed syncs (dead letter queue) */
router.get('/sync/failed', async (_req: Request, res: Response) => {
  const db = getDatabase();
  const failed = await db.syncTransaction.findMany({
    where: { status: { in: ['FAILED', 'DEAD_LETTER'] } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json({ success: true, data: { failed } });
});

/** Retry a failed sync transaction */
router.post('/sync/retry/:transactionId', async (req: Request, res: Response) => {
  const db = getDatabase();
  const transactionId = req.params.transactionId as string;

  const transaction = await db.syncTransaction.findUnique({
    where: { transactionId },
  });

  if (!transaction) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaction not found' } });
    return;
  }

  await db.syncTransaction.update({
    where: { transactionId },
    data: { status: 'PENDING', retryCount: { increment: 1 } },
  });

  res.json({ success: true, data: { message: 'Retry queued' } });
});

/** Get audit logs */
router.get('/audit-logs', async (req: Request, res: Response) => {
  const result = await queryAuditLogs({
    userId: req.query.userId as string,
    action: req.query.action as string,
    resourceType: req.query.resourceType as string,
    startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
    endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
    page: parseInt(req.query.page as string) || 1,
    limit: parseInt(req.query.limit as string) || 50,
  });

  // Convert BigInt ids to strings for JSON serialization
  const logs = result.logs.map((log: any) => ({
    ...log,
    id: log.id.toString(),
  }));

  res.json({ success: true, data: { ...result, logs } });
});

/** Get conflict analytics */
router.get('/conflicts', async (req: Request, res: Response) => {
  const db = getDatabase();
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  const [conflicts, total] = await Promise.all([
    db.conflictLog.findMany({
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, displayName: true } } },
    }),
    db.conflictLog.count(),
  ]);

  res.json({ success: true, data: { conflicts, total, page, limit } });
});

/** Get webhook subscriptions */
router.get('/webhooks', async (_req: Request, res: Response) => {
  const db = getDatabase();
  const subscriptions = await db.webhookSubscription.findMany({
    orderBy: { expiresAt: 'asc' },
    include: { calendar: { select: { name: true, provider: true, user: { select: { email: true } } } } },
  });

  res.json({ success: true, data: { subscriptions } });
});

/** Update a user's email provider preference */
router.patch('/users/:id/email-provider', async (req: Request, res: Response) => {
  const db = getDatabase();
  const id = req.params.id as string;
  const { emailProvider } = req.body;

  const valid = ['AUTO', 'GOOGLE', 'MICROSOFT', 'SENDGRID'];
  if (!valid.includes(emailProvider)) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_PROVIDER', message: `emailProvider must be one of: ${valid.join(', ')}` },
    });
    return;
  }

  const user = await db.user.findUnique({ where: { id } });
  if (!user) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    return;
  }

  const updated = await db.user.update({
    where: { id },
    data: { emailProvider: emailProvider as any },
    select: { id: true, email: true, displayName: true, emailProvider: true },
  });

  res.json({ success: true, data: { user: updated } });
});

/** Get security posture overview */
router.get('/security', async (_req: Request, res: Response) => {
  const db = getDatabase();

  const [
    totalAuditLogs,
    recentFailedLogins,
    invalidWebhooks,
    loopsPrevented,
    activeWebhooks,
    expiredWebhooks,
  ] = await Promise.all([
    db.auditLog.count(),
    db.auditLog.count({
      where: {
        action: 'LOGIN_FAILED',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    db.auditLog.count({
      where: { action: 'WEBHOOK_INVALID' },
    }),
    db.auditLog.count({
      where: { action: 'SYNC_LOOP_PREVENTED' },
    }),
    db.webhookSubscription.count({ where: { status: 'ACTIVE' } }),
    db.webhookSubscription.count({
      where: { expiresAt: { lt: new Date() } },
    }),
  ]);

  res.json({
    success: true,
    data: {
      encryption: { algorithm: 'AES-256-GCM', status: 'active' },
      authProtocol: 'OAuth 2.0',
      auditLogs: { total: totalAuditLogs, immutable: true },
      threats: {
        recentFailedLogins,
        invalidWebhooks,
        loopsPrevented,
      },
      webhooks: { active: activeWebhooks, expired: expiredWebhooks },
      features: {
        helmet: true,
        cors: true,
        rateLimiting: true,
        csrfProtection: true,
        httpOnlyCookies: true,
        sqlInjectionProtection: 'Prisma ORM',
      },
    },
  });
});

export default router;
