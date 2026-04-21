/**
 * SendGrid SDK client factories — per-tenant subuser instances.
 *
 * Master client is used only for subuser CRUD and domain auth provisioning
 * (those operations require master-level permissions). Tenant clients use
 * a scoped API key that can ONLY send mail from that subuser.
 *
 * KAN-587: @sendgrid/mail wrapper with subuser key
 */

import sgMail from '@sendgrid/mail';
import sgClient from '@sendgrid/client';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { ChannelConnection } from '@growth/connector-contracts';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

const secretManager = new SecretManagerServiceClient();

interface SendGridTenantCredentials {
  apiKey: string; // mail.send scoped subuser API key
  subuserUsername: string;
  verifiedSenderId?: number; // ID of the verified sender to use as From
}

/** Mail client cache keyed by connection id. */
const mailCache = new Map<string, typeof sgMail>();
const credsCache = new Map<string, { creds: SendGridTenantCredentials; loadedAt: number }>();
const CREDS_TTL_MS = 5 * 60 * 1000;

async function loadTenantCreds(tenantId: string): Promise<SendGridTenantCredentials> {
  const cached = credsCache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < CREDS_TTL_MS) return cached.creds;

  const name = `projects/${env.GCP_PROJECT_ID}/secrets/${tenantId}-sendgrid/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name });
  const payload = version.payload?.data?.toString();
  if (!payload) throw new Error(`SendGrid credentials missing for tenant ${tenantId}`);

  const creds = JSON.parse(payload) as SendGridTenantCredentials;
  credsCache.set(tenantId, { creds, loadedAt: Date.now() });
  return creds;
}

/**
 * @sendgrid/mail is a singleton by design — we can't instantiate multiple
 * clients. Instead we call `setApiKey()` right before each send. To avoid
 * race conditions in a concurrent Cloud Run instance, we serialize sends
 * via a per-connection mutex.
 *
 * This is an SDK limitation. A future refactor can switch to raw @sendgrid/client
 * calls for true concurrency; for now the serialization cost is ~1ms per send.
 */
const sendMutex = new Map<string, Promise<unknown>>();

export async function sendWithSubuserKey<T>(
  connection: ChannelConnection,
  fn: (mail: typeof sgMail, creds: SendGridTenantCredentials) => Promise<T>,
): Promise<T> {
  const prev = sendMutex.get(connection.id) ?? Promise.resolve();
  let resolveNext: () => void = () => undefined;
  const next = new Promise<void>((r) => {
    resolveNext = r;
  });
  sendMutex.set(connection.id, next);

  try {
    await prev;
    const creds = await loadTenantCreds(connection.tenantId);
    sgMail.setApiKey(creds.apiKey);
    return await fn(sgMail, creds);
  } finally {
    resolveNext();
    // clean up stale entry
    if (sendMutex.get(connection.id) === next) sendMutex.delete(connection.id);
  }
}

/** Master SendGrid client — used only for subuser + domain auth provisioning. */
let masterClientSet = false;
export async function getMasterSendGridClient(): Promise<typeof sgClient> {
  if (!masterClientSet) {
    const name = `projects/${env.GCP_PROJECT_ID}/secrets/sendgrid-master/versions/latest`;
    const [version] = await secretManager.accessSecretVersion({ name });
    const payload = version.payload?.data?.toString();
    if (!payload) throw new Error('SendGrid master API key missing from Secret Manager');
    sgClient.setApiKey(payload.trim());
    masterClientSet = true;
  }
  return sgClient;
}

/** Invalidate tenant caches on disconnect or credential rotation. */
export function invalidateSendGridClient(connection: ChannelConnection): void {
  mailCache.delete(connection.id);
  credsCache.delete(connection.tenantId);
  sendMutex.delete(connection.id);
  logger.debug({ connectionId: connection.id }, 'SendGrid caches invalidated');
}
