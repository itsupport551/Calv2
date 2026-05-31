// ============================================================
// Enterprise Calendar Sync — Microsoft Graph Connector
// ============================================================
// Wraps Microsoft Graph API with:
// - Delta query sync (incremental)
// - Free/busy via getSchedule
// - Webhook subscriptions
// - MSAL token management
// - Throttle handling (429)
// ============================================================

import { Client } from '@microsoft/microsoft-graph-client';
import config from '../../config';
import { syncLogger } from '../../utils/logger';
import { withRetry } from '../../utils/retry';
import { decrypt, encrypt } from '../../crypto/encryption';
import getDatabase from '../../database/client';
import { CanonicalEvent, CalendarProvider, EventStatus, EventVisibility, ShowAsStatus, AttendeeResponseStatus, FreeBusySlot } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { microsoftRecurrenceToCanonical, canonicalToMicrosoftRecurrence } from '../../sync/recurringEvents';
import { refreshAccessToken } from './oauth';

/**
 * Get an authenticated Microsoft Graph client for a user.
 */
export async function getMicrosoftGraphClient(userId: string): Promise<Client> {
  const db = getDatabase();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      microsoftAccessToken: true,
      microsoftRefreshToken: true,
      microsoftTokenExpiresAt: true,
    },
  });

  if (!user?.microsoftAccessToken) {
    throw new Error('Microsoft account not connected');
  }

  let accessToken = decrypt(user.microsoftAccessToken);

  // Refresh if expired (and we have a refresh token to do so with).
  const expired =
    user.microsoftTokenExpiresAt && new Date() >= user.microsoftTokenExpiresAt;
  if (expired && user.microsoftRefreshToken) {
    syncLogger.info({ userId }, 'Refreshing expired Microsoft token');
    try {
      const tokens = await refreshAccessToken(decrypt(user.microsoftRefreshToken));
      accessToken = tokens.accessToken;
      await db.user.update({
        where: { id: userId },
        data: {
          microsoftAccessToken: encrypt(tokens.accessToken),
          // MS may rotate the refresh token; persist the new one if given.
          microsoftRefreshToken: tokens.refreshToken
            ? encrypt(tokens.refreshToken)
            : user.microsoftRefreshToken,
          microsoftTokenExpiresAt: tokens.expiresAt,
        },
      });
    } catch (error) {
      syncLogger.error({ userId, error: (error as Error).message }, 'Failed to refresh Microsoft token');
      throw new Error('Microsoft token refresh failed — user needs to re-authenticate');
    }
  }

  return Client.init({
    authProvider: (done) => done(null, accessToken),
  });
}

/**
 * List events using delta queries (incremental sync).
 */
export async function listMicrosoftEvents(
  userId: string,
  calendarId: string,
  deltaLink?: string | null
): Promise<{ events: any[]; nextDeltaLink: string | null }> {
  const client = await getMicrosoftGraphClient(userId);

  return withRetry(async () => {
    const allEvents: any[] = [];
    let nextLink: string | undefined;
    let resultDeltaLink: string | null = null;

    // Use delta link for incremental sync, or start fresh
    let url = deltaLink || `/me/calendars/${calendarId}/events/delta`;

    do {
      const response = await client.api(url).get();
      if (response.value) allEvents.push(...response.value);
      nextLink = response['@odata.nextLink'];
      resultDeltaLink = response['@odata.deltaLink'] || null;
      url = nextLink || '';
    } while (nextLink);

    syncLogger.info({ userId, calendarId, count: allEvents.length }, 'Listed Microsoft events');
    return { events: allEvents, nextDeltaLink: resultDeltaLink };
  }, 'listMicrosoftEvents');
}

/**
 * Create an event in Microsoft Calendar.
 */
export async function createMicrosoftEvent(userId: string, calendarId: string, event: CanonicalEvent): Promise<any> {
  const client = await getMicrosoftGraphClient(userId);
  const msEvent = canonicalToMicrosoftEvent(event);

  return withRetry(async () => {
    const response = await client.api(`/me/calendars/${calendarId}/events`).post(msEvent);
    syncLogger.info({ userId, calendarId, eventId: response.id }, 'Created Microsoft event');
    return response;
  }, 'createMicrosoftEvent');
}

/**
 * Update an event in Microsoft Calendar.
 */
