/**
 * KAN-827 — Sprint 11a Knowledge ingestion pipeline schemas.
 *
 * Two MVP input paths:
 *   - 'pdf'        — multipart upload, parsed by pdf-parse
 *   - 'paste_text' — raw text body in JSON
 *
 * The HTTP intake endpoint writes a `knowledge_source` row with status='queued'
 * and publishes a `knowledge.source_ingested` Pub/Sub event. The async push
 * subscriber in apps/api/src/subscribers reads the event, dispatches by
 * sourceType to the appropriate handler, runs chunking + embedding, and
 * transitions status → 'ready' (or 'error' on failure).
 *
 * **KAN-XXX (FAQ first-class):** the legacy `'faq'` sourceType + Q&A
 * `FaqIngestBodySchema` are removed. FAQ entries are now their own entity
 * (`packages/api/src/services/faq-entries.ts` + `apps/api/src/routes/faq-entries.ts`)
 * with synchronous embedding (no Pub/Sub). The shared `'faq'` category
 * value is dropped from KnowledgeCategoryV2Enum since net-new FAQ-typed
 * sources can't be created — but pre-existing chunks with category='faq'
 * remain valid retrieval rows (PROD COUNT(*)=0 globally pre-flight, so no
 * data migration needed).
 *
 * Replaces the legacy KAN-707 (`IngestRequestSchema` + `knowledge.ingest.requested`
 * topic) — the legacy schema mapped to the dropped KAN-786 tables; KAN-826
 * dropped both the tables and the schema. Topic naming follows the producer-
 * event convention (`lead.received`, `action.executed`) rather than the
 * verb-oriented legacy (`knowledge.ingest.requested`).
 */
import { z } from "zod";

// ─────────────────────────────────────────────
// Source type / category enums
// ─────────────────────────────────────────────

/**
 * Source ingestion path. The handler dispatches on this value:
 *   - 'pdf'         → pdf-parse → semantic chunking
 *   - 'paste_text'  → semantic chunking direct
 *
 * KAN-XXX dropped 'faq' — FAQ entries are first-class (FaqEntry table).
 */
export const KnowledgeSourceTypeEnum = z.enum(["pdf", "paste_text"]);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeEnum>;

/**
 * Tenant-classification category for the source. Drives the partial retrieval
 * index `(tenant_id, category) WHERE status='ready'` per architect spec §1.6
 * — chunks denormalize this from source.category for the hot-path pre-filter.
 *
 * KAN-XXX dropped 'faq' from create-side validation. The string value
 * remains valid for any pre-existing chunks; new sources can't be tagged
 * with it.
 */
export const KnowledgeCategoryV2Enum = z.enum([
  "inventory",
  "warranty",
  "pricing",
  "other",
]);
export type KnowledgeCategoryV2 = z.infer<typeof KnowledgeCategoryV2Enum>;

/**
 * Source lifecycle status. Locked by KAN-826 schema (knowledge_source.status
 * column TEXT default 'queued'). Transitions:
 *   queued → embedding → ready (success path)
 *   queued → embedding → error (terminal failure after retries exhausted)
 *   ready/error → deleted (admin soft-delete; 30-day cron hard-delete per §1.4)
 */
export const KnowledgeSourceStatusEnum = z.enum([
  "queued",
  "embedding",
  "ready",
  "error",
  "deleted",
]);
export type KnowledgeSourceStatus = z.infer<typeof KnowledgeSourceStatusEnum>;

// ─────────────────────────────────────────────
// HTTP intake endpoint — request bodies
// ─────────────────────────────────────────────

const COMMON_INTAKE_FIELDS = {
  category: KnowledgeCategoryV2Enum,
  /** Optional human-friendly title; admin UI displays in the sources list. */
  title: z.string().min(1).max(200).optional(),
} as const;

/**
 * Paste-text intake body (JSON). Up to 50K chars per architect spec §11.2
 * (and KAN-827 ticket "Components / Source intake endpoints"). Above the cap
 * is rejected at the boundary — no truncation.
 */
export const PasteTextIngestBodySchema = z.object({
  sourceType: z.literal("paste_text"),
  ...COMMON_INTAKE_FIELDS,
  /** Raw text body. Capped at 50K chars (rejected above). */
  rawContent: z.string().min(1).max(50_000),
});
export type PasteTextIngestBody = z.infer<typeof PasteTextIngestBodySchema>;

