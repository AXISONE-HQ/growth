/**
 * Twilio Messaging Service — the per-tenant pool that numbers attach to.
 *
 * Every tenant gets exactly one Messaging Service on their subaccount.
 * Numbers are attached to the service; the A2P campaign is attached to
 * the service. Sending always goes through the Messaging Service SID,
 * not raw phone numbers — this gives us number pooling, sticky sender,
 * and automatic failover at scale.
 *
 * KAN-567: Create Messaging Service on subaccount
 */

import type Twilio from 'twilio';
import { logger } from '../../logger.js';

interface CreateMessagingServiceInput {
  tenantSlug: string;
  inboundWebhookUrl: string;
  statusCallbackUrl: string;
}

export async function createMessagingService(
  client: Twilio.Twilio,
  input: CreateMessagingServiceInput,
): Promise<string> {
  // Idempotency: check for existing service with this friendlyName
  const existing = await client.messaging.v1.services.list({ limit: 20 });
  const match = existing.find((s) => s.friendlyName === `growth-${input.tenantSlug}`);
  if (match) {
    logger.info({ sid: match.sid, slug: input.tenantSlug }, 'reusing existing Messaging Service');
    return match.sid;
  }

  const service = await client.messaging.v1.services.create({
    friendlyName: `growth-${input.tenantSlug}`,
    inboundRequestUrl: input.inboundWebhookUrl,
    statusCallback: input.statusCallbackUrl,
    usecase: 'mixed', // MIXED allows both marketing + transactional
    useInboundWebhookOnNumber: false, // service-level webhooks, not per-number
    fallbackToLongCode: true,
    stickySender: true,
    smartEncoding: true,
  });

  logger.info({ sid: service.sid, slug: input.tenantSlug }, 'Messaging Service created');
  return service.sid;
}

/** Attach a purchased phone number to the tenant's Messaging Service. */
export async function attachNumberToService(
  client: Twilio.Twilio,
  messagingServiceSid: string,
  phoneSid: string,
): Promise<void> {
  await client.messaging.v1.services(messagingServiceSid).phoneNumbers.create({
    phoneNumberSid: phoneSid,
  });
  logger.info({ messagingServiceSid, phoneSid }, 'phone number attached to Messaging Service');
}
