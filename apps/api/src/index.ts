// KAN-705 manual migrate provenance: 20260427155230_add_assignment_rules_and_lead_assignment_posture
// applied via local Cloud SQL Auth Proxy on 2026-04-27 (v3 RUN-branch failed on
// proxy-readiness signal — TCP bind ≠ proxy ready for DB traffic). This comment
// edit retriggers deploy-api.yml via the apps/api/** path filter so Cloud Run
// picks up the post-KAN-705 image on top of the now-migrated schema.
//
// KAN-706 redeploy provenance (2026-04-28): schema 20260428120430_add_knowledge_ingestion_schemas
// was applied locally via the Cloud SQL Auth Proxy pre-merge (operator process gap —
// see feedback_proxy_5433_points_at_prod.md). The PR #55 merge run hit a separate IAM
// failure: github-actions SA was missing roles/cloudsql.client. After granting that role
// at project level, this comment edit retriggers deploy-api.yml so Cloud Run picks up
// the post-KAN-706 code (zod mirrors for KnowledgeSourceTypeEnum + KnowledgeSourceStatusEnum)
// on top of the already-migrated schema. Path-filter takes the SKIP path on this push
// (no schema files), so the deploy-api workflow exercises only the deploy phases — not
// migrate-end-to-end.
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
import { actionDecidedPushApp } from "./subscribers/action-decided-push.js";
import { actionExecutedPushApp } from "./subscribers/action-executed-push.js";
import { knowledgeIngestPushApp } from "./subscribers/knowledge-ingest-push.js";
import { llmCallPushApp } from "./subscribers/llm-call-push.js";
import { leadReceivedPushApp } from "./subscribers/lead-received-push.js";
import { knowledgeSourceIngestedPushApp } from "./subscribers/knowledge-source-ingested-push.js";
import { leadApiApp } from "./routes/lead-api.js";
import { knowledgeSourcesApp } from "./routes/knowledge-sources.js";
import { faqEntriesApp } from "./routes/faq-entries.js";
import { cronDeferredSendApp } from "./internal/cron-deferred-send.js";
import { getPubSubClient } from "../../../packages/api/src/lib/pubsub-client.js";
import { setLLMCostPublisher } from "../../../packages/api/src/services/llm-client.js";

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
// PUB/SUB PUSH SUBSCRIBERS (OIDC-authed)
// ============================================================================

app.route("/pubsub", actionDecidedPushApp);
app.route("/pubsub", actionExecutedPushApp);
app.route("/pubsub", knowledgeIngestPushApp);
// KAN-745 PR B — llm.call cost-event subscriber
app.route("/pubsub", llmCallPushApp);
// KAN-774 — lead.received → assignLeadToPipeline (closes Lead Inbox consumer gap)
app.route("/pubsub", leadReceivedPushApp);
app.route("/pubsub", knowledgeSourceIngestedPushApp);

// KAN-814 — Cloud Scheduler cron HTTP target. Mounted at
// /internal/cron/deferred-send-evaluator. OIDC-protected (reuses
// verifyPubsubOidc — works for Cloud Scheduler tokens too).
app.route("/internal", cronDeferredSendApp);

// ============================================================================
// PUBLIC LEAD API (KAN-742) — API-key authenticated, rate-limited, idempotent
// ============================================================================

app.route("/api/v1/leads", leadApiApp);

// ============================================================================
// KNOWLEDGE INGESTION INTAKE (KAN-827) — Firebase JWT + tenant scope
// ============================================================================

app.route("/api/knowledge", knowledgeSourcesApp);
// KAN-XXX — FAQ entries as first-class admin resource (separate table + sync embed)
app.route("/api/knowledge", faqEntriesApp);

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

// KAN-699: wire the cost-tracking publisher so every llm-client call emits an
// llm.call Pub/Sub event. Best-effort — publish failures are logged, never thrown.
setLLMCostPublisher(getPubSubClient());

// KAN-698: RAG knowledge fetcher auto-wires lazily inside context-assembler's
// loadKnowledge on first call (variable-specifier dynamic import keeps
// brain-embeddings out of the static TS6059 graph).

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
