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

  const event: ActionExecutedEvent = {
    topic: 'action.executed',
    timestamp: new Date().toISOString(),
    tenantId,
    actionId,
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
