// ============================================================
// Bootstrap a freshly-connected calendar
// ============================================================
// Called once, immediately after the user finishes OAuth for a provider.
// Does three things so the dashboard isn't empty:
//   1. Registers the user's primary calendar in our DB
//   2. Pulls existing events (last 30d + next 365d) into our DB
//   3. Subscribes to the provider's webhook so future changes stream in
//
// Runs in the background — the OAuth callback returns immediately so
// the user isn't blocked waiting for a slow Microsoft Graph call.
// ============================================================

import getDatabase from '../database/client';
import config from '../config';
import { syncLogger } from '../utils/logger';
import { encrypt } from '../crypto/encryption';
import {
  listGoogleEvents,
  googleEventToCanonical,
  watchGoogleCalendar,
} from '../connectors/google/calendar';
import {
  listMicrosoftEvents,
  microsoftEventToCanonical,
  createMicrosoftSubscription,
  getMicrosoftGraphClient,
} from '../connectors/microsoft/calendar';
import { v4 as uuidv4 } from 'uuid';

type DbProvider = 'GOOGLE' | 'MICROSOFT';
import crypto from 'crypto';

function fingerprintOf(title: string, start: Date | string, end: Date | string): string {
  return crypto
    .createHash('sha256')
    .update(`${title}|${new Date(start).toISOString()}|${new Date(end).toISOString()}`)
    .digest('hex');
}

async function upsertEvent(
  calendarId: string,
  sourcePlatform: DbProvider,
  canonical: any,
): Promise<void> {
  const db = getDatabase();
  if (!canonical.sourceEventId || !canonical.title) return;

  const idempotencyKey = `${sourcePlatform}:${canonical.sourceEventId}`;

  await db.event.upsert({
    where: { idempotencyKey },
    create: {
      calendarId,
      globalEventUuid: uuidv4(),
      sourcePlatform,
      sourceEventId: canonical.sourceEventId,
      syncFingerprint: fingerprintOf(canonical.title, canonical.startTime, canonical.endTime),
      idempotencyKey,
      title: encrypt(canonical.title || ''),
      description: encrypt(canonical.description || ''),
      startTime: new Date(canonical.startTime),
      endTime: new Date(canonical.endTime),
      timezone: canonical.timezone || 'UTC',
      isAllDay: !!canonical.isAllDay,
      location: encrypt(canonical.location || ''),
      organizerEmail: canonical.organizerEmail || '',
      organizerName: canonical.organizerName || '',
      isOrganizer: !!canonical.isOrganizer,
      meetingLink: canonical.meetingLink || '',
      etag: canonical.etag || '',
      lastModifiedAt: canonical.lastModifiedAt ? new Date(canonical.lastModifiedAt) : new Date(),
      originPlatform: sourcePlatform,
      syncState: 'PENDING',
    },
    update: {
      title: encrypt(canonical.title || ''),
      startTime: new Date(canonical.startTime),
      endTime: new Date(canonical.endTime),
      lastModifiedAt: canonical.lastModifiedAt ? new Date(canonical.lastModifiedAt) : new Date(),
    },
  });
}

