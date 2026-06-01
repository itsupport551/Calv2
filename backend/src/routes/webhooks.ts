// ============================================================
// Enterprise Calendar Sync — Webhook Routes
// ============================================================
// Receives and validates webhooks from Google & Microsoft.
// Queues events for processing by the sync engine.
// ============================================================

import { Router, Request, Response } from 'express';
import getDatabase from '../database/client';
import { webhookLogger } from '../utils/logger';
import { logAuditEvent } from '../audit/logger';
import { processSyncWebhook } from '../sync/orchestrator';
import { secureCompare, generateSecureToken } from '../crypto/encryption';
import { AuditAction, AuditResourceType, AuditSource, CalendarProvider } from '../types';

const router = Router();

/**
 * Google Calendar webhook endpoint.
 * Google sends POST notifications when calendar events change.
 */
router.post('/google', async (req: Request, res: Response) => {
  // Always respond 200 immediately — Google requires fast response
  res.status(200).send('OK');

  try {
    const channelId = req.headers['x-goog-channel-id'] as string;
    const resourceId = req.headers['x-goog-resource-id'] as string;
    const resourceState = req.headers['x-goog-resource-state'] as string;
    const channelToken = req.headers['x-goog-channel-token'] as string;

    if (!channelId || !resourceId) {
      webhookLogger.warn('Google webhook missing required headers');
      return;
    }

    // Ignore sync/verification notifications
    if (resourceState === 'sync') {
      webhookLogger.debug({ channelId }, 'Google webhook sync verification received');
      return;
    }

    webhookLogger.info({ channelId, resourceId, resourceState }, 'Google webhook received');

    // Look up the webhook subscription to find the calendar
    const db = getDatabase();
    const subscription = await db.webhookSubscription.findUnique({
      where: { channelId },
      include: { calendar: true },
    });

    if (!subscription) {
      // Common after a reconnect: user got a new channel id, but Google
      // keeps firing the old channel until it expires (7 days). Not an
      // error; logged at debug so it doesn't spam the deploy logs every
      // 30 seconds for a week.
      webhookLogger.debug({ channelId }, 'Webhook for unknown Google channel — discarding (stale)');
      return;
    }

    // Verify token matches userId (prevents spoofed webhooks)
    // Must reject if token is missing OR mismatched — not just mismatched
    if (!channelToken || channelToken !== subscription.calendar.userId) {
      webhookLogger.warn({ channelId }, 'Google webhook token mismatch — potential spoofing');
      return;
    }

    await logAuditEvent({
      userId: subscription.calendar.userId,
      action: AuditAction.WEBHOOK_RECEIVED,
      resourceType: AuditResourceType.WEBHOOK,
      resourceId: channelId,
      newValue: { provider: 'google', resourceState },
      source: AuditSource.WEBHOOK,
    });

    // Process sync asynchronously
    processSyncWebhook(
      subscription.calendar.userId,
      subscription.calendar.id,
      CalendarProvider.GOOGLE
    ).catch(error => {
      webhookLogger.error({ error, channelId }, 'Google sync processing failed');
    });

  } catch (error) {
    webhookLogger.error({ error }, 'Google webhook handler error');
  }
});

/**
 * Microsoft Graph webhook endpoint.
 * Handles both validation requests and change notifications.
 */
router.post('/microsoft', async (req: Request, res: Response) => {
  try {
    // Handle validation request (Microsoft sends this when creating subscription)
    const validationToken = req.query.validationToken as string;
    if (validationToken) {
      webhookLogger.info('Microsoft webhook validation request received');
      res.status(200).contentType('text/plain').send(validationToken);
      return;
    }

    // Respond 202 immediately — Microsoft requires fast response
    res.status(202).send('Accepted');

    const notifications = req.body?.value;
    if (!Array.isArray(notifications) || notifications.length === 0) {
      webhookLogger.warn('Microsoft webhook with no notifications');
      return;
    }

    const db = getDatabase();

    for (const notification of notifications) {
      const subscriptionId = notification.subscriptionId;
      const changeType = notification.changeType;
      const clientState = notification.clientState;

      webhookLogger.info({ subscriptionId, changeType }, 'Microsoft webhook received');

      // Look up subscription
      const subscription = await db.webhookSubscription.findFirst({
        where: {
          provider: 'MICROSOFT',
          channelId: subscriptionId, // We store subscriptionId as channelId
        },
        include: { calendar: true },
      });

      if (!subscription) {
        // Common after a reconnect/disconnect — MS keeps firing the old
        // subscription for up to 3 days. Not an error.
        webhookLogger.debug({ subscriptionId }, 'Webhook for unknown Microsoft subscription — discarding (stale)');
        continue;
      }

      // Verify client state (prevents spoofed webhooks)
      if (clientState && subscription.clientState && clientState !== subscription.clientState) {
        webhookLogger.warn({ subscriptionId }, 'Microsoft webhook clientState mismatch — potential spoofing');
        continue;
      }

      await logAuditEvent({
        userId: subscription.calendar.userId,
        action: AuditAction.WEBHOOK_RECEIVED,
        resourceType: AuditResourceType.WEBHOOK,
        resourceId: subscriptionId,
        newValue: { provider: 'microsoft', changeType },
        source: AuditSource.WEBHOOK,
      });

      // Process sync asynchronously
      processSyncWebhook(
        subscription.calendar.userId,
        subscription.calendar.id,
        CalendarProvider.MICROSOFT
      ).catch(error => {
        webhookLogger.error({ error, subscriptionId }, 'Microsoft sync processing failed');
      });
    }
  } catch (error) {
    webhookLogger.error({ error }, 'Microsoft webhook handler error');
    if (!res.headersSent) res.status(200).send('OK');
  }
});

export default router;
