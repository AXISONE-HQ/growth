/**
 * KAN-827 — Sprint 11a knowledge ingestion HTTP intake.
 *
 * `POST /api/knowledge/sources` — three input paths:
 *   - multipart/form-data → PDF upload (max 10 MB; pdf-parse runs async in worker)
 *   - application/json    → paste_text (max 50K chars) OR faq Q&A pair
 *
 * Auth: Firebase ID token via Authorization: Bearer header + x-tenant-id
 * header. Mirrors the tRPC protectedProcedure auth pattern (apps/api/src/trpc.ts)
 * but inline because the route handles binary uploads (multipart) which tRPC
 * isn't suited for.
 *
 * Flow:
 *   1. Verify Firebase token + extract tenantId
 *   2. Parse + validate body (multipart for PDF, JSON for paste_text/faq)
 *   3. Compute SHA-256 fileChecksum for per-tenant idempotency dedup
 *   4. Write knowledge_source row with status='queued'
 *   5. Publish `knowledge.source_ingested` event
 *   6. Return 202 with sourceId
 *
 * On any failure: 400/401/413/500 with explicit error code; no row written.
 *
 * Replaces the legacy KAN-707 `knowledgeIngest.request` tRPC procedure
 * (deleted in KAN-826). The legacy `/pubsub/knowledge-ingest` route still
 * exists as dead code (no producers post-KAN-826); KAN-841 follow-up
 * decommissions it.
 */
import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import {
  JsonIngestBodySchema,
  KnowledgeCategoryV2Enum,
  PDF_INTAKE_LIMITS,
  buildKnowledgeSourceIngestedEvent,
  type IngestSourceCreateResponse,
} from "@growth/shared";
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { prisma } from "../prisma.js";

if (getApps().length === 0) {
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || "growth-493400",
  });
}
const firebaseAuth: Auth = getAuth();

export const knowledgeSourcesApp = new Hono();

// ─────────────────────────────────────────────
// Auth middleware — Firebase ID token + tenantId header
// ─────────────────────────────────────────────

interface AuthContext {
  tenantId: string;
  uid: string;
}

async function authenticate(authHeader: string | undefined, tenantHeader: string | undefined): Promise<AuthContext | { error: string; status: 401 | 400 }> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Missing Authorization Bearer token", status: 401 };
  }
  if (!tenantHeader) {
    return { error: "Missing x-tenant-id header", status: 400 };
  }
  const token = authHeader.slice(7);
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    return { tenantId: tenantHeader, uid: decoded.uid };
  } catch {
    return { error: "Invalid or expired Firebase ID token", status: 401 };
  }
}

// ─────────────────────────────────────────────
// Persistence + publish
// ─────────────────────────────────────────────

async function persistAndPublish(input: {
  tenantId: string;
  sourceType: "pdf" | "paste_text" | "faq";
  category: "faq" | "inventory" | "warranty" | "pricing" | "other";
  title: string | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  fileChecksum: string;
  rawContent: string | null;
  metadata: Record<string, unknown>;
}): Promise<IngestSourceCreateResponse> {
  // Variable-specifier dynamic import keeps the cross-rootDir publisher out
  // of the apps/api static TS graph (KAN-689 cohort discipline per
  // `reference_variable_specifier_dynamic_import` memory).
  const publisherSpec = "../../../../packages/api/src/services/knowledge-source-ingest-publisher.js";
  const { publishKnowledgeSourceIngested } = (await import(publisherSpec)) as {
    publishKnowledgeSourceIngested: (event: ReturnType<typeof buildKnowledgeSourceIngestedEvent>) => Promise<{ messageId: string }>;
  };

  const sourceId = randomUUID();
  const eventId = randomUUID();

  // Cast-loose for the new Prisma model — until the cohort migrates per
  // KAN-689. The model is generated; the cast is purely about cross-rootDir
  // import edge-cases on apps/api side.
  await (prisma as unknown as {
    knowledgeSource: {
      create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    };
  }).knowledgeSource.create({
    data: {
      id: sourceId,
      tenantId: input.tenantId,
      sourceType: input.sourceType,
      category: input.category,
      title: input.title,
      status: "queued",
      fileName: input.fileName,
      fileSizeBytes: input.fileSizeBytes,
      fileChecksum: input.fileChecksum,
      rawContent: input.rawContent,
      metadata: input.metadata,
    },
  });

  await publishKnowledgeSourceIngested(
    buildKnowledgeSourceIngestedEvent({
      eventId,
      tenantId: input.tenantId,
      sourceId,
      sourceType: input.sourceType,
      category: input.category,
    }),
  );

  console.log(
    `[knowledge-sources] queued sourceId=${sourceId} tenantId=${input.tenantId} sourceType=${input.sourceType} category=${input.category} fileSizeBytes=${input.fileSizeBytes ?? "null"} eventId=${eventId}`,
  );

  return { sourceId, status: "queued" as const, fileChecksum: input.fileChecksum };
}

