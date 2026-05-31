// ============================================================
// Enterprise Calendar Sync — Auto-Rejection Workflow
// ============================================================
// Automatically declines conflicting meeting invites and
// sends professional rejection emails.
// ============================================================

import getDatabase from '../database/client';
import { conflictLogger } from '../utils/logger';
import { logAuditEvent } from '../audit/logger';
import { queueNotification } from '../notifications/dispatcher';
import { CanonicalEvent, ConflictDetectionResult, AuditAction, AuditResourceType, AuditSource } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { declineGoogleEvent } from '../connectors/google/calendar';
import { declineMicrosoftEvent } from '../connectors/microsoft/calendar';

/**
 * Handle automatic rejection of a conflicting event.
 */
export async function handleAutoRejection(
  userId: string,
  event: Partial<CanonicalEvent>,
  conflictResult: ConflictDetectionResult,
  calendar: any,
  idempotencyKey: string
): Promise<void> {
  const db = getDatabase();

  try {
    // 1. Record conflict in database
    if (!conflictResult.conflicts.length) {
      conflictLogger.warn({ userId }, 'handleAutoRejection called with empty conflicts array — skipping');
      return;
    }
    const mainConflict = conflictResult.conflicts[0];

    // ConflictLog.eventId is a required FK to events(id). It must reference
    // a REAL row — passing a fresh uuidv4() (as the old code did when no
    // existingEvent id was available) violates the foreign key and 500s
    // the whole auto-rejection. So: only log when we have a real existing
    // event id, otherwise skip the DB row but still send the email + audit.
    const existingEventId =
      mainConflict.existingEvent?.eventId &&
      mainConflict.existingEvent.eventId !== 'incoming'
        ? mainConflict.existingEvent.eventId
        : null;

    if (existingEventId) {
      // Verify the id actually exists — fingerprint/OOF detectors can
      // produce synthetic ids that look like UUIDs but don't match a row.
      const exists = await db.event.findUnique({
        where: { id: existingEventId },
        select: { id: true },
      });
      if (exists) {
        await db.conflictLog.create({
          data: {
            eventId: existingEventId,
            userId,
            conflictType: mainConflict?.type?.toUpperCase() as any || 'TIME_OVERLAP',
            resolution: 'AUTO_REJECTED',
            conflictingEventData: {
              incomingTitle: event.title,
              incomingStart: event.startTime,
              incomingEnd: event.endTime,
              incomingOrganizer: event.organizerEmail,
              conflicts: conflictResult.conflicts.map(c => ({
                existingTitle: c.existingEvent.title,
                existingStart: c.existingEvent.startTime,
                existingEnd: c.existingEvent.endTime,
                overlapMinutes: c.overlapMinutes,
              })),
            },
            rejectionReason: buildRejectionReason(conflictResult),
            notificationSent: false,
          },
        });
      } else {
        conflictLogger.info({ userId, existingEventId }, 'Conflict existingEvent id not found in DB — skipping ConflictLog row');
      }
    }

    // 2. Queue rejection email
    await queueNotification({
      userId,
      type: 'rejection',
      channel: 'email',
      subject: `Meeting Declined: ${event.title || 'Untitled Event'}`,
      body: buildRejectionEmailBody(event, conflictResult),
      metadata: {
        eventTitle: event.title,
        organizerEmail: event.organizerEmail,
        startTime: event.startTime,
        endTime: event.endTime,
        conflictCount: conflictResult.conflicts.length,
        // Tell the email router which platform this event came from
        // so it can send the reply via the matching provider (Gmail / MS Graph)
        sourceProvider: calendar?.provider as 'GOOGLE' | 'MICROSOFT' | undefined,
      },
    });

    // 3. Actually decline the invite on the source provider.
    //    Only do this when the user is NOT the organizer (we don't
    //    auto-decline our own events) AND the event has an external id
    //    (a real provider-side event, not a synthetic conflict marker).
    if (!event.isOrganizer && event.sourceEventId && calendar?.externalCalendarId) {
      const reason = buildRejectionReason(conflictResult);
      try {
        if (calendar.provider === 'GOOGLE') {
          // Look up the user's email — we need it to identify ourselves
          // in the attendees list when declining.
          const me = await db.user.findUnique({
            where: { id: userId },
            select: { email: true },
          });
          if (me?.email) {
            await declineGoogleEvent(
              userId,
              calendar.externalCalendarId,
              event.sourceEventId,
              me.email,
            );
          }
        } else if (calendar.provider === 'MICROSOFT') {
          await declineMicrosoftEvent(userId, event.sourceEventId, reason);
        }
        conflictLogger.info(
          { userId, sourceEventId: event.sourceEventId, provider: calendar.provider },
          'Invite declined on source provider',
        );
      } catch (err) {
        // Don't fail the whole auto-rejection if the provider call errors —
        // the conflict log + email still go out so the user is informed.
        conflictLogger.error(
          { userId, sourceEventId: event.sourceEventId, err: (err as Error).message },
          'Failed to decline invite on source provider',
        );
      }
    }

    // 4. Audit log
    await logAuditEvent({
      userId,
      action: AuditAction.INVITE_AUTO_REJECTED,
      resourceType: AuditResourceType.EVENT,
      resourceId: event.sourceEventId || 'unknown',
      newValue: {
        title: event.title,
        organizer: event.organizerEmail,
        reason: buildRejectionReason(conflictResult),
        conflictCount: conflictResult.conflicts.length,
      },
      source: AuditSource.SYSTEM,
    });

    conflictLogger.info({
      userId,
      eventTitle: event.title,
      organizer: event.organizerEmail,
      conflicts: conflictResult.conflicts.length,
    }, '❌ Meeting auto-rejected due to conflict');

  } catch (error) {
    conflictLogger.error({ userId, error }, 'Failed to handle auto-rejection');
  }
}

