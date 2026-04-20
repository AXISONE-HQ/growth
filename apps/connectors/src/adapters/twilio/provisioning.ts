/**
 * Twilio provisioning — subaccount creation, number purchase, 10DLC registration.
 *
 * Owns the `connect()` flow end-to-end from the tenant's "Get Started"
 * click. Each step writes a trace to the audit log so engineering can
 * see exactly where a provisioning got stuck.
 *
 * KAN-492: Subaccount provisioning workflow
 * KAN-493: 10DLC Brand + Campaign registration (stubbed)
 * KAN-494: Phone number search and purchase (stubbed)
 * KAN-566, KAN-567, KAN-568: provisioning subtasks
 */

import { z } from 'zod';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { ChannelConnection, ConnectInput, TenantRef } from '@growth/connector-contracts';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { getMasterTwilioClient } from './client.js';

const secretManager = new SecretManagerServiceClient();

/**
 * Input schema for `connect()` — validated in the adapter before we call through.
 * This is the form data the tenant submits in the SMS connect UI (KAN-581).
 */
export const TwilioConnectParamsSchema = z.object({
  // Required for 10DLC brand registration (A2P messaging)
  businessName: z.string().min(1),
  businessWebsite: z.string().url(),
  businessEIN: z.string().min(1), // US tax ID
  businessAddress: z.object({
    street: z.string(),
    city: z.string(),
    region: z.string(), // state/province
    postalCode: z.string(),
    country: z.string().default('US'),
  }),
  useCase: z.enum([
    'MARKETING',
    'MIXED',
    'LOW_VOLUME',
    'CUSTOMER_CARE',
    'ACCOUNT_NOTIFICATION',
  ]),
  sampleMessages: z.array(z.string()).min(1).max(5),
  // Phone number preferences
  areaCode: z
    .string()
    .regex(/^\d{3}$/, 'Area code must be 3 digits')
    .optional(),
});
export type TwilioConnectParams = z.infer<typeof TwilioConnectParamsSchema>;

/**
 * Create a new Twilio subaccount for the tenant.
 * Idempotent: if one already exists, returns the existing record.
 */
export async function provisionSubaccount(tenant: TenantRef): Promise<{
  accountSid: string;
  authToken: string;
}> {
  const master = await getMasterTwilioClient();

  // Idempotency: check for an existing subaccount with matching friendlyName
  const existing = await master.api.v2010.accounts.list({
    friendlyName: `growth-${tenant.slug}`,
    limit: 1,
  });
  if (existing.length > 0 && existing[0].status !== 'closed') {
    logger.info({ tenantId: tenant.id, accountSid: existing[0].sid }, 'reusing existing Twilio subaccount');
    // For an existing account, we can't recover the auth token from the list API;
    // it lives in Secret Manager already. Re-fetch.
    const token = await fetchExistingAuthToken(tenant.id);
    return { accountSid: existing[0].sid, authToken: token };
  }

  const subaccount = await master.api.v2010.accounts.create({
    friendlyName: `growth-${tenant.slug}`,
  });

  // Persist credentials in Secret Manager (KAN-478)
  await writeSubaccountSecret(tenant.id, {
    accountSid: subaccount.sid,
    authToken: subaccount.authToken,
  });
  // Reverse-lookup secret for signature verification (see signature.ts)
  await writeReverseLookupSecret(subaccount.sid, subaccount.authToken);

  logger.info({ tenantId: tenant.id, accountSid: subaccount.sid }, 'Twilio subaccount created');
  return { accountSid: subaccount.sid, authToken: subaccount.authToken };
}

/**
 * Search available numbers in the tenant's preferred area code and purchase one.
 * Falls back to nearby area codes if requested one is exhausted.
 *
 * KAN-494, KAN-572, KAN-573
 */
