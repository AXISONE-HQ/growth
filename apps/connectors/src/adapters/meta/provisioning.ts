/**
 * Meta Messenger provisioning — OAuth exchange, Page selection,
 * Page webhook subscription.
 *
 * Flow:
 *   1. Short-lived user access token arrives from Nango/OAuth callback
 *   2. Exchange for long-lived user access token (60-day)
 *   3. GET /me/accounts to list Pages the user admins (includes
 *      per-Page long-lived access token in response when requested
 *      with long-lived user token)
 *   4. Tenant picks one or more Pages in the UI
 *   5. For each Page: POST /{page_id}/subscribed_apps with fields
 *   6. Store the Page Access Token + metadata in Secret Manager
 *   7. Build ChannelConnection with `pageId` in metadata and
 *      `providerAccountId = pageId`
 *
 * KAN-617: Configure Nango integration for Facebook
 * KAN-618: Exchange short-lived → long-lived Page Access Token
 * KAN-619: Multi-page selection and per-Page connection
 * KAN-623: Call /:page_id/subscribed_apps on connect
 * KAN-625: Disconnect unsubscribes Page
 */

import { z } from 'zod';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { ChannelConnection, ConnectInput, TenantRef } from '@growth/connector-contracts';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { graphFetch, getAppCredentials } from './client.js';

const secretManager = new SecretManagerServiceClient();

/** Webhook fields we subscribe Pages to. Each must be App-Reviewed. */
export const PAGE_SUBSCRIBED_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_optins',
  'messaging_deliveries',
  'messaging_reads',
  'messaging_handovers',
].join(',');

/** Input schema for connect — what Nango hands us after OAuth. */
export const MetaConnectParamsSchema = z.object({
  /** Short-lived user access token from Nango OAuth result. */
  userAccessToken: z.string().min(1),
  /** Page IDs the tenant selected to connect. Can be multiple. */
  selectedPageIds: z.array(z.string().min(1)).min(1),
});
export type MetaConnectParams = z.infer<typeof MetaConnectParamsSchema>;

interface PageSummary {
  id: string;
  name: string;
  access_token: string;
  category: string;
  tasks: string[]; // must include 'MESSAGING' for us to use it
}

/** Exchange short-lived for long-lived user token. 60-day lifetime. */
export async function exchangeForLongLivedUserToken(
  shortLivedToken: string,
): Promise<{ access_token: string; expires_in?: number }> {
  const { appId, appSecret } = await getAppCredentials();
  return graphFetch<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
    method: 'GET',
    accessToken: '', // passed as param below
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    },
  });
}

/** Fetch all Pages the user admins, with their long-lived Page access tokens. */
export async function fetchUserPages(longLivedUserToken: string): Promise<PageSummary[]> {
  const res = await graphFetch<{ data: PageSummary[] }>('/me/accounts', {
    method: 'GET',
    accessToken: longLivedUserToken,
    params: { fields: 'id,name,access_token,category,tasks' },
  });
  return res.data.filter((p) => p.tasks.includes('MESSAGING'));
}

/** Subscribe one Page to our webhook — required so we receive messages. */
export async function subscribePage(pageId: string, pageAccessToken: string): Promise<void> {
  await graphFetch(`/${pageId}/subscribed_apps`, {
    method: 'POST',
    accessToken: pageAccessToken,
    params: { subscribed_fields: PAGE_SUBSCRIBED_FIELDS },
  });
  logger.info({ pageId }, 'Page subscribed to webhook');
}

/** Unsubscribe a Page on disconnect. */
export async function unsubscribePage(pageId: string, pageAccessToken: string): Promise<void> {
  await graphFetch(`/${pageId}/subscribed_apps`, {
    method: 'DELETE',
    accessToken: pageAccessToken,
  });
  logger.info({ pageId }, 'Page unsubscribed from webhook');
}

/**
 * Persist the Page Access Token + metadata to Secret Manager.
 * Returns the Secret Manager path (credentialsRef) so the caller can
 * persist it on the ChannelConnection row.
 */
export async function storePageToken(
  tenantId: string,
  pageId: string,
  pageName: string,
  pageAccessToken: string,
): Promise<string> {
  const parent = `projects/${env.GCP_PROJECT_ID}`;
  const secretId = `${tenantId}-meta-${pageId}`;
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
    payload: {
      data: Buffer.from(
        JSON.stringify({
          pageAccessToken,
          pageId,
          pageName,
          issuedAt: Math.floor(Date.now() / 1000),
        }),
      ),
    },
  });
  return `${parent}/secrets/${secretId}`;
}

/** Build a ChannelConnection from provisioning outputs. One per Page. */
export function buildMetaConnectionRecord(
  tenant: TenantRef,
  input: ConnectInput,
  page: PageSummary,
): ChannelConnection {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tenantId: tenant.id,
    channelType: input.channel,
    provider: 'meta',
    providerAccountId: page.id,
    status: 'ACTIVE',
    metadata: {
      pageId: page.id,
      pageName: page.name,
      pageCategory: page.category,
      subscribed: true,
    },
    complianceStatus: null, // Meta has no per-tenant compliance flow (App Review is one-time for the App)
    connectedAt: now,
    lastHealthCheck: null,
    healthStatus: null,
    createdAt: now,
    updatedAt: now,
  };
}