function buildRejectionReason(result: ConflictDetectionResult): string {
  const conflict = result.conflicts[0];
  if (!conflict) return 'Schedule conflict detected';
  return `The requested meeting conflicts with an existing calendar commitment (${conflict.overlapMinutes} minutes overlap with "${conflict.existingEvent.title}")`;
}

function buildRejectionEmailBody(event: Partial<CanonicalEvent>, result: ConflictDetectionResult): string {
  const conflict = result.conflicts[0];
  const startStr = event.startTime ? new Date(event.startTime).toLocaleString() : 'Unknown';
  const endStr = event.endTime ? new Date(event.endTime).toLocaleString() : 'Unknown';

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 12px 12px 0 0; color: white;">
        <h2 style="margin: 0; font-size: 20px;">📅 Meeting Automatically Declined</h2>
      </div>
      <div style="background: #1a1a2e; color: #e0e0e0; padding: 24px; border-radius: 0 0 12px 12px;">
        <p style="color: #b0b0b0; margin-top: 0;">The following meeting request has been automatically declined by the scheduling system:</p>
        
        <div style="background: #16213e; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong style="color: #667eea;">Meeting:</strong> ${event.title || 'Untitled'}</p>
          <p style="margin: 4px 0;"><strong style="color: #667eea;">Time:</strong> ${startStr} — ${endStr}</p>
          <p style="margin: 4px 0;"><strong style="color: #667eea;">Organizer:</strong> ${event.organizerEmail || 'Unknown'}</p>
        </div>

        <div style="background: #2d1b35; border-left: 4px solid #e74c3c; padding: 12px; border-radius: 4px; margin: 16px 0;">
          <p style="margin: 0; color: #e74c3c;"><strong>Reason:</strong></p>
          <p style="margin: 8px 0 0 0; color: #d0d0d0;">
            The requested meeting conflicts with an existing calendar commitment
            ${conflict ? ` and has a ${conflict.overlapMinutes}-minute overlap` : ''}.
          </p>
        </div>

        <p style="color: #888; font-size: 12px; margin-top: 20px; border-top: 1px solid #333; padding-top: 12px;">
          This action was performed automatically by the Enterprise Calendar Sync system.
          Contact your administrator if you believe this was an error.
        </p>
      </div>
    </div>
  `;
}
