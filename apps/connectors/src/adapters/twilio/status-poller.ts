/**
 * 10DLC Brand + Campaign status poller.
 *
 * Runs as a Cloud Scheduler → Cloud Run job. Finds every tenant
 * connection with `complianceStatus.brandStatus` or
 * `complianceStatus.campaignStatus` in `{pending, in-review}` and
 * fetches the latest from Twilio. Transitions:
 *   pending/in-review → approved: unlock sending, update metadata, notify tenant
 *   pending/in-review → rejected: flag for tenant review
 *
 * KAN-571: 10DLC status poller + tenant notification
 */

import type { ChannelConnection } from '@growth/connector-contracts';
import { logger } from '../../logger.js';
import { publishEvent } from '../../pubsub/index.js';
import { getTwilioClient } from './client.js';
import {
  pollComplianceStatus,
  isSendable,
  type BrandAndCampaignState,
} from './compliance.js';

export async function pollAllTwilioConnections(
  loadPending: () => Promise<ChannelConnection[]>,
): Promise<{ polled: number; approved: number; rejected: number }> {
  const connections = await loadPending();
  let approved = 0;
  let rejected = 0;

  for (const connection of connections) {
    const compliance = connection.complianceStatus as BrandAndCampaignState | null;
    if (!compliance) continue;
    const messagingServiceSid = (connection.metadata?.messagingServiceSid as string | undefined) ?? null;
    if (!messagingServiceSid) continue;

    try {
      const client = await getTwilioClient(connection);
      const next = await pollComplianceStatus(client, compliance, messagingServiceSid);

      // No change — move on
      if (next.brandStatus === compliance.brandStatus && next.campaignStatus === compliance.campaignStatus) {
        continue;
      }

      // TODO(KAN-558): persist updated complianceStatus to channel_connections

      if (isSendable(next)) {
        approved += 1;
        await publishEvent({
          topic: 'connection.health.changed',
          timestamp: new Date().toISOString(),
          tenantId: connection.tenantId,
          connectionId: connection.id,
          channel: 'SMS',
          provider: 'twilio',
          previousStatus: 'PENDING',
          newStatus: 'ACTIVE',
          reason: '10DLC approved',
        });
      } else if (next.brandStatus === 'rejected' || next.campaignStatus === 'rejected') {
        rejected += 1;
        await publishEvent({
          topic: 'connection.health.changed',
          timestamp: new Date().toISOString(),
          tenantId: connection.tenantId,
          connectionId: connection.id,
          channel: 'SMS',
          provider: 'twilio',
          previousStatus: 'PENDING',
          newStatus: 'ERROR',
          reason: next.rejectionReason ?? '10DLC registration rejected',
        });
      }
    } catch (err) {
      logger.error({ err, connectionId: connection.id }, 'poll failed');
    }
  }

  return { polled: connections.length, approved, rejected };
}
