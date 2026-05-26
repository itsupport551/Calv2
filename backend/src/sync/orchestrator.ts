// ============================================================
// Enterprise Calendar Sync — Sync Orchestrator (Core Engine)
// ============================================================
// The brain of the sync system. Handles:
// 1. Receiving webhook notifications
// 2. Fetching changed events from source platform
// 3. Loop prevention via fingerprint comparison
// 4. Conflict checking via conflict engine
// 5. Creating/updating mirror events on target platform
// 6. Recording sync transactions
// 7. Audit logging everything
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import getDatabase from '../database/client';
import { syncLogger } from '../utils/logger';
import { generateSyncFingerprint, isSyncLoop, generateIdempotencyKey } from './fingerprint';
import { listGoogleEvents, createGoogleEvent, updateGoogleEvent, deleteGoogleEvent, googleEventToCanonical } from '../connectors/google/calendar';
import { listMicrosoftEvents, createMicrosoftEvent, updateMicrosoftEvent, deleteMicrosoftEvent, microsoftEventToCanonical } from '../connectors/microsoft/calendar';
import { checkForConflicts } from '../conflict/detector';
import { handleAutoRejection } from '../conflict/autoReject';
import { logAuditEvent } from '../audit/logger';
import { CalendarProvider, CanonicalEvent, SyncState, ConflictState, AuditAction, AuditResourceType, AuditSource } from '../types';
import { encrypt } from '../crypto/encryption';

/**
 * Process a webhook notification — the main sync entry point.
 * Called by the queue worker when a webhook is received.
 */
export async function processSyncWebhook(
  userId: string,
  calendarId: string,
  provider: CalendarProvider
): Promise<void> {
  const db = getDatabase();
  const startTime = Date.now();

  syncLogger.info({ userId, calendarId, provider }, 'Starting sync processing');

  try {
    // 1. Get calendar record with sync token
    const calendar = await db.calendar.findFirst({
      where: { id: calendarId, userId },
      include: { user: true },
    });

    if (!calendar || !calendar.syncEnabled) {
      syncLogger.warn({ calendarId }, 'Calendar not found or sync disabled');
      return;
    }

    // 2. Fetch changed events from source platform
    let changedEvents: any[] = [];
    let newSyncToken: string | null = null;

    if (provider === CalendarProvider.GOOGLE) {
      const result = await listGoogleEvents(userId, calendar.externalCalendarId, calendar.syncToken);
      changedEvents = result.events;
      newSyncToken = result.nextSyncToken;
    } else {
      const result = await listMicrosoftEvents(userId, calendar.externalCalendarId, calendar.syncToken);
      changedEvents = result.events;
      newSyncToken = result.nextDeltaLink;
    }

    syncLogger.info({ userId, provider, changedCount: changedEvents.length }, 'Fetched changed events');

    // 3. Process each changed event
    for (const rawEvent of changedEvents) {
      try {
        await processEventChange(userId, calendar, rawEvent, provider);
      } catch (error) {
        syncLogger.error({ userId, eventId: rawEvent.id, error }, 'Failed to process event');
      }
    }

    // 4. Update sync token for incremental sync
    if (newSyncToken) {
      await db.calendar.update({
        where: { id: calendarId },
        data: { syncToken: newSyncToken, lastSyncedAt: new Date() },
      });
    }

    const duration = Date.now() - startTime;
    syncLogger.info({ userId, provider, duration: `${duration}ms`, processed: changedEvents.length }, 'Sync completed');

  } catch (error) {
    // Render Error objects so the message + stack show up in deploy logs
    // instead of "[object Object]" — otherwise debugging "Sync processing
    // failed" requires guessing.
    const err = error instanceof Error
      ? { message: error.message, stack: error.stack, name: error.name }
      : { error };
    syncLogger.error({ userId, calendarId, provider, ...err }, 'Sync processing failed');
    await logAuditEvent({
      userId,
      action: AuditAction.SYNC_FAILED,
      resourceType: AuditResourceType.CALENDAR,
      resourceId: calendarId,
      newValue: { error: (error as Error).message, provider },
      source: AuditSource.SYSTEM,
    });
    throw error;
  }
}

