/**
 * Shared subdomain fallback — `reply.{tenantSlug}.growth.axisone.com`.
 *
 * For tenants without their own domain or without DNS access, we provision a
 * subdomain on our shared parent. DKIM/SPF/DMARC are pre-configured on
 * `growth.axisone.com` (one-time ops setup) — tenants inherit that
 * authentication.
 *
 * Trade-off: shared reputation. We apply more aggressive rate caps to
 * shared-subdomain senders so one bad actor can't sink the shared IP.
 *
 * KAN-602: One-time parent domain setup (ops)
 * KAN-603: Auto-provision per-tenant subdomain
 * KAN-604: Aggressive rate caps on shared subdomain
 */

import { getMasterSendGridClient } from './client.js';
import { logger } from '../../logger.js';

const SHARED_PARENT_DOMAIN = 'growth.axisone.com';

export interface SharedSubdomainOutput {
  domainId: number;
  subdomain: string;
  fromAddress: string;
}

export async function provisionSharedSubdomain(
  subuserUsername: string,
  tenantSlug: string,
): Promise<SharedSubdomainOutput> {
  const subdomain = `reply.${tenantSlug}.${SHARED_PARENT_DOMAIN}`;
  const client = await getMasterSendGridClient();
  const log = logger.child({ tenantSlug, subdomain });

  // Auth on a subdomain of our already-authenticated parent
  const [res] = await client.request({
    method: 'POST',
    url: '/v3/whitelabel/domains',
    headers: { 'On-Behalf-Of': subuserUsername },
    body: {
      domain: SHARED_PARENT_DOMAIN,
      subdomain: `reply.${tenantSlug}`,
      automatic_security: true,
      default: false, // tenant can swap to custom domain later
    },
  });
  const body = res.body as { id: number };

  // Validate immediately — DNS for growth.axisone.com is already in place
  await client.request({
    method: 'POST',
    url: `/v3/whitelabel/domains/${body.id}/validate`,
    headers: { 'On-Behalf-Of': subuserUsername },
  });

  log.info({ domainId: body.id }, 'shared subdomain provisioned');

  return {
    domainId: body.id,
    subdomain,
    fromAddress: `hi@${subdomain}`,
  };
}
