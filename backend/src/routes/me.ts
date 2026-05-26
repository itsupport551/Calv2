// ============================================================
// Enterprise Calendar Sync — "Me" / Personal Routes
// ============================================================
// Endpoints scoped to the currently-authenticated user:
//   GET  /api/me            → identity + which providers are connected
//   GET  /api/me/events     → the user's events from our DB (synced + native)
//   POST /api/me/disconnect → unlink a provider (google or microsoft)
//   POST /api/me/logout     → clear the auth cookie
// ============================================================

import { Router, Request, Response } from 'express';
import { authenticateSupabase } from '../middleware/supabaseAuth';
import getDatabase from '../database/client';
import { decrypt } from '../crypto/encryption';

/**
 * Some legacy rows were written before encryption was rolled out, so a
 * `decrypt()` call on them will throw. Treat decryption failure as
 * "value is already plaintext" rather than crashing the whole response.
 */
function safeDecrypt(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

const router = Router();

router.use(authenticateSupabase);

/** Current user profile + connection status */
router.get('/', async (req: Request, res: Response) => {
  const db = getDatabase();
  const user = await db.user.findUnique({
    where: { id: req.authUser!.id },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      googleConnected: true,
      microsoftConnected: true,
      emailProvider: true,
      lastSyncAt: true,
      createdAt: true,
    },
  });
  if (!user) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    return;
  }
  res.json({ success: true, data: { user } });
});

/** Events visible to the current user (from any of their calendars) */
router.get('/events', async (req: Request, res: Response) => {
  const db = getDatabase();
  const userId = req.authUser!.id;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const fromQuery = req.query.from as string | undefined;
  const toQuery = req.query.to as string | undefined;

  // Default window: 30 days back, 90 days forward
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const defaultTo = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const from = fromQuery ? new Date(fromQuery) : defaultFrom;
  const to = toQuery ? new Date(toQuery) : defaultTo;

  const events = await db.event.findMany({
    where: {
      calendar: { userId },
      startTime: { gte: from, lte: to },
    },
    select: {
      id: true,
      title: true,
      description: true,
      startTime: true,
      endTime: true,
      timezone: true,
      isAllDay: true,
      location: true,
      status: true,
      showAs: true,
      organizerEmail: true,
      organizerName: true,
      isOrganizer: true,
      sourcePlatform: true,
      mirrorPlatform: true,
      syncState: true,
      conflictState: true,
      meetingLink: true,
      isRecurringInstance: true,
    },
    orderBy: { startTime: 'asc' },
    take: limit,
  });

  // Title / description / location are AES-256-GCM encrypted at rest.
  // Decrypt them on the way out — the API contract is plaintext.
  const decrypted = events.map(ev => ({
    ...ev,
    title: safeDecrypt(ev.title),
    description: safeDecrypt(ev.description),
    location: safeDecrypt(ev.location),
  }));

  res.json({ success: true, data: { events: decrypted, total: decrypted.length, from, to } });
});

/** Unlink a connected provider */
router.post('/disconnect/:provider', async (req: Request, res: Response) => {
  const db = getDatabase();
  const userId = req.authUser!.id;
  const provider = req.params.provider;

  if (provider !== 'google' && provider !== 'microsoft') {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_PROVIDER', message: 'Provider must be "google" or "microsoft"' },
    });
    return;
  }

  const update =
    provider === 'google'
      ? {
          googleConnected: false,
          googleAccessToken: null,
          googleRefreshToken: null,
          googleTokenExpiresAt: null,
        }
      : {
          microsoftConnected: false,
          microsoftAccessToken: null,
          microsoftRefreshToken: null,
          microsoftTokenExpiresAt: null,
        };

  const user = await db.user.update({ where: { id: userId }, data: update });
  res.json({
    success: true,
    data: {
      provider,
      googleConnected: user.googleConnected,
      microsoftConnected: user.microsoftConnected,
    },
  });
});

/** Clear the auth cookie */
router.post('/logout', async (_req: Request, res: Response) => {
  // Must match the attributes used when setting the cookie or some
  // browsers won't clear it.
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('token', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  });
  res.json({ success: true });
});

export default router;
