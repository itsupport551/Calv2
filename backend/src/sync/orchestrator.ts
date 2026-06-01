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

    // 1a. SOURCE-side connection guard. Listing events on the source
    // provider needs that provider's tokens. If the user has since
    // disconnected this provider (but a stale webhook is still firing —
    // Google channels live 7d, MS subscriptions 3d), just skip cleanly
    // instead of throwing "Google account not connected" and retrying
    // five times. This silently drops what we couldn't have synced
    // anyway.
    const u = calendar.user as any;
    const sourceConnected =
      provider === CalendarProvider.GOOGLE
        ? !!(u?.googleConnected && u?.googleAccessToken)
        : !!(u?.microsoftConnected && u?.microsoftAccessToken);
    if (!sourceConnected) {
      syncLogger.info(
        { userId, provider, calendarId },
        'Source provider not connected — skipping (likely a stale webhook for a now-disconnected account)',
      );
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
        const err = error instanceof Error
          ? { errMessage: error.message, errStack: error.stack, errName: error.name }
          : { error };
        syncLogger.error({ userId, eventId: rawEvent.id, ...err }, 'Failed to process event');
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
  const sourcePlatformLit = sourceProvider === CalendarProvider.GOOGLE ? 'GOOGLE' as const : 'MICROSOFT' as const;

  // 2. LOOP PREVENTION + MIRROR RECOGNITION
  //
  // The webhook can arrive for one of three rows:
  //  (a) An event that originated in this provider (we have a row keyed
  //      by sourcePlatform + sourceEventId).
  //  (b) An event WE created in this provider as a mirror of an event
  //      that originated in the other side. There's no row keyed by
  //      (this-provider, sourceEventId) for it — instead the OTHER
  //      side's row has mirrorEventId = sourceEventId.
  //  (c) Nothing yet — truly new external event.
  //
  // Without case (b), Outlook's first webhook after we create a mirror
  // would look like "new event from Outlook" and trigger another mirror
  // back to Google → infinite loop. And a user deleting the mirror Y
  // in Outlook would look like "unknown event was cancelled" → the
  // original X in Google would survive.
  const fingerprint = generateSyncFingerprint(normalizedEvent);

  let existingEvent = await db.event.findFirst({
    where: {
      calendarId: calendar.id,
      sourceEventId,
      sourcePlatform: sourcePlatformLit,
    },
  });

  // Case (b): this event IS our mirror — find the row on the other side
  // whose mirrorEventId is what arrived as sourceEventId here.
  let isMirrorOfRow: typeof existingEvent | null = null;
  if (!existingEvent) {
    isMirrorOfRow = await db.event.findFirst({
      where: {
        mirrorEventId: sourceEventId,
        mirrorPlatform: sourcePlatformLit,
      },
    });
    if (isMirrorOfRow) {
      // First webhook after we created the mirror, or any update/delete
      // that happened on the mirror side. Treat it as a change on the
      // ORIGIN row.
      existingEvent = isMirrorOfRow;
    }
  }

  if (existingEvent) {
    // Loop prevention: same content as our last write → skip.
    if (isSyncLoop(fingerprint, existingEvent.syncFingerprint)) {
      syncLogger.info(
        { userId, sourceEventId, provider: sourceProvider, viaMirror: !!isMirrorOfRow },
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
    await handleEventDeletion(userId, existingEvent, sourcePlatformLit);
    return;
  }

  // 4a. Handle mirror-side edit. If the incoming webhook is for our
  // mirror (isMirrorOfRow), propagate the edited content back to the
  // SOURCE side so the canonical event reflects the user's change. We
  // can't flip the row's identity (sourcePlatform/sourceEventId) so we
  // re-use the existingEvent row, just refreshing its content fields.
  if (isMirrorOfRow && existingEvent && existingEvent.sourceEventId && existingEvent.sourcePlatform) {
    try {
      const sourceCal = await db.calendar.findFirst({
        where: { userId, provider: existingEvent.sourcePlatform, isPrimary: true },
      });
      if (sourceCal) {
        if (existingEvent.sourcePlatform === 'GOOGLE') {
          await updateGoogleEvent(
            userId, sourceCal.externalCalendarId, existingEvent.sourceEventId,
            normalizedEvent as CanonicalEvent,
          );
        } else {
          await updateMicrosoftEvent(
            userId, existingEvent.sourceEventId, normalizedEvent as CanonicalEvent,
          );
        }
      }
    } catch (err) {
      syncLogger.error({ userId, err: (err as Error).message }, 'Mirror-side edit propagation failed');
    }
    // Refresh local row's content (but NOT identity) and bump fingerprint
    // so the source-side webhook that will fire next sees a match and skips.
    await db.event.update({
      where: { id: existingEvent.id },
      data: {
        title: encrypt(normalizedEvent.title || ''),
        description: encrypt(normalizedEvent.description || ''),
        location: encrypt(normalizedEvent.location || ''),
        startTime: normalizedEvent.startTime!,
        endTime: normalizedEvent.endTime!,
        syncFingerprint: fingerprint,
        lastModifiedAt: new Date(),
      },
    });
    syncLogger.info({ userId, sourceEventId, propagatedTo: existingEvent.sourcePlatform }, '↩️  Mirror edit propagated back to source');
    return;
  }

  // 5. Get target calendar — but first short-circuit if the user has
  // disconnected that provider. Without this we hammer the (now-empty)
  // OAuth client and fail with "Google account not connected" /
  // equivalent for MS, retry 5×, fail loudly. Disconnecting one
  // provider is a totally normal state and should NOT cause sync
  // errors when the other provider continues to fire webhooks.
  const userConn = await db.user.findUnique({
    where: { id: userId },
    select: { googleConnected: true, microsoftConnected: true },
  });
  const targetConnected =
    targetProvider === CalendarProvider.GOOGLE
      ? !!userConn?.googleConnected
      : !!userConn?.microsoftConnected;

  if (!targetConnected) {
    syncLogger.info(
      { userId, targetProvider },
      'Target provider not connected — recording locally without mirror',
    );
    // Save the event locally so the dashboard can still show it, but
    // skip mirror creation. Set syncState=SKIPPED so the row tells the
    // truth about its state.
    await saveOrUpdateWithoutMirror(
      userId,
      calendar,
      normalizedEvent,
      sourcePlatformLit,
      fingerprint,
      idempotencyKey,
      version,
      existingEvent,
    );
    return;
  }

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
    // Same treatment: record locally, no mirror.
    await saveOrUpdateWithoutMirror(
      userId,
      calendar,
      normalizedEvent,
      sourcePlatformLit,
      fingerprint,
      idempotencyKey,
      version,
      existingEvent,
    );
    return;
  }

  // 6. CONFLICT CHECK — check both calendars before syncing
  const conflictResult = await checkForConflicts(
    userId,
    normalizedEvent.startTime!,
    normalizedEvent.endTime!,
    existingEvent?.id
  );

  // Idempotency for auto-reject: if we already auto-rejected this event
  // in a previous webhook (status=CANCELLED + conflictState=RESOLVED on
  // the existing row), short-circuit. Without this, the PATCH we send
  // to decline the invite fires another webhook → we'd auto-reject again
  // (and queue another rejection email) on every loop iteration before
  // Google's idempotent PATCH finally damps it.
  if (existingEvent
      && existingEvent.status === 'CANCELLED'
      && existingEvent.conflictState === 'RESOLVED') {
    syncLogger.info({ userId, sourceEventId }, '↩️  Event already auto-rejected — skipping re-process');
    return;
  }

  if (conflictResult.hasConflict && conflictResult.recommendation === 'auto_reject') {
    syncLogger.info({ userId, sourceEventId, conflicts: conflictResult.conflicts.length }, 'Conflict detected — auto-rejecting');
    await handleAutoRejection(userId, normalizedEvent as any, conflictResult, calendar, idempotencyKey);

    // Persist a marker row so the post-decline webhook (Google/MS fires
    // one because the PATCH changed the event) sees existingEvent with
    // status=CANCELLED + conflictState=RESOLVED and short-circuits via
    // the check above.
    const markerGuid = existingEvent?.globalEventUuid || `csync-${uuidv4()}`;
    const markerData = {
      calendarId: calendar.id,
      globalEventUuid: markerGuid,
      sourcePlatform: sourcePlatformLit,
      sourceEventId,
      syncFingerprint: fingerprint,
      idempotencyKey,
      syncVersion: version,
      title: encrypt(normalizedEvent.title || ''),
      description: encrypt(normalizedEvent.description || ''),
      startTime: normalizedEvent.startTime!,
      endTime: normalizedEvent.endTime!,
      timezone: normalizedEvent.timezone || 'UTC',
      isAllDay: normalizedEvent.isAllDay || false,
      location: encrypt(normalizedEvent.location || ''),
      status: 'CANCELLED' as const,
      conflictState: 'RESOLVED' as const,
      visibility: mapVisibilityToEnum(normalizedEvent.visibility),
      showAs: mapShowAsToEnum(normalizedEvent.showAs),
      organizerEmail: normalizedEvent.organizerEmail || '',
      organizerName: normalizedEvent.organizerName || '',
      isOrganizer: normalizedEvent.isOrganizer || false,
      attendees: JSON.stringify(normalizedEvent.attendees || []),
      meetingLink: normalizedEvent.meetingLink || '',
      syncState: 'SKIPPED' as const,
      originPlatform: sourcePlatformLit,
      lastModifiedAt: normalizedEvent.lastModifiedAt || new Date(),
      lastModifiedBy: normalizedEvent.organizerEmail || 'system',
      etag: normalizedEvent.etag || '',
    };
    if (existingEvent) {
      await db.event.update({ where: { id: existingEvent.id }, data: markerData });
    } else {
      await db.event.create({ data: markerData });
    }
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

/**
 * Upsert the canonical event row WITHOUT attempting to create or update
 * a mirror on the other provider. Used when the user is disconnected
 * from the target provider — we still want the dashboard to show the
 * event locally, just flagged with syncState=SKIPPED.
 */
async function saveOrUpdateWithoutMirror(
  userId: string,
  calendar: any,
  normalizedEvent: any,
  sourcePlatform: 'GOOGLE' | 'MICROSOFT',
  fingerprint: string,
  idempotencyKey: string,
  version: number,
  existingEvent: any,
): Promise<void> {
  const db = getDatabase();
  const globalEventUuid = existingEvent?.globalEventUuid || `csync-${uuidv4()}`;
  const baseData = {
    calendarId: calendar.id,
    globalEventUuid,
    sourcePlatform,
    sourceEventId: normalizedEvent.sourceEventId!,
    syncFingerprint: fingerprint,
    idempotencyKey,
    syncVersion: version,
    title: encrypt(normalizedEvent.title || ''),
    description: encrypt(normalizedEvent.description || ''),
    startTime: normalizedEvent.startTime!,
    endTime: normalizedEvent.endTime!,
    timezone: normalizedEvent.timezone || 'UTC',
    isAllDay: normalizedEvent.isAllDay || false,
    location: encrypt(normalizedEvent.location || ''),
    status: mapStatusToEnum(normalizedEvent.status),
    visibility: mapVisibilityToEnum(normalizedEvent.visibility),
    showAs: mapShowAsToEnum(normalizedEvent.showAs),
    organizerEmail: normalizedEvent.organizerEmail || '',
    organizerName: normalizedEvent.organizerName || '',
    isOrganizer: normalizedEvent.isOrganizer || false,
    attendees: JSON.stringify(normalizedEvent.attendees || []),
    meetingLink: normalizedEvent.meetingLink || '',
    syncState: 'SKIPPED' as const,
    originPlatform: sourcePlatform,
    lastModifiedAt: normalizedEvent.lastModifiedAt || new Date(),
    lastModifiedBy: normalizedEvent.organizerEmail || 'system',
    etag: normalizedEvent.etag || '',
  };

  if (existingEvent) {
    await db.event.update({ where: { id: existingEvent.id }, data: baseData });
  } else {
    await db.event.create({ data: baseData });
  }
  syncLogger.info({ userId, sourceEventId: normalizedEvent.sourceEventId }, 'Saved event locally without mirror');
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
  existingEvent: any,
  deleteOriginatedOn: 'GOOGLE' | 'MICROSOFT',
): Promise<void> {
  if (!existingEvent) return;

  const db = getDatabase();
  const sourceSideWasDeleted = existingEvent.sourcePlatform === deleteOriginatedOn;

  try {
    if (sourceSideWasDeleted) {
      // The origin row's source event was deleted by the user — propagate
      // the delete to the mirror in the OTHER provider.
      if (existingEvent.mirrorEventId && existingEvent.mirrorPlatform) {
        if (existingEvent.mirrorPlatform === 'GOOGLE') {
          const targetCal = await db.calendar.findFirst({
            where: { userId, provider: 'GOOGLE', isPrimary: true },
          });
          if (targetCal) {
            await deleteGoogleEvent(
              userId, targetCal.externalCalendarId, existingEvent.mirrorEventId,
            );
          }
        } else {
          await deleteMicrosoftEvent(userId, existingEvent.mirrorEventId);
        }
      }
    } else {
      // The MIRROR side was deleted by the user — propagate by deleting
      // the SOURCE event on its original provider (existingEvent.sourceEventId
      // on existingEvent.sourcePlatform).
      if (existingEvent.sourceEventId && existingEvent.sourcePlatform) {
        if (existingEvent.sourcePlatform === 'GOOGLE') {
          const sourceCal = await db.calendar.findFirst({
            where: { userId, provider: 'GOOGLE', isPrimary: true },
          });
          if (sourceCal) {
            await deleteGoogleEvent(
              userId, sourceCal.externalCalendarId, existingEvent.sourceEventId,
            );
          }
        } else {
          await deleteMicrosoftEvent(userId, existingEvent.sourceEventId);
        }
      }
    }

    // Remove our row entirely so the next webhook won't try to re-process it.
    await db.event.delete({ where: { id: existingEvent.id } });

    syncLogger.info(
      { userId, eventId: existingEvent.id, deleteOriginatedOn, sourceSideWasDeleted },
      '🗑️ Event deleted on both platforms',
    );
  } catch (error) {
    // Best-effort: even if the cross-provider delete fails (already gone,
    // permission revoked, etc.), drop our local row so it doesn't keep
    // showing up. The other side can be cleaned up manually or by the
    // next sync.
    syncLogger.error(
      { userId, err: (error as Error).message, stack: (error as Error).stack },
      'Failed to delete cross-platform mirror — removing local row anyway',
    );
    await db.event.delete({ where: { id: existingEvent.id } }).catch(() => {});
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
