/**
 * Facebook Messenger OAuth Flow — KAN-474.
 *
 * Persists to ChannelConnection (the KAN-451 model that Settings → Channels
 * reads). Page Access Token lives in Secret Manager at
 * `${GCP_PROJECT_ID}/secrets/${tenantId}-meta-${pageId}` — the same naming
 * the connectors-side adapter (apps/connectors/src/adapters/meta/client.ts
 * `loadPageToken`) already expects, so testConnection + send paths work
 * without changes there.
 *
 * Pre-KAN-474 this code wrote to a phantom `prisma.integration` model and
 * stored tokens plaintext in DB; that's all gone. See PR description for
 * the parallel-data-models bug it fixed.
 *
 * Single-page tenants only for now. Multi-page handling is subtask 4
 * (Page picker modal) — deferred.
 */

import { Hono } from "hono";
import crypto from "crypto";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import {
  buildMessengerAuthorizationUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  getUserPages,
  subscribePageToMessages,
  unsubscribePageFromMessages,
} from "./graph-api.js";
import { prisma } from "../../prisma.js";

export const messengerOAuthApp = new Hono();

const secretManager = new SecretManagerServiceClient();
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? "growth-493400";

// ── Secret Manager helpers ───────────────────────────────────────────────────

/**
 * Persist the Page Access Token to Secret Manager. Returns the secret
 * resource path (used as ChannelConnection.credentialsRef).
 *
 * Naming: `${tenantId}-meta-${pageId}` — matches the convention the
 * connectors-side `loadPageToken` reads from. KAN-690 tracks tightening
 * the per-secret IAM scope to this prefix.
 */
async function storePageToken(
  tenantId: string,
  pageId: string,
  pageName: string,
  pageAccessToken: string,
): Promise<string> {
  const parent = `projects/${GCP_PROJECT_ID}`;
  const secretId = `${tenantId}-meta-${pageId}`;

  // First-time create — idempotent: re-connect just adds a new version below.
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

  return `${parent}/secrets/${secretId}/versions/latest`;
}

// ── State signing (CSRF protection) ──────────────────────────────────────────

function getMessengerConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.MESSENGER_OAUTH_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) {
    throw new Error(
      "Messenger OAuth not configured: missing META_APP_ID, META_APP_SECRET, or MESSENGER_OAUTH_REDIRECT_URI",
    );
  }
  return { appId, appSecret, redirectUri };
}

function signState(tenantId: string, secret: string): string {
  const timestamp = Date.now().toString();
  const payload = `${tenantId}:${timestamp}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  return `${payload}:${signature}`;
}

function verifyState(state: string, secret: string): string | null {
  const parts = state.split(":");
  if (parts.length !== 3) return null;
  const [tenantId, timestamp, signature] = parts;
  const payload = `${tenantId}:${timestamp}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  if (signature !== expectedSig) return null;
  const age = Date.now() - parseInt(timestamp, 10);
  if (age > 10 * 60 * 1000) return null;
  return tenantId;
}

// ── Routes ───────────────────────────────────────────────────────────────────

const WEB_BASE = "https://growth-web-1086551891973.us-central1.run.app";