export async function updateMicrosoftEvent(userId: string, eventId: string, event: CanonicalEvent): Promise<any> {
  const client = await getMicrosoftGraphClient(userId);
  const msEvent = canonicalToMicrosoftEvent(event);

  return withRetry(async () => {
    const response = await client.api(`/me/events/${eventId}`).patch(msEvent);
    syncLogger.info({ userId, eventId }, 'Updated Microsoft event');
    return response;
  }, 'updateMicrosoftEvent');
}

/**
 * Delete an event in Microsoft Calendar.
 */
export async function deleteMicrosoftEvent(userId: string, eventId: string): Promise<void> {
  const client = await getMicrosoftGraphClient(userId);

  await withRetry(async () => {
    await client.api(`/me/events/${eventId}`).delete();
    syncLogger.info({ userId, eventId }, 'Deleted Microsoft event');
  }, 'deleteMicrosoftEvent');
}

/**
 * Decline an invite in Microsoft Outlook. Microsoft Graph has a
 * dedicated /decline endpoint that fires the appropriate response to
 * the organizer with `sendResponse: true`.
 */
export async function declineMicrosoftEvent(
  userId: string,
  eventId: string,
  comment?: string,
): Promise<void> {
  const client = await getMicrosoftGraphClient(userId);

  await withRetry(async () => {
    await client.api(`/me/events/${eventId}/decline`).post({
      comment: comment || 'Automatically declined — schedule conflict.',
      sendResponse: true,
    });
    syncLogger.info({ userId, eventId }, 'Declined Microsoft invite');
  }, 'declineMicrosoftEvent');
}

/**
 * Get free/busy schedule from Microsoft Graph.
 */
export async function getMicrosoftFreeBusy(
  userId: string,
  email: string,
  timeMin: Date,
  timeMax: Date
): Promise<FreeBusySlot[]> {
  const client = await getMicrosoftGraphClient(userId);

  const response = await client.api('/me/calendar/getSchedule').post({
    schedules: [email],
    startTime: { dateTime: timeMin.toISOString(), timeZone: 'UTC' },
    endTime: { dateTime: timeMax.toISOString(), timeZone: 'UTC' },
  });

  const schedule = response.value?.[0];
  if (!schedule?.scheduleItems) return [];

  return schedule.scheduleItems.map((item: any) => ({
    start: new Date(item.start.dateTime),
    end: new Date(item.end.dateTime),
    status: mapMicrosoftFreeBusyStatus(item.status),
    provider: CalendarProvider.MICROSOFT,
    title: item.subject,
  }));
}

/**
 * Create a webhook subscription for Microsoft Calendar.
 */
export async function createMicrosoftSubscription(
  userId: string,
  calendarId: string,
  webhookUrl: string
): Promise<{ subscriptionId: string; expiration: Date }> {
  const client = await getMicrosoftGraphClient(userId);
  const clientState = uuidv4();

  const response = await client.api('/subscriptions').post({
    changeType: 'created,updated,deleted',
    notificationUrl: webhookUrl,
    resource: `/me/calendars/${calendarId}/events`,
    expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
    clientState,
  });

  return {
    subscriptionId: response.id,
    expiration: new Date(response.expirationDateTime),
  };
}

/**
 * Renew a Microsoft webhook subscription.
 */
export async function renewMicrosoftSubscription(userId: string, subscriptionId: string): Promise<Date> {
  const client = await getMicrosoftGraphClient(userId);
  const newExpiration = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  await client.api(`/subscriptions/${subscriptionId}`).patch({
    expirationDateTime: newExpiration.toISOString(),
  });

  return newExpiration;
}

/**
 * Send an email via Microsoft Graph (for rejection emails).
 */
