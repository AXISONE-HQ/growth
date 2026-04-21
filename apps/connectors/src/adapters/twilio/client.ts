/**
 * Twilio SDK client factory — per-tenant instance using subaccount
 * credentials loaded from Secret Manager.
 *
 * KAN-563: Twilio Node SDK wrapper with subaccount auth
 *
 * Tenant-scoped: each ChannelConnection has its own subaccount SID +
 * auth token. We cache client instances keyed by `connection.id` for
 * the lifetime of the process (they're cheap to create but avoiding
 * the secret fetch on every send matters at scale).
 */

import Twilio from 'twilio';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { ChannelConnection } from '@growth/connector-contracts';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

const secretManager = new SecretManagerServiceClient();

/** Shape of a Twilio subaccount credential blob stored in Secret Manager. */
interface TwilioCredentials {
  accountSid: string; // subaccount SID (starts with "AC")
  authToken: string; // subaccount auth token
  messagingServiceSid?: string; // optional — present once Messaging Service is provisioned
}

/** In-memory client cache — evicted on connection disconnect. */
const clientCache = new Map<string, Twilio.Twilio>();
const credsCache = new Map<string, { creds: TwilioCredentials; loadedAt: number }>();
const CREDS_TTL_MS = 5 * 60 * 1000; // 5 min — matches Secret Manager wrapper

/** Load subaccount credentials from Secret Manager. */
async function loadCredentials(tenantId: string): Promise<TwilioCredentials> {
  const cached = credsCache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < CREDS_TTL_MS) {
    return cached.creds;
  }

  const name = `projects/${env.GCP_PROJECT_ID}/secrets/${tenantId}-twilio/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name });
  const payload = version.payload?.data?.toString();
  if (!payload) {
    throw new Error(`Twilio credentials missing for tenant ${tenantId}`);
  }

  const creds = JSON.parse(payload) as TwilioCredentials;
  credsCache.set(tenantId, { creds, loadedAt: Date.now() });
  return creds;
}

/** Get (or create) a Twilio client scoped to a single tenant connection. */
export async function getTwilioClient(connection: ChannelConnection): Promise<Twilio.Twilio> {
  const cached = clientCache.get(connection.id);
  if (cached) return cached;

  const creds = await loadCredentials(connection.tenantId);
  const client = Twilio(creds.accountSid, creds.authToken);
  clientCache.set(connection.id, client);
  logger.debug({ connectionId: connection.id, tenantId: connection.tenantId }, 'Twilio client instantiated');
  return client;
}

/** Get the Messaging Service SID for a connection. */
export async function getMessagingServiceSid(connection: ChannelConnection): Promise<string> {
  const creds = await loadCredentials(connection.tenantId);
  const sid =
    creds.messagingServiceSid ??
    (connection.metadata?.messagingServiceSid as string | undefined);
  if (!sid) {
    throw new Error(`No Messaging Service SID on connection ${connection.id}`);
  }
  return sid;
}

/** Invalidate cached client + creds — call on disconnect or credential rotation. */
export function invalidateTwilioClient(connection: ChannelConnection): void {
  clientCache.delete(connection.id);
  credsCache.delete(connection.tenantId);
}

/** Master account client — used for provisioning subaccounts. */
let masterClient: Twilio.Twilio | null = null;
export async function getMasterTwilioClient(): Promise<Twilio.Twilio> {
  if (masterClient) return masterClient;
  const name = `projects/${env.GCP_PROJECT_ID}/secrets/twilio-master/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name });
  const payload = version.payload?.data?.toString();
  if (!payload) throw new Error('Twilio master credentials missing from Secret Manager');
  const { accountSid, authToken } = JSON.parse(payload) as { accountSid: string; authToken: string };
  masterClient = Twilio(accountSid, authToken);
  return masterClient;
}
