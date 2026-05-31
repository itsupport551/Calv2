// ============================================================
// Enterprise Calendar Sync — Google Calendar Connector
// ============================================================
// Wraps Google Calendar API v3 with:
// - Incremental sync via sync tokens
// - Free/busy queries
// - Webhook management
// - Automatic token refresh
// - Rate limit handling
// ============================================================

import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import config from '../../config';
import { syncLogger } from '../../utils/logger';
import { withRetry } from '../../utils/retry';
import { decrypt, encrypt } from '../../crypto/encryption';
import getDatabase from '../../database/client';
import { CanonicalEvent, CalendarProvider, EventStatus, EventVisibility, ShowAsStatus, AttendeeResponseStatus, FreeBusySlot } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { googleRruleToCanonical, canonicalToGoogleRrule } from '../../sync/recurringEvents';

/**
 * Create an authenticated OAuth2 client for a user.
 * Automatically refreshes expired tokens.
 */
export async function getGoogleAuthClient(userId: string): Promise<OAuth2Client> {
  const db = getDatabase();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      googleAccessToken: true,
      googleRefreshToken: true,
      googleTokenExpiresAt: true,
    },
  });

  if (!user?.googleAccessToken || !user?.googleRefreshToken) {
    throw new Error('Google account not connected');
  }

  const oauth2Client = new OAuth2Client(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );

  oauth2Client.setCredentials({
    access_token: decrypt(user.googleAccessToken),
    refresh_token: decrypt(user.googleRefreshToken),
    expiry_date: user.googleTokenExpiresAt?.getTime(),
  });

  // Auto-refresh if expired
  if (user.googleTokenExpiresAt && new Date() >= user.googleTokenExpiresAt) {
    syncLogger.info({ userId }, 'Refreshing expired Google token');
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);

    // Store refreshed token
    await db.user.update({
      where: { id: userId },
      data: {
        googleAccessToken: encrypt(credentials.access_token!),
        googleTokenExpiresAt: new Date(credentials.expiry_date!),
      },
    });
  }

  return oauth2Client;
}

/**
 * List events with incremental sync support.
 * Uses syncToken to fetch only changed events since last sync.
 */
export async function listGoogleEvents(
  userId: string,
  calendarId: string,
  syncToken?: string | null
): Promise<{ events: calendar_v3.Schema$Event[]; nextSyncToken: string | null }> {
  const auth = await getGoogleAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  // Google's API rules:
  //  - `syncToken` cannot be combined with `orderBy` or any filter
  //    (timeMin, timeMax, etc.) — it tracks "everything since last sync"
  //    against the exact same query you used originally.
  //  - If you pass a syncToken from an older query whose parameters no
  //    longer match (e.g. we changed the time window), Google returns
  //    HTTP 410 Gone. The fix is to re-bootstrap WITHOUT the token.
  //
  // We therefore: drop `orderBy` entirely (we don't need a stable sort,
  // and it's incompatible with syncToken anyway); and on 410 we retry
  // once from scratch.

  async function doFetch(useSyncToken: string | null | undefined) {
    return withRetry(async () => {
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId,
        maxResults: 250,
        singleEvents: true,
      };

      if (useSyncToken) {
        params.syncToken = useSyncToken;
      } else {
        // Initial / re-bootstrap window: now → +30 days. Matches what
        // the dashboard shows. Past events are not synced and we don't
        // pre-load far future either — small DB, fast first bootstrap.
        const now = new Date();
        params.timeMin = now.toISOString();
        params.timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      }

      const allEvents: calendar_v3.Schema$Event[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | null = null;

      do {
        const response = await calendar.events.list({ ...params, pageToken });
        if (response.data.items) allEvents.push(...response.data.items);
        pageToken = response.data.nextPageToken || undefined;
        nextSyncToken = response.data.nextSyncToken || null;
      } while (pageToken);

      syncLogger.info({ userId, calendarId, count: allEvents.length }, 'Listed Google events');
      return { events: allEvents, nextSyncToken };
    }, 'listGoogleEvents');
  }

  try {
    return await doFetch(syncToken);
  } catch (err: any) {
    const status = err?.code ?? err?.response?.status;
    const msg = err?.message || '';
    const isTokenInvalid =
      status === 410 ||
      /sync token/i.test(msg) ||
      /fullSyncRequired/i.test(msg);
    if (syncToken && isTokenInvalid) {
      syncLogger.warn({ userId, calendarId }, 'Google sync token invalid — falling back to full window fetch');
      return doFetch(null);
    }
    throw err;
  }
}

