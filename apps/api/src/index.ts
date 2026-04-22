import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { cors } from "hono/cors";
import { appRouter } from "./router.js";
import { createContext } from "./trpc.js";
import { metaOAuthApp } from "./integrations/meta/oauth.js";
import { metaWebhookApp } from "./integrations/meta/webhook.js";
import { metaDataDeletionApp } from "./integrations/meta/data-deletion.js";
import { messengerOAuthApp } from "./integrations/messenger/oauth.js";
import { messengerWebhookApp } from "./integrations/messenger/webhook.js";

const app = new Hono();
const PORT = parseInt(process.env.PORT || "8080", 10);

// ============================================================================
// MIDDLEWARE
// ============================================================================

// CORS middleware
app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN ||
      (process.env.NODE_ENV === "production"
        ? "*"
        : ["http://localhost:3000", "http://localhost:3001"]),
    credentials: true,
  })
);

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================================================
// META LEAD ADS INTEGRATION (plain HTTP — not tRPC)
// ============================================================================

// OAuth flow — authorize + callback
app.route("/api/integrations/meta", metaOAuthApp);

// Webhook — leadgen notifications from Meta (public, signature-verified)
app.route("/webhooks/meta", metaWebhookApp);

// Data Deletion Callback — GDPR compliance (public, signed-request-verified)
app.route("/api/integrations/meta/data-deletion", metaDataDeletionApp);

// ============================================================================
// FACEBOOK MESSENGER INTEGRATION (plain HTTP — not tRPC)
// ============================================================================

// OAuth flow — authorize + callback (Messenger permissions)
app.route("/api/integrations/messenger", messengerOAuthApp);

// Webhook — incoming messages from Messenger (public, signature-verified)
app.route("/webhooks/messenger", messengerWebhookApp);

// ============================================================================
// tRPC SERVER
// ============================================================================

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext,
  })
);

// ============================================================================
// 404 HANDLER
// ============================================================================

app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.onError((err, c) => {
  console.error("Server error:", err);
  return c.json(
    {
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : err.message,
    },
    500
  );
});

// ============================================================================
// START SERVER
// ============================================================================

console.log(`Starting API server on port ${PORT}...`);
serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`API server is running at http://localhost:${info.port}`);
  }
);
