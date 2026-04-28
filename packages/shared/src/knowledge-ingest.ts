import { z } from "zod";

export const IngestionPathEnum = z.enum(["url", "document", "qa_pair"]);
export type IngestionPath = z.infer<typeof IngestionPathEnum>;

export const IngestRequestSchema = z.discriminatedUnion("path", [
  z.object({
    path: z.literal("url"),
    sourceUrl: z.string().url("Must be a valid HTTPS URL").startsWith("https://"),
    crawlScope: z.enum(["page", "domain", "sitemap"]).default("page"),
  }),
  z.object({
    path: z.literal("document"),
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

export interface IngestStatus {
  ingestionId: string;
  sourceId: string;
  status: "pending" | "processing" | "indexed" | "failed" | "stale";
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  urlsDiscovered: number;
  urlsIndexed: number;
}

export interface IngestRequestedEvent {
  eventId: string;
  eventType: "knowledge.ingest.requested";
  version: "1.0";
  tenantId: string;
  ingestionId: string;
  sourceId: string;
  path: IngestionPath;
  payload: IngestRequest;
  enqueuedAt: string;
}

export const PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT = 100;