/**
 * Process a single event change — the core sync logic.
 */
async function processEventChange(
  userId: string,
  calendar: any,
  rawEvent: any,
  sourceProvider: CalendarProvider
): Promise<void> {
  const db = getDatabase();
  const targetProvider = sourceProvider === CalendarProvider.GOOGLE ? CalendarProvider.MICROSOFT : CalendarProvider.GOOGLE;

  // 1. Normalize to canonical model
  const normalizedEvent = sourceProvider === CalendarProvider.GOOGLE
    ? googleEventToCanonical(rawEvent, calendar.id)
    : microsoftEventToCanonical(rawEvent, calendar.id);

  // 1a. Sync-window filter — past events and events more than 30 days
  // ahead are ignored. Matches the dashboard's display window and the
  // initial-fetch window for Google. Prevents stale events from MS delta
  // queries from leaking into the DB or being mirrored.
  if (normalizedEvent.startTime) {
    const start = new Date(normalizedEvent.startTime);
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (start < now || start > windowEnd) {
      syncLogger.debug(
        { userId, sourceEventId: normalizedEvent.sourceEventId, startTime: start },
        'Event outside (now → +30d) window — skipping',
      );
      return;
    }
  }

  const sourceEventId = normalizedEvent.sourceEventId!;

  // 2. LOOP PREVENTION — the most critical check
  const fingerprint = generateSyncFingerprint(normalizedEvent);
  const existingEvent = await db.event.findFirst({
    where: {
      calendarId: calendar.id,
      sourceEventId,
      sourcePlatform: sourceProvider === CalendarProvider.GOOGLE ? 'GOOGLE' : 'MICROSOFT',
    },
  });

  if (existingEvent) {
    // Check if this change was caused by our own sync
    if (isSyncLoop(fingerprint, existingEvent.syncFingerprint)) {
      syncLogger.info(
        { userId, sourceEventId, provider: sourceProvider },
        '🔄 LOOP PREVENTED — event fingerprint matches our sync, skipping'
      );
      await logAuditEvent({
        userId,
        action: AuditAction.SYNC_LOOP_PREVENTED,
        resourceType: AuditResourceType.EVENT,
        resourceId: existingEvent.id,
        source: AuditSource.SYSTEM,
      });
      return;
    }

    // Check if this event IS the mirror of a previously synced event (second loop prevention layer)
    if (existingEvent.mirrorEventId) {
      const mirrorCheck = await db.event.findFirst({
        where: {
          mirrorEventId: sourceEventId,
          sourcePlatform: targetProvider === CalendarProvider.GOOGLE ? 'GOOGLE' : 'MICROSOFT',
        },
      });
      if (mirrorCheck && mirrorCheck.syncFingerprint === fingerprint) {
        syncLogger.info({ userId, sourceEventId }, '🔄 LOOP PREVENTED — mirror fingerprint match');
        return;
      }
    }
  }

  // 3. Generate idempotency key
  const version = existingEvent ? existingEvent.syncVersion + 1 : 1;
  const isCancelled = rawEvent.status === 'cancelled' || rawEvent['@removed'];
  const action = isCancelled ? 'delete' : (existingEvent ? 'update' : 'create');
  const idempotencyKey = generateIdempotencyKey(sourceProvider, sourceEventId, action, version);

  // Check idempotency
  const existingTransaction = await db.syncTransaction.findUnique({
    where: { transactionId: idempotencyKey },
  });
  if (existingTransaction) {
    syncLogger.info({ userId, sourceEventId, action }, 'Idempotency: already processed, skipping');
    return;
  }

  // 4. Handle deletion
  if (isCancelled) {
    await handleEventDeletion(userId, calendar, existingEvent, targetProvider, idempotencyKey);
    return;
  }

  // 5. Get target calendar
  const targetCalendar = await db.calendar.findFirst({
    where: {
      userId,
      provider: targetProvider === CalendarProvider.GOOGLE ? 'GOOGLE' : 'MICROSOFT',
      isPrimary: true,
      syncEnabled: true,
    },
  });

  if (!targetCalendar) {
    syncLogger.warn({ userId, targetProvider }, 'No target calendar found for sync');
    return;
  }

  // 6. CONFLICT CHECK — check both calendars before syncing
  const conflictResult = await checkForConflicts(
    userId,
    normalizedEvent.startTime!,
    normalizedEvent.endTime!,
    existingEvent?.id
  );

  if (conflictResult.hasConflict && conflictResult.recommendation === 'auto_reject') {
    syncLogger.info({ userId, sourceEventId, conflicts: conflictResult.conflicts.length }, 'Conflict detected — auto-rejecting');
    await handleAutoRejection(userId, normalizedEvent as any, conflictResult, calendar, idempotencyKey);
    return;
  }

  // 7. Create or update mirror event on target platform
  let mirrorEventId: string | null = null;

  if (action === 'create') {
    mirrorEventId = await createMirrorEvent(userId, targetCalendar, normalizedEvent as CanonicalEvent, targetProvider, fingerprint);
  } else if (action === 'update' && existingEvent?.mirrorEventId) {
    mirrorEventId = await updateMirrorEvent(userId, targetCalendar, existingEvent.mirrorEventId, normalizedEvent as CanonicalEvent, targetProvider, fingerprint);
  }

  // 8. Upsert the canonical event in our database
  const globalEventUuid = existingEvent?.globalEventUuid || `csync-${uuidv4()}`;
  const eventData = {
    calendarId: calendar.id,
    globalEventUuid,
    sourcePlatform: sourceProvider === CalendarProvider.GOOGLE ? 'GOOGLE' as const : 'MICROSOFT' as const,
    sourceEventId,
    mirrorEventId,
    mirrorPlatform: mirrorEventId ? (targetProvider === CalendarProvider.GOOGLE ? 'GOOGLE' as const : 'MICROSOFT' as const) : null,
    syncFingerprint: fingerprint,
    idempotencyKey,
    syncVersion: version,
    title: encrypt(normalizedEvent.title || ''),
    description: encrypt(normalizedEvent.description || ''),
    startTime: normalizedEvent.startTime!,
    endTime: normalizedEvent.endTime!,
    timezone: normalizedEvent.timezone || 'UTC',
    isAllDay: normalizedEvent.isAllDay || false,
    location: normalizedEvent.location || '',
    status: mapStatusToEnum(normalizedEvent.status),
    visibility: mapVisibilityToEnum(normalizedEvent.visibility),
    showAs: mapShowAsToEnum(normalizedEvent.showAs),
    organizerEmail: normalizedEvent.organizerEmail || '',
    organizerName: normalizedEvent.organizerName || '',
    isOrganizer: normalizedEvent.isOrganizer || false,
    attendees: JSON.stringify(normalizedEvent.attendees || []),
    recurrenceRule: (normalizedEvent.recurrenceRule as any) || undefined,
    meetingLink: normalizedEvent.meetingLink || '',
    syncState: mirrorEventId ? 'SYNCED' as const : 'PENDING' as const,
    conflictState: conflictResult.hasConflict ? 'DETECTED' as const : 'NONE' as const,
    originPlatform: sourceProvider === CalendarProvider.GOOGLE ? 'GOOGLE' as const : 'MICROSOFT' as const,
    lastModifiedAt: normalizedEvent.lastModifiedAt || new Date(),
    lastModifiedBy: normalizedEvent.organizerEmail || 'system',
    etag: normalizedEvent.etag || '',
  };

  if (existingEvent) {
    await db.event.update({ where: { id: existingEvent.id }, data: eventData });
  } else {
    await db.event.create({ data: eventData });
  }

  // 9. Record sync transaction
  const direction = sourceProvider === CalendarProvider.GOOGLE ? 'GOOGLE_TO_OUTLOOK' : 'OUTLOOK_TO_GOOGLE';
  await db.syncTransaction.create({
    data: {
      eventId: existingEvent?.id || (await db.event.findUnique({ where: { idempotencyKey } }))!.id,
      transactionId: idempotencyKey,
      direction: direction as any,
      action: action.toUpperCase() as any,
      status: mirrorEventId ? 'COMPLETED' : 'FAILED',
      sourceEventId,
      targetEventId: mirrorEventId,
      sourcePayload: normalizedEvent as any,
    },
  });

  // 10. Audit log
  await logAuditEvent({
    userId,
    action: action === 'create' ? AuditAction.EVENT_CREATED : AuditAction.EVENT_UPDATED,
    resourceType: AuditResourceType.EVENT,
    resourceId: globalEventUuid,
    newValue: { sourceProvider, action, mirrorEventId },
    source: AuditSource.WEBHOOK,
  });

  syncLogger.info(
    { userId, sourceEventId, mirrorEventId, action, direction },
    `✅ Sync ${action} completed`
  );
}