/**
 * KAN-XXX — `FaqIngestBodySchema` removed. FAQ entries are first-class
 * (`FaqEntry` Prisma model + dedicated `/api/knowledge/faqs` endpoints with
 * synchronous embedding). The legacy multi-pair contract gap (KAN-841) is
 * superseded structurally by the new entity.
 *
 * JSON intake now narrows to paste_text only. The discriminator field
 * survives for forward-compat with future intake source types (web crawl,
 * spreadsheet, etc.).
 */
export const JsonIngestBodySchema = PasteTextIngestBodySchema;
export type JsonIngestBody = z.infer<typeof JsonIngestBodySchema>;

/**
 * PDF intake constraints. Validated by the Hono multipart handler against
 * the parsed file metadata — not a zod schema (binary).
 */
export const PDF_INTAKE_LIMITS = {
  /** Max upload size in bytes — 10 MB per architect spec §11.2. */
  MAX_BYTES: 10 * 1024 * 1024,
  /** Allowed MIME types from the multipart Content-Type header. */
  ALLOWED_MIME: ["application/pdf"] as const,
  /** Allowed file extensions (defensive — MIME can be spoofed). */
  ALLOWED_EXTENSIONS: [".pdf"] as const,
} as const;

// ─────────────────────────────────────────────
// HTTP intake endpoint — response shape
// ─────────────────────────────────────────────

/**
 * 202-Accepted response shape from `POST /api/knowledge/sources`. Caller
 * polls KAN-829 admin UI / KAN-828 retrieval status endpoint to observe
 * status transitions.
 */
export const IngestSourceCreateResponseSchema = z.object({
  sourceId: z.string().uuid(),
  status: z.literal("queued"),
  /** Server-side checksum — useful for idempotency dedup. */
  fileChecksum: z.string().optional(),
});
export type IngestSourceCreateResponse = z.infer<typeof IngestSourceCreateResponseSchema>;

// ─────────────────────────────────────────────
// Pub/Sub event — knowledge.source_ingested
// ─────────────────────────────────────────────

/**
 * `knowledge.source_ingested` event payload. Published by the HTTP intake
 * endpoint immediately after the knowledge_source row commits with
 * status='queued'. Consumed by the apps/api push subscriber.
 *
 * Contains ONLY identifiers + metadata — the source's raw content lives on
 * the row (rawContent text column for paste_text/faq; GCS blob ref for pdf
 * which is post-MVP). The subscriber re-loads the row to access the content.
 */
export const KnowledgeSourceIngestedEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal("knowledge.source_ingested"),
  version: z.literal("1.0"),
  publishedAt: z.string().datetime(),
  tenantId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceType: KnowledgeSourceTypeEnum,
  category: KnowledgeCategoryV2Enum,
});
export type KnowledgeSourceIngestedEvent = z.infer<typeof KnowledgeSourceIngestedEventSchema>;

/**
 * Helper for producers — generates a canonical event payload. Producers MUST
 * call this helper rather than hand-construct the event so the version +
 * eventType literals stay in sync.
 */
export function buildKnowledgeSourceIngestedEvent(input: {
  eventId: string;
  tenantId: string;
  sourceId: string;
  sourceType: KnowledgeSourceType;
  category: KnowledgeCategoryV2;
}): KnowledgeSourceIngestedEvent {
  return KnowledgeSourceIngestedEventSchema.parse({
    eventId: input.eventId,
    eventType: "knowledge.source_ingested",
    version: "1.0",
    publishedAt: new Date().toISOString(),
    tenantId: input.tenantId,
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    category: input.category,
  });
}

// ─────────────────────────────────────────────
// Topic name (single source of truth)
// ─────────────────────────────────────────────

/**
 * Pub/Sub topic name for the `knowledge.source_ingested` event. Used by the
 * publisher in apps/api/src/services/knowledge-source-ingest-publisher.ts.
 * The push subscription targets `apps/api/src/subscribers/knowledge-source-ingested-push.ts`.
 *
 * Topic must be provisioned via gcloud or Terraform before the publisher
 * fires — see KAN-827 deploy notes. Per memory
 * `feedback_pubsub_route_registration_vs_subscription_config`, the route +
 * subscription + topic triangle must align exactly.
 */
export const KNOWLEDGE_SOURCE_INGESTED_TOPIC = "knowledge.source_ingested";