/**
 * Create an event in Google Calendar.
 */
export async function createGoogleEvent(
  userId: string,
  calendarId: string,
  event: CanonicalEvent
): Promise<calendar_v3.Schema$Event> {
  const auth = await getGoogleAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  const googleEvent = canonicalToGoogleEvent(event);

  return withRetry(async () => {
    const response = await calendar.events.insert({
      calendarId,
      requestBody: googleEvent,
    });
    syncLogger.info({ userId, calendarId, eventId: response.data.id }, 'Created Google event');
    return response.data;
  }, 'createGoogleEvent');
}

/**
 * Update an event in Google Calendar.
 */
export async function updateGoogleEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  event: CanonicalEvent
): Promise<calendar_v3.Schema$Event> {
  const auth = await getGoogleAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  const googleEvent = canonicalToGoogleEvent(event);

  return withRetry(async () => {
    const response = await calendar.events.update({
      calendarId,
      eventId,
      requestBody: googleEvent,
    });
    syncLogger.info({ userId, calendarId, eventId }, 'Updated Google event');
    return response.data;
  }, 'updateGoogleEvent');
}

/**
 * Delete an event in Google Calendar.
 */
export async function deleteGoogleEvent(
  userId: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const auth = await getGoogleAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  await withRetry(async () => {
    await calendar.events.delete({ calendarId, eventId });
    syncLogger.info({ userId, calendarId, eventId }, 'Deleted Google event');
  }, 'deleteGoogleEvent');
}

/**
 * Get free/busy information from Google Calendar.
 */
export async function getGoogleFreeBusy(
  userId: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<FreeBusySlot[]> {
  const auth = await getGoogleAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: calendarId }],
    },
  });

  const busySlots = response.data.calendars?.[calendarId]?.busy || [];

  return busySlots.map(slot => ({
    start: new Date(slot.start!),
    end: new Date(slot.end!),
    status: ShowAsStatus.BUSY,
    provider: CalendarProvider.GOOGLE,
  }));
}

/**
 * Set up a webhook (push notification) for a Google Calendar.
 */
export async function watchGoogleCalendar(
  userId: string,
  calendarId: string,
  webhookUrl: string
): Promise<{ channelId: string; resourceId: string; expiration: Date }> {
  const auth = await getGoogleAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  const channelId = uuidv4();

  const response = await calendar.events.watch({
    calendarId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: webhookUrl,
      token: userId, // Used for webhook verification
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
  });

  return {
    channelId: response.data.id!,
    resourceId: response.data.resourceId!,
    expiration: new Date(parseInt(response.data.expiration!, 10)),
  };
}

/**
 * Stop watching a Google Calendar webhook.
 */
export async function stopGoogleWatch(channelId: string, resourceId: string, userId: string): Promise<void> {
  const auth = await getGoogleAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.channels.stop({
    requestBody: { id: channelId, resourceId },
  });
}

// ---- Normalizers ----

/**
 * Convert a Google Calendar event to our canonical model.
 */
export function googleEventToCanonical(
  googleEvent: calendar_v3.Schema$Event,
  calendarId: string
): Partial<CanonicalEvent> {
  return {
    sourceEventId: googleEvent.id || '',
    sourcePlatform: CalendarProvider.GOOGLE,
    calendarId,
    title: googleEvent.summary || '(No title)',
    description: googleEvent.description || '',
    startTime: new Date(googleEvent.start?.dateTime || googleEvent.start?.date || ''),
    endTime: new Date(googleEvent.end?.dateTime || googleEvent.end?.date || ''),
    timezone: googleEvent.start?.timeZone || 'UTC',
    isAllDay: !!googleEvent.start?.date,
    location: googleEvent.location || '',
    status: mapGoogleStatus(googleEvent.status),
    visibility: mapGoogleVisibility(googleEvent.visibility),
    showAs: googleEvent.transparency === 'transparent' ? ShowAsStatus.FREE : ShowAsStatus.BUSY,
    organizerEmail: googleEvent.organizer?.email || '',
    organizerName: googleEvent.organizer?.displayName || '',
    isOrganizer: googleEvent.organizer?.self || false,
    attendees: (googleEvent.attendees || []).map(a => ({
      email: a.email || '',
      name: a.displayName || '',
      responseStatus: mapGoogleResponseStatus(a.responseStatus),
      isOptional: a.optional || false,
      isOrganizer: a.organizer || false,
    })),
    recurrenceRule: (googleEvent.recurrence ? googleRruleToCanonical(googleEvent.recurrence) : null) as any,
    recurringEventId: googleEvent.recurringEventId || null,
    isRecurringInstance: !!googleEvent.recurringEventId,
    meetingLink: googleEvent.hangoutLink || googleEvent.conferenceData?.entryPoints?.[0]?.uri || '',
    etag: googleEvent.etag || '',
    lastModifiedAt: new Date(googleEvent.updated || Date.now()),
    originPlatform: CalendarProvider.GOOGLE,
  };
}