export async function provisionPhoneNumber(
  accountSid: string,
  authToken: string,
  areaCode?: string,
): Promise<{ phoneNumber: string; phoneSid: string }> {
  const { default: Twilio } = await import('twilio');
  const client = Twilio(accountSid, authToken);

  const available = await client.availablePhoneNumbers('US').local.list({
    ...(areaCode ? { areaCode: Number.parseInt(areaCode, 10) } : {}),
    smsEnabled: true,
    limit: 1,
  });
  if (available.length === 0) {
    throw new Error(`No numbers available in area code ${areaCode ?? 'any'}`);
  }

  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    smsUrl: `${publicWebhookBaseUrl()}/webhooks/twilio/inbound`,
    statusCallback: `${publicWebhookBaseUrl()}/webhooks/twilio/status`,
  });

  logger.info({ phoneNumber: purchased.phoneNumber, sid: purchased.sid }, 'Twilio number purchased');
  return { phoneNumber: purchased.phoneNumber, phoneSid: purchased.sid };
}

/**
 * 10DLC Brand + Campaign registration via Twilio Trust Hub.
 * This is an async approval process (24–72h) — we submit and poll.
 *
 * TODO(KAN-569, KAN-570, KAN-571): Full Trust Hub flow.
 * Stub returns pending status so the connection can be marked PENDING
 * and we unlock sending only when approved.
 */
export async function submitBrandAndCampaign(
  _accountSid: string,
  _authToken: string,
  _params: TwilioConnectParams,
): Promise<{ brandStatus: 'pending'; campaignStatus: 'pending' }> {
  logger.warn('10DLC Brand/Campaign submission STUBBED — see KAN-569/570/571');
  return { brandStatus: 'pending', campaignStatus: 'pending' };
}

/** Build a `ChannelConnection` row from provisioning outputs. */
export function buildConnectionRecord(
  tenant: TenantRef,
  input: ConnectInput,
  accountSid: string,
  phoneNumber: string,
  messagingServiceSid: string | null,
  compliance: Awaited<ReturnType<typeof submitBrandAndCampaign>>,
): ChannelConnection {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tenantId: tenant.id,
    channelType: input.channel,
    provider: 'twilio',
    providerAccountId: accountSid,
    status: 'PENDING', // PENDING until 10DLC approved
    metadata: {
      phoneNumber,
      messagingServiceSid,
      areaCode: (input.params as TwilioConnectParams).areaCode,
    },
    complianceStatus: { brand: compliance.brandStatus, campaign: compliance.campaignStatus },
    connectedAt: null,
    lastHealthCheck: null,
    healthStatus: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Secret Manager helpers ────────────────────────────────

async function writeSubaccountSecret(
  tenantId: string,
  creds: { accountSid: string; authToken: string },
): Promise<void> {
  const parent = `projects/${env.GCP_PROJECT_ID}`;
  const secretId = `${tenantId}-twilio`;

  // Create the secret if it doesn't exist
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

async function writeReverseLookupSecret(accountSid: string, authToken: string): Promise<void> {
  const parent = `projects/${env.GCP_PROJECT_ID}`;
  const secretId = `twilio-subaccount-${accountSid}`;
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
    payload: { data: Buffer.from(authToken) },
  });
}

async function fetchExistingAuthToken(tenantId: string): Promise<string> {
  const name = `projects/${env.GCP_PROJECT_ID}/secrets/${tenantId}-twilio/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name });
  const payload = version.payload?.data?.toString();
  if (!payload) throw new Error(`Twilio credentials missing for tenant ${tenantId}`);
  return (JSON.parse(payload) as { authToken: string }).authToken;
}

function publicWebhookBaseUrl(): string {
  // In prod this is the Cloud Run service URL fronted by the load balancer.
  // Exposed via env for flexibility.
  const fromEnv = process.env.PUBLIC_WEBHOOK_BASE_URL;
  if (fromEnv) return fromEnv;
  // Reasonable default for dev
  return 'https://connectors.growth.axisone.com';
}
