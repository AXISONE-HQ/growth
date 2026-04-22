/**
 * Facebook Messenger OAuth Flow
 * Handles authorization redirect and callback for Messenger page connection.
 * Follows the same pattern as Meta Lead Ads but with Messenger-specific
 * permissions (pages_messaging) and webhook subscription (messages field).
 */

import { Hono } from "hono";
import crypto from "crypto";
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMessengerConfig() {
  // Messenger uses the same Meta app — same app ID and secret
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.MESSENGER_OAUTH_REDIRECT_URI;

  if (!appId || !appSecret || !redirectUri) {
    throw new Error(
      "Messenger OAuth not configured: missing META_APP_ID, META_APP_SECRET, or MESSENGER_OAUTH_REDIRECT_URI"
    );
  }

  return { appId, appSecret, redirectUri };
}

/**
 * Sign a state parameter with HMAC to prevent CSRF.
 * State format: tenantId:timestamp:signature
 */
function signState(tenantId: string, secret: string): string {
  const timestamp = Date.now().toString();
  const payload = `${tenantId}:${timestamp}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  return `${payload}:${signature}`;
}

/**
 * Verify and extract tenantId from a signed state parameter.
 * Rejects if signature is invalid or state is older than 10 minutes.
 */
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

/**
 * GET /api/integrations/messenger/authorize
 * Builds the Facebook Login URL (with Messenger permissions) and redirects.
 * Requires x-tenant-id header.
 */
messengerOAuthApp.get("/authorize", (c) => {
  const tenantId = c.req.header("x-tenant-id");
  if (!tenantId) {
    return c.json({ error: "Missing x-tenant-id header" }, 401);
  }

  try {
    const { appId, appSecret, redirectUri } = getMessengerConfig();
    const state = signState(tenantId, appSecret);
    const authUrl = buildMessengerAuthorizationUrl(appId, redirectUri, state);
    return c.redirect(authUrl);
  } catch (err: any) {
    console.error("Messenger authorize error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

/**
 * GET /api/integrations/messenger/callback
 * OAuth callback — exchanges code for tokens, subscribes page to messages, stores integration.
 */
messengerOAuthApp.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  if (errorParam) {
    console.warn("Messenger OAuth denied:", errorParam);
    return c.redirect(
      `${WEB_BASE}/settings?tab=integrations&messenger_error=denied`
    );
  }

  if (!code || !state) {
    return c.redirect(
      `${WEB_BASE}/settings?tab=integrations&messenger_error=missing_params`
    );
  }

  try {
    const { appId, appSecret, redirectUri } = getMessengerConfig();

    // Verify CSRF state
    const tenantId = verifyState(state, appSecret);
    if (!tenantId) {
      return c.redirect(
        `${WEB_BASE}/settings?tab=integrations&messenger_error=invalid_state`
      );
    }

    // 1. Exchange code for short-lived token
    const shortLivedToken = await exchangeCodeForToken(
      code,
      appId,
      appSecret,
      redirectUri
    );

    // 2. Exchange for long-lived token
    const longLivedToken = await getLongLivedToken(
      shortLivedToken,
      appId,
      appSecret
    );

    // 3. Get user's pages
    const pages = await getUserPages(longLivedToken);
    if (pages.length === 0) {
      return c.redirect(
        `${WEB_BASE}/settings?tab=integrations&messenger_error=no_pages`
      );
    }

    // Use the first page (MVP — page selector comes later)
    const page = pages[0];

    // 4. Subscribe page to Messenger webhooks (messages field)
    try {
      await subscribePageToMessages(page.id, page.access_token);
      console.log(`Messenger webhook subscribed for page ${page.id}`);
    } catch (subErr: any) {
      console.warn(
        `Messenger subscription skipped for page ${page.id}: ${subErr.message}`
      );
    }

    // 5. Store integration record
    await prisma.integration.upsert({
      where: {
        tenantId_provider: {
          tenantId,
          provider: "Facebook Messenger",
        },
      },
      create: {
        tenantId,
        provider: "Facebook Messenger",
        category: "messaging",
        status: "connected",
        config: {
          pageId: page.id,
          pageName: page.name,
          pageAccessToken: page.access_token, // TODO: move to Secret Manager
          subscribedAt: new Date().toISOString(),
        },
        lastSyncAt: new Date(),
      },
      update: {
        status: "connected",
        config: {
          pageId: page.id,
          pageName: page.name,
          pageAccessToken: page.access_token,
          subscribedAt: new Date().toISOString(),
        },
        lastSyncAt: new Date(),
      },
    });

    console.log(
      `Facebook Messenger connected for tenant ${tenantId}, page "${page.name}" (${page.id})`
    );
    return c.redirect(
      `${WEB_BASE}/settings?tab=integrations&messenger_success=connected`
    );
  } catch (err: any) {
    console.error("Messenger OAuth callback error:", err);
    return c.redirect(
      `${WEB_BASE}/settings?tab=integrations&messenger_error=exchange_failed`
    );
  }
});

/**
 * POST /api/integrations/messenger/disconnect
 * Disconnects the Messenger integration for a tenant.
 */
messengerOAuthApp.post("/disconnect", async (c) => {
  const tenantId = c.req.header("x-tenant-id");
  if (!tenantId) {
    return c.json({ error: "Missing x-tenant-id header" }, 401);
  }

  try {
    const integration = await prisma.integration.findUnique({
      where: {
        tenantId_provider: {
          tenantId,
          provider: "Facebook Messenger",
        },
      },
    });

    if (!integration) {
      return c.json({ error: "No Messenger integration found" }, 404);
    }

    const config = integration.config as any;

    // Best-effort unsubscribe from page webhooks
    if (config?.pageId && config?.pageAccessToken) {
      try {
        await unsubscribePageFromMessages(
          config.pageId,
          config.pageAccessToken
        );
      } catch (e) {
        console.warn("Failed to unsubscribe Messenger page (continuing):", e);
      }
    }

    // Update integration status
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: "disconnected",
        config: {
          pageId: config?.pageId,
          pageName: config?.pageName,
          disconnectedAt: new Date().toISOString(),
        },
      },
    });

    console.log(`Facebook Messenger disconnected for tenant ${tenantId}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error("Messenger disconnect error:", err);
    return c.json({ error: "Failed to disconnect" }, 500);
  }
});