messengerOAuthApp.get("/authorize", (c) => {
  const tenantId = c.req.query("tenant_id") || c.req.header("x-tenant-id");
  if (!tenantId) {
    return c.json({ error: "Missing x-tenant-id header" }, 401);
  }
  try {
    const { appId, appSecret, redirectUri } = getMessengerConfig();
    const state = signState(tenantId, appSecret);
    const authUrl = buildMessengerAuthorizationUrl(appId, redirectUri, state);
    return c.redirect(authUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Messenger authorize error:", msg);
    return c.json({ error: msg }, 500);
  }
});

messengerOAuthApp.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  if (errorParam) {
    console.warn("[messenger-oauth] denied:", errorParam);
    return c.redirect(`${WEB_BASE}/settings?tab=channels&messenger_error=denied`);
  }
  if (!code || !state) {
    return c.redirect(`${WEB_BASE}/settings?tab=channels&messenger_error=missing_params`);
  }

  let tenantId: string | null = null;
  let pageIdForLog: string | undefined;

  try {
    const { appId, appSecret, redirectUri } = getMessengerConfig();

    tenantId = verifyState(state, appSecret);
    if (!tenantId) {
      return c.redirect(`${WEB_BASE}/settings?tab=channels&messenger_error=invalid_state`);
    }

    // Token exchange chain.
    const shortLivedToken = await exchangeCodeForToken(code, appId, appSecret, redirectUri);
    const longLivedToken = await getLongLivedToken(shortLivedToken, appId, appSecret);

    const pages = await getUserPages(longLivedToken);
    if (pages.length === 0) {
      return c.redirect(`${WEB_BASE}/settings?tab=channels&messenger_error=no_pages`);
    }
    if (pages.length > 1) {
      console.warn(
        `[messenger-oauth] tenant ${tenantId} has ${pages.length} pages — using first ("${pages[0].name}"); Page picker pending (subtask 4)`,
      );
    }
    const page = pages[0];
    pageIdForLog = page.id;

    // Subscribe page to Messenger webhooks (best-effort; persistence is the
    // important state — a re-connect can re-subscribe).
    try {
      await subscribePageToMessages(page.id, page.access_token);
      console.log(`[messenger-oauth] webhook subscribed for page ${page.id}`);
    } catch (subErr: unknown) {
      const msg = subErr instanceof Error ? subErr.message : String(subErr);
      console.warn(
        `[messenger-oauth] subscription failed for page ${page.id}: ${msg} (continuing)`,
      );
    }

    // Store the page token in Secret Manager BEFORE writing ChannelConnection,
    // so a partial-failure leaves no orphaned row pointing at a missing secret.
    const credentialsRef = await storePageToken(
      tenantId,
      page.id,
      page.name,
      page.access_token,
    );

    // Write ChannelConnection — replaces the phantom prisma.integration upsert.
    // Settings → Channels reads from this model (KAN-451 mapper).
    await prisma.channelConnection.upsert({
      where: {
        tenantId_channelType_providerAccountId: {
          tenantId,
          channelType: "MESSENGER",
          providerAccountId: page.id,
        },
      },
      create: {
        tenantId,
        channelType: "MESSENGER",
        provider: "meta",
        providerAccountId: page.id,
        status: "ACTIVE",
        label: page.name,
        credentialsRef,
        metadata: {
          pageId: page.id,
          pageName: page.name,
          subscribedAt: new Date().toISOString(),
        },
        connectedAt: new Date(),
      },
      update: {
        status: "ACTIVE",
        label: page.name,
        credentialsRef,
        metadata: {
          pageId: page.id,
          pageName: page.name,
          subscribedAt: new Date().toISOString(),
        },
        connectedAt: new Date(),
      },
    });

    console.log(
      `[messenger-oauth] connected tenant ${tenantId} page "${page.name}" (${page.id})`,
    );
    return c.redirect(`${WEB_BASE}/settings?tab=channels&messenger_success=connected`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorCode =
      err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
    console.error("[messenger-oauth] callback failed", {
      tenantId,
      pageId: pageIdForLog,
      errorCode,
      message: msg,
    });
    return c.redirect(`${WEB_BASE}/settings?tab=channels&messenger_error=exchange_failed`);
  }
});

messengerOAuthApp.post("/disconnect", async (c) => {
  const tenantId = c.req.query("tenant_id") || c.req.header("x-tenant-id");
  if (!tenantId) {
    return c.json({ error: "Missing x-tenant-id header" }, 401);
  }

  try {
    // Find the active Messenger connection (single-page → most recent ACTIVE).
    const conn = await prisma.channelConnection.findFirst({
      where: { tenantId, channelType: "MESSENGER", provider: "meta", status: "ACTIVE" },
      orderBy: { connectedAt: "desc" },
    });
    if (!conn) {
      return c.json({ error: "No active Messenger connection found" }, 404);
    }

    // Best-effort unsubscribe — load token from Secret Manager.
    const meta = (conn.metadata ?? {}) as Record<string, unknown>;
    const pageId = (meta.pageId as string | undefined) ?? conn.providerAccountId;
    let pageAccessToken: string | undefined;
    try {
      const [version] = await secretManager.accessSecretVersion({ name: conn.credentialsRef });
      const raw = version.payload?.data?.toString();
      if (raw) {
        const payload = JSON.parse(raw) as { pageAccessToken?: string };
        pageAccessToken = payload.pageAccessToken;
      }
    } catch (e) {
      console.warn("[messenger-oauth] could not load page token for unsubscribe:", e);
    }

    if (pageId && pageAccessToken) {
      try {
        await unsubscribePageFromMessages(pageId, pageAccessToken);
      } catch (e) {
        console.warn("[messenger-oauth] webhook unsubscribe failed (continuing):", e);
      }
    }

    // Mark the connection as REVOKED. We keep the row + secret so a re-connect
    // can update in place rather than creating a new orphan; KAN-690 follow-up
    // will scope a cleanup job for stale REVOKED secrets.
    await prisma.channelConnection.update({
      where: { id: conn.id },
      data: { status: "REVOKED" },
    });

    console.log(`[messenger-oauth] disconnected tenant ${tenantId} page ${pageId}`);
    return c.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[messenger-oauth] disconnect failed:", msg);
    return c.json({ error: "Failed to disconnect" }, 500);
  }
});
