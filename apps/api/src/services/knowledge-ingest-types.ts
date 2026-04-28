/**
 * KAN-707 PR A — Knowledge ingestion service contract types.
 *
 * Single source of truth for the typed shapes that cross apps/api ↔ apps/web
 * (KAN-708 will consume) and apps/api ↔ Pub/Sub (the worker subscribes).
 *
 * MUST stay in sync with `apps/web/src/lib/api.ts` mirrors. KAN-719 will
 * subsume both into a shared package once the cross-rootDir cascade
 * (KAN-689) closes.
 *
 * No new Prisma enums introduced here — `IngestionPath` is a TS-only union
 * over the input-allowed subset of `KnowledgeSourceType` (excludes
 * `structured_field` which is the legacy backfill type and not user-input).
 * `KnowledgeSourceStatus` (Prisma) is reused as the polling status type.
 */
import { z } from "zod";

/**
 * The 3 user-facing ingestion paths the wizard / API exposes. Subset of
 * `KnowledgeSourceType` minus `structured_field`.
 */
export const IngestionPathEnum = z.enum(["url", "document", "qa_pair"]);
export type IngestionPath = z.infer<typeof IngestionPathEnum>;

/** What the tenant submits to ingest.request. */
export const IngestRequestSchema = z.discriminatedUnion("path", [
  z.object({
    path: z.literal("url"),
    sourceUrl: z.string().url("Must be a valid HTTPS URL").startsWith("https://"),
    crawlScope: z.enum(["page", "domain", "sitemap"]).default("page"),
  }),
  z.object({
    path: z.literal("document"),
    /** GCS object reference (e.g., "growth-knowledge-uploads/<tenant>/<file>"). */
    uploadedFileRef: z.string().min(1),
    originalFileName: z.string().min(1).max(255),
  }),
  z.object({
    path: z.literal("qa_pair"),
    question: z.string().min(1).max(2000),
    answer: z.string().min(1).max(10000),
  }),
]);
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

/** What the polling endpoint returns. */
export interface IngestStatus {
  ingestionId: string;
  sourceId: string;
  /** Mirrors KnowledgeSourceStatus enum from schema.prisma. */
  status: "pending" | "processing" | "indexed" | "failed" | "stale";
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  /** Crawl-only: counts populated by the worker. Zero for non-url paths. */
  urlsDiscovered: number;
  urlsIndexed: number;
}

/** Pub/Sub event published to `knowledge.ingest.requested`. */
export interface IngestRequestedEvent {
  eventId: string;
  eventType: "knowledge.ingest.requested";
  version: "1.0";
  tenantId: string;
  ingestionId: string;
  sourceId: string;
  path: IngestionPath;
  /** Input payload — discriminated by path. */
  payload: IngestRequest;
  enqueuedAt: string;
}

/**
 * Per-tenant in-flight queue depth. PR B's worker decrements implicitly via
 * status transitions (processing → indexed/failed). PR A only enforces the
 * upper bound at the request boundary.
 */
export const PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT = 100;
