/**
 * Twilio delivery status callback handler.
 *
 * Twilio hits /webhooks/twilio/status with the outcome of each message:
 *   MessageStatus ∈ {queued, sending, sent, delivered, failed, undelivered}
 *
 * Flow:
 *   1. Verify signature (done in webhook router)
 *   2. Parse form body
 *   3. Update the `actions` table via `action.executed` status update event
 *   4. On failure, apply side-effect (suppress contact, etc.) via errors.ts
 *
 * KAN-495: Twilio delivery status webhook handler
 * KAN-576: Status callback HMAC verification (verifier shared)
 * KAN-577: Update actions.status via MessageSid lookup
 */

import type { ActionExecutedEvent } from '@growth/connector-contracts';
import { publishEvent } from '../../pubsub/index.js';
import { logger } from '../../logger.js';
import { classifyTwilioError } from './errors.js';
import { markOptedOut } from './optout.js';

/** Map Twilio MessageStatus to our internal status. */
function mapStatus(s: string | undefined): ActionExecutedEvent['status'] {
  switch ((s ?? '').toLowerCase()) {
    case 'delivered':
      return 'delivered';
    case 'sent':
    case 'sending':
    case 'queued':
      return 'sent';
    case 'failed':
    case 'undelivered':
      return 'failed';
    default:
      return 'sent';
  }
}

/**
 * Process a single Twilio status callback. Form fields:
 *   MessageSid, MessageStatus, AccountSid, To, From, ErrorCode?, ErrorMessage?
 */
export async function processTwilioStatusCallback(
  params: Record<string, string>,
  tenantId: string,
  actionId: string,
  connectionId: string,
  // KAN-657: decisionId + contactId required so action.executed can correlate
  // back to a Decision row + Contact row. SMS path is currently deferred — when
  // the Twilio status callback handler is wired, the caller must supply both.
  // Optional here to avoid breaking existing callers; runtime drop below if missing.
  decisionId?: string,
  contactId?: string,
): Promise<void> {
  const status = mapStatus(params.MessageStatus);
  const errorCode = params.ErrorCode ? Number.parseInt(params.ErrorCode, 10) : undefined;
  const cls = errorCode ? classifyTwilioError(errorCode) : null;

  // Apply compliance-critical side effects before publishing
  if (cls?.sideEffect === 'suppress_contact' && params.To) {
    await markOptedOut(tenantId, params.To).catch((err) =>
      logger.error({ err }, 'failed to mark opt-out from status callback'),
    );
  }

  // TODO(KAN-684): SMS path is deferred. ActionExecutedEventSchema now requires
  // decisionId + contactId (KAN-657). Drop status callbacks that lack the
  // correlation IDs until the Twilio status-callback wiring threads them through.
  if (!decisionId || !contactId) {
    logger.info(
      { messageSid: params.MessageSid, status },
      'twilio status callback dropped — decisionId/contactId not threaded (KAN-684)',
    );
    return;
  }

  const event: ActionExecutedEvent = {
    topic: 'action.executed',
    timestamp: new Date().toISOString(),
    tenantId,
    actionId,
    decisionId,
    contactId,
    connectionId,
    channel: 'SMS',
    provider: 'twilio',
    status,
    providerMessageId: params.MessageSid,
    errorClass: cls?.errorClass,
    errorMessage: params.ErrorMessage ?? cls?.description,
    attemptNumber: 1,
  };

  await publishEvent(event);
  logger.info({ messageSid: params.MessageSid, status }, 'twilio status callback published');
}
