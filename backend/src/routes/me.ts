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
import { deleteGoogleEvent, stopGoogleWatch } from '../connectors/google/calendar';
import { deleteMicrosoftEvent } from '../connectors/microsoft/calendar';
import { syncLogger } from '../utils/logger';

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

/**
 * Delete an event everywhere — source provider, mirror, and our DB.
 *
 * We don't trust the webhook to propagate the delete fast enough for
 * the UI (it can take 1-2 minutes), and we don't want the row to come
 * back in the next sync. So this endpoint:
 *   1. Loads the event + the user's other-provider connection
 *   2. Calls DELETE on the source provider's API (Google or Microsoft)
 *   3. If a mirror exists, calls DELETE on the mirror's provider too
 *   4. Removes our local row
 * Each provider call is best-effort — a 404 there means it's already
 * gone, which is fine for our purposes.
 */
router.delete('/events/:id', async (req: Request, res: Response) => {
  const db = getDatabase();
  const userId = req.authUser!.id;
  const eventId = req.params.id as string;

  const event = await db.event.findFirst({
    where: { id: eventId, calendar: { userId } },
    include: { calendar: true },
  });
  if (!event) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Event not found' } });
    return;
  }

  // Delete from the source provider.
  try {
    if (event.sourcePlatform === 'GOOGLE') {
      await deleteGoogleEvent(userId, event.calendar.externalCalendarId, event.sourceEventId);
    } else {
      await deleteMicrosoftEvent(userId, event.sourceEventId);
    }
    syncLogger.info({ userId, eventId, provider: event.sourcePlatform }, 'Deleted source event');
  } catch (err: any) {
    // 404/410 from the provider means already gone — treat as success.
    const status = err?.code ?? err?.statusCode ?? err?.response?.status;
    if (status !== 404 && status !== 410 && status !== 'GONE') {
      syncLogger.warn({ userId, eventId, err: err?.message }, 'Source delete failed (continuing)');
    }
  }

  // Delete the mirror in the other provider, if one exists.
  if (event.mirrorEventId && event.mirrorPlatform) {
    // Find the mirror's calendar id in our DB (might be in a different Calendar row).
    const mirrorCalendar = await db.calendar.findFirst({
      where: { userId, provider: event.mirrorPlatform },
    });
    try {
      if (event.mirrorPlatform === 'GOOGLE' && mirrorCalendar) {
        await deleteGoogleEvent(userId, mirrorCalendar.externalCalendarId, event.mirrorEventId);
      } else if (event.mirrorPlatform === 'MICROSOFT') {
        await deleteMicrosoftEvent(userId, event.mirrorEventId);
      }
      syncLogger.info({ userId, eventId, mirrorProvider: event.mirrorPlatform }, 'Deleted mirror event');
    } catch (err: any) {
      const status = err?.code ?? err?.statusCode ?? err?.response?.status;
      if (status !== 404 && status !== 410 && status !== 'GONE') {
        syncLogger.warn({ userId, eventId, err: err?.message }, 'Mirror delete failed (continuing)');
      }
    }
  }

  // Remove our local row last.
  await db.event.delete({ where: { id: eventId } });

  res.json({ success: true, data: { id: eventId } });
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

  // Cancel webhook subscriptions BEFORE clearing tokens, while we still
  // have the access token to authenticate the stop call. Without this,
  // the old Google watch channel keeps firing notifications after a
  // disconnect — and after a future reconnect, those stale channel ids
  // produce "Unknown Google webhook channel" in the deploy logs because
  // the new WebhookSubscription row has a different id.
  const dbProvider = provider === 'google' ? 'GOOGLE' : 'MICROSOFT';
  const subs = await db.webhookSubscription.findMany({
    where: { provider: dbProvider, calendar: { userId } },
  });
  for (const sub of subs) {
    if (provider === 'google') {
      try {
        await stopGoogleWatch(sub.channelId, sub.resourceId, userId);
      } catch (err) {
        syncLogger.warn({ userId, channelId: sub.channelId, err: (err as Error).message }, 'Failed to stop Google watch (continuing)');
      }
    }
    // Microsoft subscription deletion would go here when we add it.
  }
  await db.webhookSubscription.deleteMany({
    where: { provider: dbProvider, calendar: { userId } },
  });

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
