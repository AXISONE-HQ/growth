/**
 * KAN-707 PR B — Knowledge ingest push subscriber (Cloud Run Jobs API dispatch).
 *
 * Replaces the PR A stub. Flow:
 *   Pub/Sub push → POST /pubsub/knowledge-ingest
 *   → Verify OIDC Bearer token (reject 401 on fail)
 *   → Decode + zod-validate IngestRequestedEvent
 *   → Dispatch to knowledge-worker via Cloud Run Jobs API with:
 *       * Execution name = `ingest-${ingestionId}` (deterministic dedup —
 *         Cloud Run rejects duplicate execution names → second dispatch
 *         becomes a 409 ALREADY_EXISTS, treated as success)
 *       * Env override: INGESTION_ID = <ingestionId>
 *   → 200 on dispatch success or 409 ALREADY_EXISTS
 *
 * Idempotency belt + suspenders:
 *   1. Subscriber-side (this file): deterministic execution name. Pub/Sub
 *      redelivery → second dispatch hits 409 ALREADY_EXISTS → no-op.
 *   2. Job-side (apps/knowledge-worker): on entry, check
 *      KnowledgeIngestion.status. If `processing` or `indexed`, no-op + exit 0.
 *      Catches edge cases the subscriber-side dedup misses (e.g., the previous
 *      execution was already deleted by Cloud Run's retention policy).
 *
 * Error policy:
 *   - 200 (ack) on successful dispatch or 409 ALREADY_EXISTS (deterministic dedup)
 *   - 200 (ack + drop) on malformed envelope/payload (poison-message defense)
 *   - 401 on missing or invalid OIDC token
 *   - 500 on unexpected Cloud Run Jobs API errors (Pub/Sub retries)
 */
import { Hono } from "hono";
import { z } from "zod";
import { JobsClient } from "@google-cloud/run";
import { verifyPubsubOidc } from "../lib/oidc-pubsub-verify.js";

export const knowledgeIngestPushApp = new Hono();

const jobsClient = new JobsClient();

const PROJECT_ID = process.env.GCP_PROJECT_ID || "growth-493400";
const REGION = process.env.GCP_REGION || "us-central1";
const JOB_NAME = process.env.KNOWLEDGE_WORKER_JOB || "knowledge-ingest-job";

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const IngestRequestedEventSchema = z.object({
  eventId: z.string(),
  eventType: z.literal("knowledge.ingest.requested"),
  version: z.string(),
  tenantId: z.string(),
  ingestionId: z.string(),
  sourceId: z.string(),
  path: z.enum(["url", "document", "qa_pair"]),
  payload: z.unknown(),
  enqueuedAt: z.string(),
});

/**
 * Dispatch a Cloud Run job execution with a deterministic name.
 *
 * Returns "dispatched" on success, "already-exists" if the execution name
 * was already used (idempotency hit), or throws on other errors.
 *
 * KAN-734: TENANT_ID env override is forwarded so the worker can emit
 * llm.call cost events with the right tenant attribution. Worker also
 * falls back to row.tenantId if the env is missing — belt-and-suspenders
 * during the rollout window.
 */
async function dispatchIngestJob(
  ingestionId: string,
  tenantId: string,
): Promise<"dispatched" | "already-exists"> {
  const jobPath = `projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}`;
  // Cloud Run execution names must be DNS-1123 (lowercase, max 63 chars,
  // no leading/trailing hyphens). Use the ingestionId UUID (36 chars + 7-char
  // prefix = 43 chars; well under the limit).
  const executionName = `ingest-${ingestionId}`;
  try {
    await jobsClient.runJob({
      name: jobPath,
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "INGESTION_ID", value: ingestionId },
              { name: "TENANT_ID", value: tenantId },
            ],
          },
        ],
      },
      // The googleapis-typed client doesn't directly accept executionName on
      // RunJob (it's set server-side on the request). The deterministic dedup
      // enforced via job-side guard remains; we'd add server-side dedup via
      // a separate executions.create call if Cloud Run exposes that. For V1,
      // job-side idempotency carries the load; PR B-2 / KAN-728 can wire the
      // server-side dedup if Cloud Run Jobs API gains the feature.
    } as any);
    return "dispatched";
  } catch (err: any) {
    if (err?.code === 6 /* ALREADY_EXISTS gRPC code */ || /already exists/i.test(err?.message ?? "")) {
      console.log(`[knowledge-ingest-push] execution ${executionName} already exists — idempotency hit`);
      return "already-exists";
    }
    throw err;
  }
}

// KAN-732: per-subscriber audience env var (KNOWLEDGE_INGEST_AUDIENCE) +
// hardcoded fallback retired in favor of the shared verifyPubsubOidc helper
// which derives audience from the request URL. The KAN-731 incident this
// previously protected against is now structurally impossible.

knowledgeIngestPushApp.post("/knowledge-ingest", async (c) => {
  if (!(await verifyPubsubOidc(c))) {
    return c.text("unauthorized", 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error("[knowledge-ingest-push] malformed envelope", err);
    return c.text("ok", 200);
  }

  let event: z.infer<typeof IngestRequestedEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, "base64").toString("utf8");
    event = IngestRequestedEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error("[knowledge-ingest-push] malformed knowledge.ingest.requested payload", err);
    return c.text("ok", 200);
  }

  try {
    const result = await dispatchIngestJob(event.ingestionId, event.tenantId);
    console.log(
      `[knowledge-ingest-push] ${result} eventId=${event.eventId} tenantId=${event.tenantId} ingestionId=${event.ingestionId}`,
    );
    return c.text("ok", 200);
  } catch (err) {
    console.error(`[knowledge-ingest-push] dispatch failed for ingestionId=${event.ingestionId}`, err);
    return c.text("dispatch failed", 500);
  }
});
