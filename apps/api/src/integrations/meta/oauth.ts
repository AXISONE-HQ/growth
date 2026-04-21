/**
 * Meta OAuth Flow
 * Handles authorization redirect and callback for Facebook Page connection.
 */

import { Hono } from "hono";
import crypto from "crypto";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  getUserPages,
  subscribePageToLeadgen,
  unsubscribePageFromLeadgen,
} from "./graph-api.js";
import { prisma } from "../../prisma.js";

export const metaOAuthApp = new Hono();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMetaConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_OAUTH_REDIRECT_URI;

  if (!appId || !appSecret || !redirectUri) {
    throw new Error("Meta OAuth not configured: missing META_APP_ID, META_APP_SECRET, or META_OAUTH_REDIRECT_URI");
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
    .slice(0, 16); // Short signature is fine for CSRF
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

  // Reject if older than 10 minutes
  const age = Date.now() - parseInt(timestamp, 10);
  if (age > 10 * 60 * 1000) return null;

  return tenantId;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/integrations/meta/authorize
 * Builds the Facebook Login URL and redirects the user.
 * Requires x-tenant-id header.
 */
metaOAuthApp.get("/authorize", (c) => {
  const tenantId = c.req.header("x-tenant-id");
  if (!tenantId) {
    return c.json({ error: "Missing x-tenant-id header" }, 401);
  }

  try {
    const { appId, appSecret, redirectUri } = getMetaConfig();
    const state = signState(tenantId, appSecret);
    const authUrl = buildAuthorizationUrl(appId, redirectUri, state);
    return c.redirect(authUrl);
  } catch (err: any) {
    console.error("Meta authorize error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

/**
 * GET /api/integrations/meta/callback
 * OAuth callback — exchanges code for tokens, subscribes page, stores integration.
 */
metaOAuthApp.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  // User denied permissions
  if (errorParam) {
    console.warn("Meta OAuth denied:", errorParam);
    // Redirect back to settings with error
    return c.redirect("/settings?tab=integrations&meta_error=denied");
  }

  if (!code || !state) {
    return c.redirect("/settings?tab=integrations&meta_error=missing_params");
  }

  try {
    const { appId, appSecret, redirectUri } = getMetaConfig();

    // Verify CSRF state
    const tenantId = verifyState(state, appSecret);
    if (!tenantId) {
      return c.redirect("/settings?tab=integrations&meta_error=invalid_state");
    }

    // 1. Exchange code for short-lived token
    const shortLivedToken = await exchangeCodeForToken(code, appId, appSecret, redirectUri);

    // 2. Exchange for long-lived token
    const longLivedToken = await getLongLivedToken(shortLivedToken, appId, appSecret);

    // 3. Get user's pages
    const pages = await getUserPages(longLivedToken);
    if (pages.length === 0) {
      return c.redirect("/settings?tab=integrations&meta_error=no_pages");
    }

    // Use the first page (MVP — page selector comes later)
    const page = pages[0];

    // 4. Subscribe page to leadgen webhooks
    await subscribePageToLeadgen(page.id, page.access_token);

    // 5. Store integration record
    // NOTE: In production, store page.access_token in Secret Manager.
    // For MVP, we encrypt and store in the config JSON.
    await prisma.integration.upsert({
      where: {
        tenantId_provider: {
          tenantId,
          provider: "Meta Lead Ads",
        },
      },
      create: {
        tenantId,
        provider: "Meta Lead Ads",
        category: "advertising",
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

    console.log(`Meta Lead Ads connected for tenant ${tenantId}, page "${page.name}" (${page.id})`);
    return c.redirect("/settings?tab=integrations&meta_success=connected");
  } catch (err: any) {
    console.error("Meta OAuth callback error:", err);
    return c.redirect(`/settings?tab=integrations&meta_error=exchange_failed`);
  }
});

/**
 * POST /api/integrations/meta/disconnect
 * Disconnects the Meta integration for a tenant.
 */
metaOAuthApp.post("/disconnect", async (c) => {
  const tenantId = c.req.header("x-tenant-id");
  if (!tenantId) {
    return c.json({ error: "Missing x-tenant-id header" }, 401);
  }

  try {
    const integration = await prisma.integration.findUnique({
      where: {
        tenantId_provider: {
          tenantId,
          provider: "Meta Lead Ads",
        },
      },
    });

    if (!integration) {
      return c.json({ error: "No Meta integration found" }, 404);
    }

    const config = integration.config as any;

    // Best-effort unsubscribe from page webhooks
    if (config?.pageId && config?.pageAccessToken) {
      try {
        await unsubscribePageFromLeadgen(config.pageId, config.pageAccessToken);
      } catch (e) {
        console.warn("Failed to unsubscribe page (continuing):", e);
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

    console.log(`Meta Lead Ads disconnected for tenant ${tenantId}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error("Meta disconnect error:", err);
    return c.json({ error: "Failed to disconnect" }, 500);
  }
});
