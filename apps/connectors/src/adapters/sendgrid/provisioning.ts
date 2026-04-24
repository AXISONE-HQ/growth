/**
 * SendGrid subuser provisioning.
 *
 * AxisOne owns the master SendGrid account. On tenant connect, we:
 *   1. Create a subuser (isolated reputation, suppression list, quota)
 *   2. Generate a scoped API key (mail.send only, on that subuser)
 *   3. Store both in Secret Manager at `{tenant_id}-sendgrid`
 *
 * KAN-590: Subuser creation + scoped API key
 * KAN-591: Per-subuser IP pool assignment + rate cap
 * KAN-592: Idempotent connect
 */

import { z } from 'zod';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { ChannelConnection, ConnectInput, TenantRef } from '@growth/connector-contracts';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { getMasterSendGridClient } from './client.js';

const secretManager = new SecretManagerServiceClient();

/** Input schema for SendGrid connect — validated in the adapter before provisioning. */
export const SendGridConnectParamsSchema = z.object({
  /** Tenant's sending domain, e.g. "acme.com". Optional — undefined means "use shared subdomain". */
  sendingDomain: z.string().min(1).optional(),
  /** Default From address. Must match sendingDomain when custom. */
  fromEmail: z.string().email(),
  fromName: z.string().min(1),
  /** If set, tenant opts for the shared subdomain fallback (reply.{slug}.growth.axisone.com). */
  useSharedSubdomain: z.boolean().default(false),
});
export type SendGridConnectParams = z.infer<typeof SendGridConnectParamsSchema>;

interface SubuserOutput {
  username: string;
  email: string;
  apiKey: string; // scoped mail.send only
  credentialsRef: string; // Secret Manager path
}

/**
 * Create a subuser or reuse an existing one for the tenant.
 * Idempotency: matches on username `growth-{tenantSlug}`.
 */
export async function provisionSubuser(tenant: TenantRef): Promise<SubuserOutput> {
  const client = await getMasterSendGridClient();
  const log = logger.child({ tenantId: tenant.id, provider: 'sendgrid' });
  const username = `growth-${tenant.slug}`;
  const credentialsRef = `projects/${env.GCP_PROJECT_ID}/secrets/${tenant.id}-sendgrid`;

  // Idempotency check
  const [existingRes] = await client.request({
    method: 'GET',
    url: '/v3/subusers',
    qs: { username, limit: 1 },
  });
  const existing = (existingRes.body as Array<{ username: string; email: string }> | undefined) ?? [];
  if (existing.length > 0) {
    log.info({ username }, 'reusing existing SendGrid subuser');
    // API key must be fetched from Secret Manager — we can't recover it from the API
    const apiKey = await fetchExistingApiKey(tenant.id);
    return { username, email: existing[0].email, apiKey, credentialsRef };
  }

  // Create the subuser
  const subuserEmail = `sendgrid+${tenant.slug}@axisone.ca`;
  const generatedPassword = crypto.randomUUID().replace(/-/g, '') + '!A1';
  const [createRes] = await client.request({
    method: 'POST',
    url: '/v3/subusers',
    body: {
      username,
      email: subuserEmail,
      password: generatedPassword,
      ips: [], // inherits from master; dedicated IPs come with Phase 2
    },
  });
  log.info({ username, statusCode: createRes.statusCode }, 'SendGrid subuser created');

  // Generate a scoped API key on the subuser. SendGrid API key management
  // requires setting `On-Behalf-Of: {username}` header so it creates the
  // key on the subuser account, not the parent.
  const [keyRes] = await client.request({
    method: 'POST',
    url: '/v3/api_keys',
    headers: { 'On-Behalf-Of': username },
    body: {
      name: `growth-connectors-${tenant.slug}`,
      scopes: ['mail.send'],
    },
  });
  const apiKey = (keyRes.body as { api_key: string }).api_key;

  await writeSubuserSecret(tenant.id, { apiKey, subuserUsername: username });
  log.info({ username }, 'SendGrid subuser API key provisioned');

  return { username, email: subuserEmail, apiKey, credentialsRef };
}

/** Build a ChannelConnection record from provisioning outputs. */
export function buildSendGridConnectionRecord(
  tenant: TenantRef,
  input: ConnectInput,
  subuserUsername: string,
  params: SendGridConnectParams,
  domainAuthStatus: 'pending' | 'verified' | 'none',
): ChannelConnection {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tenantId: tenant.id,
    channelType: input.channel,
    provider: 'sendgrid',
    providerAccountId: subuserUsername,
    status: domainAuthStatus === 'verified' || params.useSharedSubdomain ? 'ACTIVE' : 'PENDING',
    metadata: {
      subuserUsername,
      sendingDomain: params.sendingDomain,
      fromEmail: params.fromEmail,
      fromName: params.fromName,
      useSharedSubdomain: params.useSharedSubdomain,
      domainAuthStatus,
    },
    complianceStatus: { domainAuth: domainAuthStatus },
    connectedAt: domainAuthStatus === 'verified' || params.useSharedSubdomain ? now : null,
    lastHealthCheck: null,
    healthStatus: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Secret Manager helpers ────────────────────────────────

async function writeSubuserSecret(
  tenantId: string,
  creds: { apiKey: string; subuserUsername: string },
): Promise<void> {
  const parent = `projects/${env.GCP_PROJECT_ID}`;
  const secretId = `${tenantId}-sendgrid`;
  try {
    await secretManager.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} } },
    });
  } catch (err) {
    if (!/already exists/i.test((err as Error).message)) throw err;
  }
  await secretManager.addSecretVersion({
    parent: `${parent}/secrets/${secretId}`,
    payload: { data: Buffer.from(JSON.stringify(creds)) },
  });
}

async function fetchExistingApiKey(tenantId: string): Promise<string> {
  const name = `projects/${env.GCP_PROJECT_ID}/secrets/${tenantId}-sendgrid/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name });
  const payload = version.payload?.data?.toString();
  if (!payload) throw new Error(`SendGrid credentials missing for tenant ${tenantId}`);
  return (JSON.parse(payload) as { apiKey: string }).apiKey;
}