export async function bootstrapGoogleConnection(userId: string): Promise<void> {
  const db = getDatabase();
  try {
    // Use the user's "primary" calendar — every Google account has one.
    const calendar = await db.calendar.upsert({
      where: {
        userId_provider_externalCalendarId: {
          userId,
          provider: 'GOOGLE',
          externalCalendarId: 'primary',
        },
      },
      create: {
        userId,
        provider: 'GOOGLE',
        externalCalendarId: 'primary',
        name: 'Primary',
        timezone: 'UTC',
        isPrimary: true,
        syncEnabled: true,
      },
      update: { syncEnabled: true },
    });

    // Pull existing events (best-effort — log and continue on failure).
    try {
      const { events, nextSyncToken } = await listGoogleEvents(userId, 'primary');
      for (const ge of events) {
        try {
          const canon = googleEventToCanonical(ge, calendar.id);
          await upsertEvent(calendar.id, 'GOOGLE', canon);
        } catch (err) {
          syncLogger.warn({ err, eventId: ge.id }, 'Skipped malformed Google event during bootstrap');
        }
      }
      await db.calendar.update({
        where: { id: calendar.id },
        data: { syncToken: nextSyncToken, lastSyncedAt: new Date() },
      });
      syncLogger.info({ userId, count: events.length }, 'Bootstrap: pulled Google events');
    } catch (err) {
      syncLogger.error({ userId, err }, 'Bootstrap: failed to pull Google events');
    }

    // Subscribe to webhook for future changes (best-effort).
    try {
      const webhookUrl = config.webhook.googleUrl || `${config.webhook.baseUrl}/webhooks/google`;
      if (webhookUrl && !webhookUrl.includes('your-domain.com')) {
        const sub = await watchGoogleCalendar(userId, 'primary', webhookUrl);
        // Persist so /webhooks/google can recognise incoming notifications.
        // Without this row the handler logs "Unknown Google webhook channel"
        // for every event Google fires.
        await db.webhookSubscription.create({
          data: {
            calendarId: calendar.id,
            provider: 'GOOGLE',
            channelId: sub.channelId,
            resourceId: sub.resourceId,
            webhookUrl,
            clientState: userId,
            expiresAt: sub.expiration,
            status: 'ACTIVE',
          },
        });
        syncLogger.info({ userId, channelId: sub.channelId }, 'Bootstrap: subscribed to Google webhook');
      }
    } catch (err) {
      syncLogger.error({ userId, err: (err as Error).message }, 'Bootstrap: failed to subscribe Google webhook');
    }
  } catch (err) {
    syncLogger.error({ userId, err: (err as Error).message, stack: (err as Error).stack }, 'Bootstrap Google failed entirely');
  }
}

export async function bootstrapMicrosoftConnection(userId: string): Promise<void> {
  const db = getDatabase();
  try {
    // Ask MS Graph for the user's default calendar — gives us the real id.
    const client = await getMicrosoftGraphClient(userId);
    const defaultCal = await client.api('/me/calendar').get();
    const externalCalendarId: string = defaultCal.id;
    const calendarName: string = defaultCal.name || 'Calendar';

    const calendar = await db.calendar.upsert({
      where: {
        userId_provider_externalCalendarId: {
          userId,
          provider: 'MICROSOFT',
          externalCalendarId,
        },
      },
      create: {
        userId,
        provider: 'MICROSOFT',
        externalCalendarId,
        name: calendarName,
        timezone: 'UTC',
        isPrimary: true,
        syncEnabled: true,
      },
      update: { syncEnabled: true },
    });

    try {
      const { events } = await listMicrosoftEvents(userId, externalCalendarId);
      for (const me of events as any[]) {
        try {
          const canon = microsoftEventToCanonical(me, calendar.id);
          await upsertEvent(calendar.id, 'MICROSOFT', canon);
        } catch (err) {
          syncLogger.warn({ err, eventId: me.id }, 'Skipped malformed Microsoft event during bootstrap');
        }
      }
      await db.calendar.update({
        where: { id: calendar.id },
        data: { lastSyncedAt: new Date() },
      });
      syncLogger.info({ userId, count: (events as any[]).length }, 'Bootstrap: pulled Microsoft events');
    } catch (err) {
      syncLogger.error({ userId, err }, 'Bootstrap: failed to pull Microsoft events');
    }

    try {
      const webhookUrl = config.webhook.microsoftUrl || `${config.webhook.baseUrl}/webhooks/microsoft`;
      if (webhookUrl && !webhookUrl.includes('your-domain.com')) {
        const sub = await createMicrosoftSubscription(userId, externalCalendarId, webhookUrl);
        await db.webhookSubscription.create({
          data: {
            calendarId: calendar.id,
            provider: 'MICROSOFT',
            channelId: sub.subscriptionId, // MS subscription id stored as channelId
            resourceId: externalCalendarId,
            webhookUrl,
            clientState: userId,
            expiresAt: sub.expiration,
            status: 'ACTIVE',
          },
        });
        syncLogger.info({ userId, subscriptionId: sub.subscriptionId }, 'Bootstrap: subscribed to Microsoft webhook');
      }
    } catch (err) {
      syncLogger.error({ userId, err: (err as Error).message }, 'Bootstrap: failed to subscribe Microsoft webhook');
    }
  } catch (err) {
    syncLogger.error({ userId, err: (err as Error).message, stack: (err as Error).stack }, 'Bootstrap Microsoft failed entirely');
  }
}
