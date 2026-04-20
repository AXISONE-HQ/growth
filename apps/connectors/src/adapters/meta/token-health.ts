/**
 * Meta Page Access Token health check + refresh strategy.
 *
 * Key facts about Meta tokens:
 *   - Page tokens derived from a LONG-LIVED user token do NOT expire
 *   - BUT the user can revoke app access at any time from Facebook settings
 *   - User removing themselves as a Page admin also invalidates the token
 *   - Password change also invalidates
 *
 * So instead of "refresh on expiry", we:
 *   1. Daily health check per connection (introspect token)
 *   2. On failure → mark connection ERROR, publish connection.health.changed,
 *      email tenant with re-connect CTA
 *   3. Tenant clicks "Reconnect" → fresh OAuth flow, new Page token
 *
 * KAN-513, KAN-629, KAN-630, KAN-631
 */

import type { ChannelConnection } from '@growth/connector-contracts';
import { logger } from '../../logger.js';
import { publishEvent } from '../../pubsub/index.js';
import { graphFetch, loadPageToken, invalidateMetaClient } from './client.js';
import { classifyMetaError } from './errors.js';
import { MetaApiError } from './client.js';

/**
 * Introspect a Page Access Token by fetching /me on it.
 * If the token is revoked or Page admin access is lost, this fails with code 190.
 */
export async function checkTokenHealth(
  connection: ChannelConnection,
): Promise<{ healthy: boolean; reason?: string }> {
  try {
    const { pageAccessToken, pageId } = await loadPageToken(connection);
    const me = await graphFetch<{ id: string }>('/me', {
      method: 'GET',
      accessToken: pageAccessToken,
      params: { fields: 'id' },
    });
    if (me.id !== pageId) {
      return { healthy: false, reason: `Token identity mismatch: got ${me.id}, expected ${pageId}` };
    }
    return { healthy: true };
  } catch (err) {
    if (err instanceof MetaApiError) {
      const cls = classifyMetaError(err.code, err.subcode, err.httpStatus);
      return { healthy: false, reason: cls.description };
    }
    return { healthy: false, reason: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * Daily health-check loop across all Meta connections.
 * When a token goes bad we emit `connection.health.changed` and invalidate the cache.
 */
export async function runTokenHealthSweep(
  loadAllMeta: () => Promise<ChannelConnection[]>,
): Promise<{ checked: number; revoked: number }> {
  const connections = await loadAllMeta();
  let revoked = 0;

  for (const connection of connections) {
    const { healthy, reason } = await checkTokenHealth(connection);
    if (!healthy) {
      revoked += 1;
      invalidateMetaClient(connection);
      logger.warn({ connectionId: connection.id, reason }, 'Meta token revoked — marking connection ERROR');
      await publishEvent({
        topic: 'connection.health.changed',
        timestamp: new Date().toISOString(),
        tenantId: connection.tenantId,
        connectionId: connection.id,
        channel: 'MESSENGER',
        provider: 'meta',
        previousStatus: connection.status,
        newStatus: 'ERROR',
        reason: reason ?? 'Meta Page token revoked',
      });
      // TODO(KAN-558): update channel_connections.status via Prisma
    }
  }

  return { checked: connections.length, revoked };
}
