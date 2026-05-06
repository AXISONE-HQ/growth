/**
 * KAN-827 sub-cohort 3 — `knowledge.source_ingested` Pub/Sub push subscriber.
 *
 * Cloud Run push endpoint at `POST /pubsub/knowledge-source-ingested`.
 * Subscription provisioned per the gcloud bundle in KAN-827 — see retro
 * page for the canonical command set.
 *
 * Audience: derived from request URL via `verifyPubsubOidc` per
 * `class_structural_elimination/audience_mismatch` (KAN-732 eliminated the
 * audience-mismatch class structurally). NO env var, NO per-subscriber
 * audience constant.
 *
 * Flow:
 *   1. verify OIDC → derive audience from `c.req.path` (canonical helper)
 *   2. base64-decode envelope → KnowledgeSourceIngestedEventSchema.parse
 *   3. Delegate to `ingestSource(prisma, sourceId)` — orchestrator runs
 *      chunking + embedding + writes; idempotent on status guard
 *   4. Return 200 always (idempotent, status guard handles redelivery).
 *      ON true infrastructure failure (Prisma down, OpenAI rate limit
 *      after retry exhaustion), the orchestrator updates the source row
 *      to status='error' and returns failed — we still 200 because the
 *      error is captured on the row, not in the message envelope. Pub/Sub
 *      retry would just re-claim the row at status='error' branch. Manual
 *      admin-triggered retry path lives in KAN-829 admin UI.
 *
 * Error policy:
 *   - 401 on missing/invalid OIDC token (canonical)
 *   - 200 (ack + log) on malformed envelope or invalid event payload
 *     (poison-message defense — redelivery won't help if the producer
 *     emitted a bad shape)
 *   - 200 (ack + log) on orchestrator-completed/skipped/failed — the row
 *     captures the outcome; redelivery is bounded by `max_delivery_attempts=5`
 *     on the deadletter policy
 *   - 500 (nack → Pub/Sub retries → DLQ) only on unrecoverable runtime
 *     errors (Prisma client init failure, etc.)
 */
import { Hono } from "hono";
import { z } from "zod";
import { KnowledgeSourceIngestedEventSchema } from "@growth/shared";
import { prisma } from "../prisma.js";
import { verifyPubsubOidc } from "../lib/oidc-pubsub-verify.js";

// ─────────────────────────────────────────────
// Variable-specifier dynamic import — TS6059 cohort hygiene per
// `reference_variable_specifier_dynamic_import` memory.
// ─────────────────────────────────────────────

type IngestSourceFn = (
  prisma: unknown,
  sourceId: string,
) => Promise<{ type: "completed" | "skipped" | "failed"; sourceId: string; chunksWritten?: number; reason?: string }>;

let _ingestSource: IngestSourceFn | null = null;
async function loadIngestSource(): Promise<IngestSourceFn> {
  if (_ingestSource) return _ingestSource;
  const spec = "../../../../packages/api/src/services/knowledge-ingestion-service.js";
  const mod = (await import(spec)) as { ingestSource: IngestSourceFn };
  _ingestSource = mod.ingestSource;
  return _ingestSource;
}

// ─────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────

export const knowledgeSourceIngestedPushApp = new Hono();

const PubsubEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

knowledgeSourceIngestedPushApp.post("/knowledge-source-ingested", async (c) => {
  // 1. OIDC verification — canonical helper derives audience from request URL.
  const ok = await verifyPubsubOidc(c);
  if (!ok) {
    return c.text("unauthorized", 401);
  }

  // 2. Parse envelope + base64-decode payload.
  let envelope: unknown;
  try {
    envelope = await c.req.json();
  } catch {
    console.warn("[knowledge-source-ingested-push] malformed envelope JSON");
    return c.text("ok", 200);
  }
  const envelopeParse = PubsubEnvelopeSchema.safeParse(envelope);
  if (!envelopeParse.success) {
    console.warn(
      "[knowledge-source-ingested-push] envelope shape invalid",
      envelopeParse.error.issues,
    );
    return c.text("ok", 200);
  }

  let event: ReturnType<typeof KnowledgeSourceIngestedEventSchema.parse>;
  try {
    const decoded = Buffer.from(envelopeParse.data.message.data, "base64").toString("utf8");
    const json = JSON.parse(decoded) as unknown;
    event = KnowledgeSourceIngestedEventSchema.parse(json);
  } catch (err) {
    console.warn(
      "[knowledge-source-ingested-push] payload parse failed",
      (err as Error)?.message ?? String(err),
    );
    return c.text("ok", 200);
  }

  // 3. Delegate to orchestrator.
  try {
    const ingestSource = await loadIngestSource();
    const result = await ingestSource(prisma, event.sourceId);
    if (result.type === "completed") {
      console.log(
        `[knowledge-source-ingested-push] completed sourceId=${event.sourceId} tenantId=${event.tenantId} sourceType=${event.sourceType} chunksWritten=${result.chunksWritten}`,
      );
    } else if (result.type === "skipped") {
      console.log(
        `[knowledge-source-ingested-push] skipped sourceId=${event.sourceId} reason=${result.reason}`,
      );
    } else {
      console.warn(
        `[knowledge-source-ingested-push] failed sourceId=${event.sourceId} reason=${result.reason}`,
      );
    }
    return c.text("ok", 200);
  } catch (err) {
    // Unrecoverable runtime error — Prisma down or similar. 500 → Pub/Sub
    // retries up to 5 then deadletters per the subscription policy.
    console.error(
      `[knowledge-source-ingested-push] unrecoverable error sourceId=${event.sourceId}`,
      err,
    );
    return c.text("internal error", 500);
  }
});