// ---- Helper Functions ----

async function createMirrorEvent(
  userId: string,
  targetCalendar: any,
  event: CanonicalEvent,
  targetProvider: CalendarProvider,
  fingerprint: string
): Promise<string | null> {
  try {
    if (targetProvider === CalendarProvider.GOOGLE) {
      const created = await createGoogleEvent(userId, targetCalendar.externalCalendarId, event);
      return created.id || null;
    } else {
      const created = await createMicrosoftEvent(userId, targetCalendar.externalCalendarId, event);
      return created.id || null;
    }
  } catch (error) {
    syncLogger.error({ userId, error }, 'Failed to create mirror event');
    return null;
  }
}

async function updateMirrorEvent(
  userId: string,
  targetCalendar: any,
  mirrorEventId: string,
  event: CanonicalEvent,
  targetProvider: CalendarProvider,
  fingerprint: string
): Promise<string | null> {
  try {
    if (targetProvider === CalendarProvider.GOOGLE) {
      await updateGoogleEvent(userId, targetCalendar.externalCalendarId, mirrorEventId, event);
    } else {
      await updateMicrosoftEvent(userId, mirrorEventId, event);
    }
    return mirrorEventId;
  } catch (error) {
    syncLogger.error({ userId, mirrorEventId, error }, 'Failed to update mirror event');
    return null;
  }
}

