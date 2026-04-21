/**
 * Meta Graph API client — minimal axios wrapper (no official Node SDK).
 *
 * Per-connection Page Access Token loaded from Secret Manager with cache.
 * Graph API version is pinned — upgrades are explicit schema migrations.
 *
 * KAN-620: Graph API client wrapper with token injection
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { ChannelConnection } from '@growth/connector-contracts';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

export const GRAPH_API_VERSION = 'v20.0';
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const secretManager = new SecretManagerServiceClient();

interface PageTokenPayload {
  pageAccessToken: string;
  pageId: string;
  pageName: string;
  issuedAt: number;
  // Long-lived Page tokens from a long-lived user token don't expire,
  // but we track issuedAt for operational visibility.
}

const tokenCache = new Map<string, { payload: PageTokenPayload; loadedAt: number }>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Load the Page Access Token for a connection. Cached in-memory. */
export async function loadPageToken(connection: ChannelConnection): Promise<PageTokenPayload> {
  const cached = tokenCache.get(connection.id);
  if (cached && Date.now() - cached.loadedAt < TOKEN_TTL_MS) return cached.payload;

  const pageId = connection.metadata?.pageId as string | undefined;
  if (!pageId) throw new Error(`Connection ${connection.id} missing pageId in metadata`);

  const name = `projects/${env.GCP_PROJECT_ID}/secrets/${connection.tenantId}-meta-${pageId}/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name });
  const raw = version.payload?.data?.toString();
  if (!raw) throw new Error(`Meta page token missing for connection ${connection.id}`);
  const payload = JSON.parse(raw) as PageTokenPayload;

  tokenCache.set(connection.id, { payload, loadedAt: Date.now() });
  return payload;
}

/** Invalidate cache on disconnect or rotation. */
export function invalidateMetaClient(connection: ChannelConnection): void {
  tokenCache.delete(connection.id);
  logger.debug({ connectionId: connection.id }, 'Meta token cache invalidated');
}

/** Core fetch wrapper — Meta returns typed error bodies we extract. */
export interface MetaErrorBody {
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export async function graphFetch<T>(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    accessToken: string;
    params?: Record<string, string>;
  },
): Promise<T> {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', init.accessToken);
  if (init.params) {
    for (const [k, v] of Object.entries(init.params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    method: init.method ?? 'GET',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const bodyText = await res.text();
  let parsed: (T & MetaErrorBody) | MetaErrorBody;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as T & MetaErrorBody) : ({} as T & MetaErrorBody);
  } catch {
    throw new MetaApiError(`Invalid JSON from Graph API: ${bodyText.slice(0, 200)}`, res.status);
  }

  if (!res.ok || 'error' in parsed) {
    const err = (parsed as MetaErrorBody).error;
    throw new MetaApiError(
      err?.message ?? `Graph API ${res.status}`,
      res.status,
      err?.code,
      err?.error_subcode,
      err?.fbtrace_id,
    );
  }

  return parsed as T;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/** Master App credentials — used for OAuth exchange, NOT for Page actions. */
let appCredentials: { appId: string; appSecret: string } | null = null;
export async function getAppCredentials(): Promise<{ appId: string; appSecret: string }> {
  if (appCredentials) return appCredentials;
  const basePath = `projects/${env.GCP_PROJECT_ID}/secrets`;
  const [appIdVer] = await secretManager.accessSecretVersion({
    name: `${basePath}/axisone/meta-app/app-id/versions/latest`,
  });
  const [appSecretVer] = await secretManager.accessSecretVersion({
    name: `${basePath}/axisone/meta-app/app-secret/versions/latest`,
  });
  const appId = appIdVer.payload?.data?.toString().trim();
  const appSecret = appSecretVer.payload?.data?.toString().trim();
  if (!appId || !appSecret) throw new Error('Meta App credentials missing from Secret Manager');
  appCredentials = { appId, appSecret };
  return appCredentials;
}
