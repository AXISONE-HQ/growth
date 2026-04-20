/**
 * SendGrid Event Webhook processor.
 *
 * SendGrid batches up to 1000 events per POST. Each event has:
 *   event: delivered | open | click | bounce | dropped | deferred |
 *          spamreport | unsubscribe | group_unsubscribe | group_resubscribe | processed
 *   email, timestamp, sg_event_id, sg_message_id, ...
 *
 * Flow per event:
 *   1. Classify via errors.ts (transient vs permanent + side effect)
 *   2. On suppress_contact side effect → add to suppression cache
 *   3. Publish action.executed with final status
 *   4. Track spam rate for alerting (KAN-601)
 *
 * KAN-503, KAN-600, KAN-601
 */

import type { ActionExecutedEvent } from '@growth/connector-contracts';
import { publishEvent } from '../../pubsub/index.js';
import { logger } from '../../logger.js';
import { classifySendGridEvent } from './errors.js';
import { suppress, unsuppress } from './suppressions.js';

interface RawSendGridEvent {
  event: string;
  email: string;
  timestamp: number;
  sg_event_id: string;
  sg_message_id: string;
  reason?: string;
  status?: string;
  type?: string;
  // Custom args we pass through on send (for correlation)
  actionId?: string;
  tenantId?: string;
  connectionId?: string;
}

/** Spam rate threshold that triggers a PagerDuty alert (0.1%). */
const SPAM_RATE_ALERT_THRESHOLD = 0.001;

export async function processSendGridEvents(events: RawSendGridEvent[]): Promise<void> {
  let spamCount = 0;
  let totalCount = 0;

  for (const e of events) {
    totalCount += 1;
    if (e.event === 'spamreport') spamCount += 1;

    try {
      await processOne(e);
    } catch (err) {
      logger.error({ err, sgEventId: e.sg_event_id }, 'sendgrid event processing failed');
    }
  }

  // Rate-limited spam alert (KAN-601)
  if (totalCount > 0 && spamCount / totalCount > SPAM_RATE_ALERT_THRESHOLD) {
    logger.error(
      { spamCount, totalCount, rate: spamCount / totalCount },
      'SPAM RATE ALERT — throttle tenant and investigate',
    );
    // TODO(KAN-601): publish dedicated alert event for PagerDuty integration
  }
}

async function processOne(e: RawSendGridEvent): Promise<void> {
  const cls = classifySendGridEvent({
    event: e.event,
    reason: e.reason,
    status: e.status,
    type: e.type,
  });

  // Apply suppression side-effects first
  if (cls.sideEffect === 'suppress_contact' && e.tenantId) {
    const reason: 'bounce' | 'spam' | 'unsubscribe' =
      e.event === 'spamreport' ? 'spam' : e.event.includes('unsubscribe') ? 'unsubscribe' : 'bounce';
    await suppress(e.tenantId, e.email, reason);
  }
  if (e.event === 'group_resubscribe' && e.tenantId) {
    await unsuppress(e.tenantId, e.email);
  }

  // Only terminal events result in action.executed updates
  const statusMap: Record<string, ActionExecutedEvent['status'] | null> = {
    delivered: 'delivered',
    bounce: 'failed',
    dropped: 'failed',
    spamreport: 'failed',
    unsubscribe: 'suppressed',
    group_unsubscribe: 'suppressed',
    deferred: null,
    open: null,
    click: null,
    processed: null,
  };

  const status = statusMap[e.event];
  if (!status) return;

  if (!e.actionId || !e.tenantId || !e.connectionId) {
    // Event can't be correlated back to an action — still useful for engagement
    // analytics downstream, but doesn't update action status.
    return;
  }

  await publishEvent({
    topic: 'action.executed',
    timestamp: new Date(e.timestamp * 1000).toISOString(),
    tenantId: e.tenantId,
    actionId: e.actionId,
    connectionId: e.connectionId,
    channel: 'EMAIL',
    provider: 'sendgrid',
    status,
    providerMessageId: e.sg_message_id,
    errorClass: cls.errorClass,
    errorMessage: e.reason ?? cls.description,
    attemptNumber: 1,
  });
}
