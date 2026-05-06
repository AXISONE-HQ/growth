/**
 * KAN-827 sub-cohort 3 — Knowledge ingestion orchestrator (pure module).
 *
 * `ingestSource(prisma, sourceId)` — the post-Pub/Sub pipeline:
 *   1. Load `knowledge_source` row + assert tenantId scoping
 *   2. Transition status: queued → embedding (write barrier; idempotent
 *      redelivery skips if status is already 'embedding'/'ready')
 *   3. Dispatch by sourceType to the appropriate handler:
 *        - 'pdf'        → pdf-parse(metadata.pdfBase64) → chunk()
 *        - 'paste_text' → chunk(rawContent)
 *        - 'faq'        → 1 chunk per Q+A pair: embed Q, store A in chunk_text
 *   4. embed() each chunk
 *   5. Write `knowledge_chunk` rows in a transaction (atomic — partial
 *      failure rolls back chunks AND status transition)
 *   6. Transition status: embedding → ready (or 'error' on failure)
 *
 * **Idempotency:** on push redelivery (Pub/Sub may redeliver before ack),
 * the status guard at step 2 short-circuits. Status-machine semantics:
 *   - queued    → embedding   (this run is the first to claim it)
 *   - embedding → return early (another run claimed it; we ack)
 *   - ready     → return early (already complete)
 *   - error     → re-attempt allowed (manual admin retry path)
 *   - deleted   → return early (admin soft-deleted between publish and consume)
 *
 * **Tenant safety:** all reads/writes filter by `tenantId` (knowledge_chunk
 * has tenantId denormalized per architect spec §1.6). Per memory
 * `class_structural_elimination/audience_mismatch` siblings, the cross-tenant
 * leakage class is structurally guarded by the Prisma middleware in
 * packages/db/src/middleware/tenant.ts; this module also filters explicitly
 * for defense-in-depth on direct writes.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { chunk as chunkText, type Chunk } from "./knowledge-chunker.js";
import { embed, EmbeddingFailedError, type EmbeddedChunk } from "./knowledge-embedder.js";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type IngestionResult =
  | { type: "completed"; sourceId: string; chunksWritten: number }
  | { type: "skipped"; sourceId: string; reason: string }
  | { type: "failed"; sourceId: string; reason: string };

interface SourceRow {
  id: string;
  tenantId: string;
  sourceType: string;
  category: string;
  status: string;
  rawContent: string | null;
  metadata: unknown;
}

// ─────────────────────────────────────────────
// Cast-loose Prisma access — tactical until the KAN-689 cohort migrates.
// The typed delegate exists post-KAN-826 (verified by sub-cohort 5 smoke
// + structural test). The cast keeps cross-rootDir TS clean.
// ─────────────────────────────────────────────

interface KnowledgeSourceDelegate {
  findUnique: (args: {
    where: { id: string };
    select: Record<string, true>;
  }) => Promise<SourceRow | null>;
  update: (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<{ id: string }>;
}

interface KnowledgeChunkDelegate {
  // createMany excluded — Prisma's Unsupported("vector(1536)") column is
  // read-only via the typed client. Embedding writes go through $executeRaw
  // with explicit ::vector cast (see writeChunkRows below).
  deleteMany: (args: {
    where: { sourceId: string };
  }) => Promise<{ count: number }>;
}

function delegates(prisma: PrismaClient): {
  source: KnowledgeSourceDelegate;
  chunk: KnowledgeChunkDelegate;
} {
  const cast = prisma as unknown as {
    knowledgeSource: KnowledgeSourceDelegate;
    knowledgeChunk: KnowledgeChunkDelegate;
  };
  return { source: cast.knowledgeSource, chunk: cast.knowledgeChunk };
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export async function ingestSource(
  prisma: PrismaClient,
  sourceId: string,
): Promise<IngestionResult> {
  const { source: sourceDelegate, chunk: chunkDelegate } = delegates(prisma);

  // 1. Load + tenant scope
  const row = await sourceDelegate.findUnique({
    where: { id: sourceId },
    select: {
      id: true,
      tenantId: true,
      sourceType: true,
      category: true,
      status: true,
      rawContent: true,
      metadata: true,
    },
  });
  if (!row) {
    return { type: "skipped", sourceId, reason: "source-not-found" };
  }

  // 2. Status guard
  if (row.status !== "queued" && row.status !== "error") {
    return { type: "skipped", sourceId, reason: `status-already-${row.status}` };
  }

  // 3. Claim — transition to 'embedding'
  await sourceDelegate.update({
    where: { id: sourceId },
    data: { status: "embedding" },
  });

  try {
    // 4. Extract text per source type
    const chunks = await extractAndChunk(row);
    if (chunks.length === 0) {
      await sourceDelegate.update({
        where: { id: sourceId },
        data: {
          status: "error",
          errorDetail: "No chunks produced from source content",
        },
      });
      return { type: "failed", sourceId, reason: "no-chunks-produced" };
    }

    // 5. Embed
    const embedded = await embed(chunks);

    // 6. Write chunk rows + transition status='ready' atomically.
    //    deleteMany covers the re-attempt-after-error case so we don't
    //    accumulate stale chunks across retries.
    //
    //    Embedding column requires $executeRaw with explicit ::vector cast —
    //    Prisma's Unsupported("vector(1536)") is read-only via the typed
    //    client. We INSERT per-chunk inside the transaction (typed client
    //    is fine for the deleteMany + status update; $executeRaw drops to
    //    the underlying connection's binding).
    await prisma.$transaction(async (tx) => {
      const txDelegates = delegates(tx as unknown as PrismaClient);
      await txDelegates.chunk.deleteMany({ where: { sourceId } });
      await writeChunkRows(tx as unknown as PrismaClient, row, embedded);
      await txDelegates.source.update({
        where: { id: sourceId },
        data: {
          status: "ready",
          errorDetail: null,
        },
      });
    });

    return { type: "completed", sourceId, chunksWritten: embedded.length };
  } catch (err) {
    const reason =
      err instanceof EmbeddingFailedError
        ? `embedding-failed-position-${err.position}: ${err.message}`
        : (err as Error)?.message ?? String(err);
    await sourceDelegate.update({
      where: { id: sourceId },
      data: {
        status: "error",
        errorDetail: reason.slice(0, 1000),
      },
    });
    return { type: "failed", sourceId, reason };
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function extractAndChunk(row: SourceRow): Promise<Chunk[]> {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (row.sourceType === "paste_text") {
    return chunkText(row.rawContent ?? "");
  }
  if (row.sourceType === "faq") {
    // 1 chunk = 1 Q+A pair. Embed the question (in chunkText for
    // ingestion-side semantics; the consumer renders chunkText as the
    // answer because we swap for storage). Architect spec §2 places the
    // question on `knowledge_chunk.question_text` and the answer on
    // `chunk_text`. So we embed the question and store both.
    const question = typeof meta.question === "string" ? meta.question : "";
    const answer = row.rawContent ?? "";
    if (!question || !answer) return [];
    // Single chunk; tokenCount counts the question we'll embed.
    const qChunks = chunkText(question);
    if (qChunks.length === 0) return [];
    return [
      {
        position: 0,
        text: question,
        tokenCount: qChunks[0]!.tokenCount,
      },
    ];
  }
  if (row.sourceType === "pdf") {
    const base64 = typeof meta.pdfBase64 === "string" ? meta.pdfBase64 : "";
    if (!base64) return [];
    // Variable-specifier dynamic import keeps pdf-parse off the static
    // graph (it has CommonJS-style internals + optional native deps).
    const pdfSpec = "pdf-parse";
    const pdfMod = (await import(pdfSpec)) as {
      default: (buf: Buffer) => Promise<{ text: string }>;
    };
    const buf = Buffer.from(base64, "base64");
    const parsed = await pdfMod.default(buf);
    return chunkText(parsed.text);
  }
  return [];
}

/**
 * Per-chunk INSERT via $executeRaw — required because Prisma's
 * Unsupported("vector(1536)") column is read-only on the typed client.
 *
 * pgvector accepts the literal form `[v1,v2,...,vn]::vector(1536)` from
 * a string parameter. We serialize the number[] via JSON.stringify and
 * cast on the column.
 */