/**
 * Convert our canonical model to a Google Calendar event.
 */
function canonicalToGoogleEvent(event: CanonicalEvent): calendar_v3.Schema$Event {
  const googleEvent: calendar_v3.Schema$Event = {
    summary: event.title,
    description: event.description,
    location: event.location,
    status: reverseMapStatus(event.status),
    visibility: reverseMapVisibility(event.visibility),
    transparency: event.showAs === ShowAsStatus.FREE ? 'transparent' : 'opaque',
    attendees: event.attendees.map(a => ({
      email: a.email,
      displayName: a.name,
      responseStatus: reverseMapResponseStatus(a.responseStatus),
      optional: a.isOptional,
    })),
  };

  if (event.isAllDay) {
    googleEvent.start = { date: event.startTime.toISOString().split('T')[0] };
    googleEvent.end = { date: event.endTime.toISOString().split('T')[0] };
  } else {
    googleEvent.start = { dateTime: event.startTime.toISOString(), timeZone: event.timezone };
    googleEvent.end = { dateTime: event.endTime.toISOString(), timeZone: event.timezone };
  }

  if (event.recurrenceRule) {
    googleEvent.recurrence = canonicalToGoogleRrule(event.recurrenceRule as any);
  }

  return googleEvent;
}

// ---- Status Mappers ----

function mapGoogleStatus(status?: string | null): EventStatus {
  switch (status) {
    case 'confirmed': return EventStatus.CONFIRMED;
    case 'tentative': return EventStatus.TENTATIVE;
    case 'cancelled': return EventStatus.CANCELLED;
    default: return EventStatus.CONFIRMED;
  }
}

function mapGoogleVisibility(visibility?: string | null): EventVisibility {
  switch (visibility) {
    case 'public': return EventVisibility.PUBLIC;
    case 'private': return EventVisibility.PRIVATE;
    case 'confidential': return EventVisibility.CONFIDENTIAL;
    default: return EventVisibility.DEFAULT;
  }
}

function mapGoogleResponseStatus(status?: string | null): AttendeeResponseStatus {
  switch (status) {
    case 'accepted': return AttendeeResponseStatus.ACCEPTED;
    case 'declined': return AttendeeResponseStatus.DECLINED;
    case 'tentative': return AttendeeResponseStatus.TENTATIVE;
    case 'needsAction': return AttendeeResponseStatus.NEEDS_ACTION;
    default: return AttendeeResponseStatus.NONE;
  }
}

function reverseMapStatus(status: EventStatus): string {
  switch (status) {
    case EventStatus.CONFIRMED: return 'confirmed';
    case EventStatus.TENTATIVE: return 'tentative';
    case EventStatus.CANCELLED: return 'cancelled';
  }
}

function reverseMapVisibility(vis: EventVisibility): string {
  switch (vis) {
    case EventVisibility.PUBLIC: return 'public';
    case EventVisibility.PRIVATE: return 'private';
    case EventVisibility.CONFIDENTIAL: return 'confidential';
    case EventVisibility.DEFAULT: return 'default';
  }
}

function reverseMapResponseStatus(status: AttendeeResponseStatus): string {
  switch (status) {
    case AttendeeResponseStatus.ACCEPTED: return 'accepted';
    case AttendeeResponseStatus.DECLINED: return 'declined';
    case AttendeeResponseStatus.TENTATIVE: return 'tentative';
    case AttendeeResponseStatus.NEEDS_ACTION: return 'needsAction';
    case AttendeeResponseStatus.NONE: return 'needsAction';
  }
}