// ─────────────────────────────────────────────
// POST /api/knowledge/sources
// ─────────────────────────────────────────────

knowledgeSourcesApp.post("/sources", async (c) => {
  const auth = await authenticate(
    c.req.header("authorization"),
    c.req.header("x-tenant-id"),
  );
  if ("error" in auth) {
    return c.json({ error: auth.error }, auth.status);
  }
  const { tenantId } = auth;

  const contentType = c.req.header("content-type") ?? "";

  // ── PDF path (multipart/form-data) ──────────────────────────────
  if (contentType.startsWith("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body["file"];
    const category = body["category"];
    const title = typeof body["title"] === "string" ? body["title"] : null;

    if (!(file instanceof File)) {
      return c.json({ error: "Missing 'file' multipart field (PDF)" }, 400);
    }
    if (typeof category !== "string" || !KnowledgeCategoryV2Enum.safeParse(category).success) {
      return c.json({ error: "Missing or invalid 'category' field" }, 400);
    }
    // Defensive checks: MIME type (Content-Type spoofable) AND extension.
    const fileName = file.name;
    const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
    const allowedExt: readonly string[] = PDF_INTAKE_LIMITS.ALLOWED_EXTENSIONS;
    const allowedMime: readonly string[] = PDF_INTAKE_LIMITS.ALLOWED_MIME;
    if (!allowedExt.includes(ext)) {
      return c.json({ error: `Disallowed file extension '${ext}' — only ${PDF_INTAKE_LIMITS.ALLOWED_EXTENSIONS.join(", ")} accepted` }, 400);
    }
    if (file.type && !allowedMime.includes(file.type)) {
      return c.json({ error: `Disallowed MIME type '${file.type}' — only ${PDF_INTAKE_LIMITS.ALLOWED_MIME.join(", ")} accepted` }, 400);
    }
    if (file.size > PDF_INTAKE_LIMITS.MAX_BYTES) {
      return c.json({ error: `File exceeds size cap (max ${PDF_INTAKE_LIMITS.MAX_BYTES} bytes, got ${file.size})` }, 413);
    }

    // Read bytes for checksum + future GCS upload (post-MVP). For now the
    // bytes live on rawContent? — actually NO; PDFs aren't useful as raw text
    // until pdf-parse runs (worker side). We persist the binary as base64
    // in metadata.pdfBase64 so the worker can re-fetch without GCS for MVP.
    // KAN-844 follow-up: move PDFs to GCS to avoid bloating Postgres rows.
    const arrayBuf = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const fileChecksum = createHash("sha256").update(buf).digest("hex");

    const result = await persistAndPublish({
      tenantId,
      sourceType: "pdf",
      category: category as "faq" | "inventory" | "warranty" | "pricing" | "other",
      title,
      fileName,
      fileSizeBytes: file.size,
      fileChecksum,
      rawContent: null,
      metadata: { pdfBase64: buf.toString("base64") },
    });
    return c.json(result, 202);
  }

  // ── JSON paths (paste_text + faq) ────────────────────────────────
  if (contentType.startsWith("application/json")) {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: "Malformed JSON body" }, 400);
    }
    const parsed = JsonIngestBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }

    const body = parsed.data;
    if (body.sourceType === "paste_text") {
      const fileChecksum = createHash("sha256").update(body.rawContent).digest("hex");
      const result = await persistAndPublish({
        tenantId,
        sourceType: "paste_text",
        category: body.category,
        title: body.title ?? null,
        fileName: null,
        fileSizeBytes: body.rawContent.length,
        fileChecksum,
        rawContent: body.rawContent,
        metadata: {},
      });
      return c.json(result, 202);
    }
    if (body.sourceType === "faq") {
      // Q+A combined for checksum so re-upload of (Q,A) pair detects dedup.
      const checksumPayload = `${body.question}\n${body.answer}`;
      const fileChecksum = createHash("sha256").update(checksumPayload).digest("hex");
      const result = await persistAndPublish({
        tenantId,
        sourceType: "faq",
        category: body.category,
        title: body.title ?? null,
        fileName: null,
        fileSizeBytes: checksumPayload.length,
        fileChecksum,
        rawContent: body.answer,
        metadata: { question: body.question },
      });
      return c.json(result, 202);
    }
  }

  return c.json({ error: "Unsupported Content-Type — expected multipart/form-data or application/json" }, 415);
});