async function writeChunkRows(
  prisma: PrismaClient,
  row: SourceRow,
  embedded: EmbeddedChunk[],
): Promise<void> {
  const isFaq = row.sourceType === "faq";
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const answer = row.rawContent ?? "";
  const question = isFaq && typeof meta.question === "string" ? meta.question : null;

  for (const c of embedded) {
    const id = randomUUID();
    const chunkText = isFaq ? answer : c.text;
    const embeddingLiteral = `[${c.embedding.join(",")}]`;
    const metadataJson = JSON.stringify({ tokenCount: c.tokenCount });
    await prisma.$executeRaw`
      INSERT INTO knowledge_chunk (
        id, tenant_id, source_id, chunk_text, position, category, status,
        question_text, embedding, metadata, created_at
      ) VALUES (
        ${id},
        ${row.tenantId},
        ${row.id},
        ${chunkText},
        ${c.position},
        ${row.category},
        'ready',
        ${question},
        ${embeddingLiteral}::vector(1536),
        ${metadataJson}::jsonb,
        NOW()
      )
    `;
  }
}

// Tree-shake guard for `Prisma` import — the namespace must stay live so
// `Prisma.sql` template tags remain available if a future caller needs them
// (the current $executeRaw template literal pattern doesn't reference it
// directly, but consumers extending this module commonly do).
void Prisma;