export async function sendMicrosoftEmail(
  userId: string,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const client = await getMicrosoftGraphClient(userId);

  await client.api('/me/sendMail').post({
    message: {
      subject,
      body: { contentType: 'HTML', content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  });
}

// ---- Normalizers ----

/**
 * Convert a Microsoft Graph event to our canonical model.
 */
export function microsoftEventToCanonical(msEvent: any, calendarId: string): Partial<CanonicalEvent> {
  return {
    sourceEventId: msEvent.id || '',
    sourcePlatform: CalendarProvider.MICROSOFT,
    calendarId,
    title: msEvent.subject || '(No title)',
    description: msEvent.bodyPreview || msEvent.body?.content || '',
    startTime: new Date(msEvent.start?.dateTime + 'Z'),
    endTime: new Date(msEvent.end?.dateTime + 'Z'),
    timezone: msEvent.start?.timeZone || 'UTC',
    isAllDay: msEvent.isAllDay || false,
    location: msEvent.location?.displayName || '',
    status: mapMicrosoftStatus(msEvent.showAs),
    visibility: msEvent.sensitivity === 'private' ? EventVisibility.PRIVATE : EventVisibility.DEFAULT,
    showAs: mapMicrosoftShowAs(msEvent.showAs),
    organizerEmail: msEvent.organizer?.emailAddress?.address || '',
    organizerName: msEvent.organizer?.emailAddress?.name || '',
    isOrganizer: msEvent.isOrganizer || false,
    attendees: (msEvent.attendees || []).map((a: any) => ({
      email: a.emailAddress?.address || '',
      name: a.emailAddress?.name || '',
      responseStatus: mapMicrosoftResponseStatus(a.status?.response),
      isOptional: a.type === 'optional',
      isOrganizer: false,
    })),
    recurrenceRule: (msEvent.recurrence ? microsoftRecurrenceToCanonical(msEvent.recurrence) : null) as any,
    meetingLink: msEvent.onlineMeeting?.joinUrl || msEvent.onlineMeetingUrl || '',
    etag: msEvent['@odata.etag'] || '',
    lastModifiedAt: new Date(msEvent.lastModifiedDateTime || Date.now()),
    originPlatform: CalendarProvider.MICROSOFT,
  };
}

function canonicalToMicrosoftEvent(event: CanonicalEvent): any {
  const msEvent: any = {
    subject: event.title,
    body: { contentType: 'text', content: event.description },
    start: { dateTime: event.startTime.toISOString().replace('Z', ''), timeZone: event.timezone || 'UTC' },
    end: { dateTime: event.endTime.toISOString().replace('Z', ''), timeZone: event.timezone || 'UTC' },
    isAllDay: event.isAllDay,
    location: { displayName: event.location },
    showAs: reverseMapShowAs(event.showAs),
    attendees: event.attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name },
      type: a.isOptional ? 'optional' : 'required',
    })),
  };

  if (event.recurrenceRule) {
    msEvent.recurrence = canonicalToMicrosoftRecurrence(event.recurrenceRule as any);
  }

  return msEvent;
}

// ---- Status Mappers ----

function mapMicrosoftStatus(showAs?: string): EventStatus {
  switch (showAs) {
    case 'tentative': return EventStatus.TENTATIVE;
    case 'free': return EventStatus.CONFIRMED;
    default: return EventStatus.CONFIRMED;
  }
}

function mapMicrosoftShowAs(showAs?: string): ShowAsStatus {
  switch (showAs) {
    case 'free': return ShowAsStatus.FREE;
    case 'busy': return ShowAsStatus.BUSY;
    case 'tentative': return ShowAsStatus.TENTATIVE;
    case 'oof': return ShowAsStatus.OUT_OF_OFFICE;
    case 'workingElsewhere': return ShowAsStatus.WORKING_ELSEWHERE;
    default: return ShowAsStatus.UNKNOWN;
  }
}

function mapMicrosoftFreeBusyStatus(status: string): ShowAsStatus {
  switch (status) {
    case 'busy': return ShowAsStatus.BUSY;
    case 'tentative': return ShowAsStatus.TENTATIVE;
    case 'oof': return ShowAsStatus.OUT_OF_OFFICE;
    case 'workingElsewhere': return ShowAsStatus.WORKING_ELSEWHERE;
    default: return ShowAsStatus.BUSY;
  }
}

function mapMicrosoftResponseStatus(response?: string): AttendeeResponseStatus {
  switch (response) {
    case 'accepted': return AttendeeResponseStatus.ACCEPTED;
    case 'declined': return AttendeeResponseStatus.DECLINED;
    case 'tentativelyAccepted': return AttendeeResponseStatus.TENTATIVE;
    case 'none': return AttendeeResponseStatus.NEEDS_ACTION;
    default: return AttendeeResponseStatus.NONE;
  }
}

function reverseMapShowAs(status: ShowAsStatus): string {
  switch (status) {
    case ShowAsStatus.FREE: return 'free';
    case ShowAsStatus.BUSY: return 'busy';
    case ShowAsStatus.TENTATIVE: return 'tentative';
    case ShowAsStatus.OUT_OF_OFFICE: return 'oof';
    case ShowAsStatus.WORKING_ELSEWHERE: return 'workingElsewhere';
    default: return 'busy';
  }
}