async function handleEventDeletion(
  userId: string,
  calendar: any,
  existingEvent: any,
  targetProvider: CalendarProvider,
  idempotencyKey: string
): Promise<void> {
  if (!existingEvent?.mirrorEventId) return;

  const db = getDatabase();
  try {
    if (targetProvider === CalendarProvider.GOOGLE) {
      const targetCal = await db.calendar.findFirst({
        where: { userId, provider: 'GOOGLE', isPrimary: true },
      });
      if (targetCal) await deleteGoogleEvent(userId, targetCal.externalCalendarId, existingEvent.mirrorEventId);
    } else {
      await deleteMicrosoftEvent(userId, existingEvent.mirrorEventId);
    }

    await db.event.update({
      where: { id: existingEvent.id },
      data: { status: 'CANCELLED', syncState: 'SYNCED' },
    });

    syncLogger.info({ userId, eventId: existingEvent.id }, '🗑️ Event deleted on both platforms');
  } catch (error) {
    syncLogger.error({ userId, error }, 'Failed to delete mirror event');
  }
}

// ---- Enum Mappers ----
function mapStatusToEnum(status: any): 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' {
  if (typeof status === 'string') {
    const upper = status.toUpperCase();
    if (upper === 'CONFIRMED' || upper === 'TENTATIVE' || upper === 'CANCELLED') return upper as any;
  }
  return 'CONFIRMED';
}

function mapVisibilityToEnum(vis: any): 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL' | 'DEFAULT' {
  if (typeof vis === 'string') {
    const upper = vis.toUpperCase();
    if (['PUBLIC', 'PRIVATE', 'CONFIDENTIAL', 'DEFAULT'].includes(upper)) return upper as any;
  }
  return 'DEFAULT';
}

function mapShowAsToEnum(showAs: any): 'FREE' | 'BUSY' | 'TENTATIVE' | 'OOF' | 'WORKING_ELSEWHERE' | 'UNKNOWN' {
  if (typeof showAs === 'string') {
    const upper = showAs.toUpperCase();
    if (['FREE', 'BUSY', 'TENTATIVE', 'OOF', 'WORKING_ELSEWHERE', 'UNKNOWN'].includes(upper)) return upper as any;
  }
  return 'BUSY';
}
