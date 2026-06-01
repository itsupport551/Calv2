// ============================================================
// Bootstrap a freshly-connected calendar
// ============================================================
// Called once, immediately after the user finishes OAuth for a provider.
// Does three things so the dashboard isn't empty AND so events flow both ways:
//   1. Registers the user's primary calendar in our DB
//   2. Subscribes to the provider's webhook + persists the subscription
//      so future changes stream into /webhooks/{provider}
//   3. Kicks off processSyncWebhook() — the same orchestrator the live
//      webhook handler uses. That fetches the full event list, runs
//      loop-prevention fingerprinting, AND creates mirror events in the
//      other provider when present. This is what flips events from
//      PENDING → SYNCED.
//
// Runs in the background — the OAuth callback returns immediately so
// the user isn't blocked waiting for a slow Microsoft Graph call.
// ============================================================

import getDatabase from '../database/client';
import config from '../config';
import { syncLogger } from '../utils/logger';
import { watchGoogleCalendar, stopGoogleWatch } from '../connectors/google/calendar';
import {
  createMicrosoftSubscription,
  getMicrosoftGraphClient,
} from '../connectors/microsoft/calendar';
import { processSyncWebhook } from './orchestrator';
import { CalendarProvider } from '../types';

export async function bootstrapGoogleConnection(userId: string): Promise<void> {
  const db = getDatabase();
  try {
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

    // Subscribe webhook FIRST so any changes during the initial pull
    // are captured, then persist the channel so /webhooks/google can
    // recognise notifications.
    try {
      const webhookUrl = config.webhook.googleUrl || `${config.webhook.baseUrl}/webhooks/google`;
      if (webhookUrl && !webhookUrl.includes('your-domain.com')) {
        // First, retire any stale subscription rows for this calendar.
        // Reconnect-without-disconnect (or a previous deploy that crashed
        // mid-bootstrap) would otherwise leave a row whose channelId no
        // longer matches what Google has on its end → "Unknown channel".
        const stale = await db.webhookSubscription.findMany({
          where: { calendarId: calendar.id, provider: 'GOOGLE' },
        });
        for (const s of stale) {
          try { await stopGoogleWatch(s.channelId, s.resourceId, userId); } catch { /* best effort */ }
        }
        if (stale.length) {
          await db.webhookSubscription.deleteMany({
            where: { calendarId: calendar.id, provider: 'GOOGLE' },
          });
        }

        const sub = await watchGoogleCalendar(userId, 'primary', webhookUrl);
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

    // Run the same sync code-path the live webhook uses — it fetches
    // events, dedupes via fingerprint, and creates mirrors in Outlook
    // if the user has microsoftConnected. Setting events to SYNCED.
    try {
      await processSyncWebhook(userId, calendar.id, CalendarProvider.GOOGLE);
      syncLogger.info({ userId }, 'Bootstrap: initial Google sync complete');
    } catch (err) {
      syncLogger.error({ userId, err: (err as Error).message }, 'Bootstrap: initial Google sync failed');
    }
  } catch (err) {
    syncLogger.error({ userId, err: (err as Error).message, stack: (err as Error).stack }, 'Bootstrap Google failed entirely');
  }
}

export async function bootstrapMicrosoftConnection(userId: string): Promise<void> {
  const db = getDatabase();
  try {
    // Ask MS Graph for the user's default calendar — gives us its real id.
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
      const webhookUrl = config.webhook.microsoftUrl || `${config.webhook.baseUrl}/webhooks/microsoft`;
      if (webhookUrl && !webhookUrl.includes('your-domain.com')) {
        // Retire any stale MS subscription rows for this calendar.
        await db.webhookSubscription.deleteMany({
          where: { calendarId: calendar.id, provider: 'MICROSOFT' },
        });

        const sub = await createMicrosoftSubscription(userId, externalCalendarId, webhookUrl);
        await db.webhookSubscription.create({
          data: {
            calendarId: calendar.id,
            provider: 'MICROSOFT',
            channelId: sub.subscriptionId,
            resourceId: externalCalendarId,
            webhookUrl,
            // Must match what MS Graph has on its end so the handler's
            // spoofing check accepts incoming notifications.
            clientState: sub.clientState,
            expiresAt: sub.expiration,
            status: 'ACTIVE',
          },
        });
        syncLogger.info({ userId, subscriptionId: sub.subscriptionId }, 'Bootstrap: subscribed to Microsoft webhook');
      }
    } catch (err) {
      syncLogger.error({ userId, err: (err as Error).message }, 'Bootstrap: failed to subscribe Microsoft webhook');
    }

    try {
      await processSyncWebhook(userId, calendar.id, CalendarProvider.MICROSOFT);
      syncLogger.info({ userId }, 'Bootstrap: initial Microsoft sync complete');
    } catch (err) {
      syncLogger.error({ userId, err: (err as Error).message }, 'Bootstrap: initial Microsoft sync failed');
    }
  } catch (err) {
    syncLogger.error({ userId, err: (err as Error).message, stack: (err as Error).stack }, 'Bootstrap Microsoft failed entirely');
  }
}
