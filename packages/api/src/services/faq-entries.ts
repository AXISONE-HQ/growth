/**
 * KAN-XXX — FAQ entries service.
 *
 * FAQ entries as first-class entities (their own table; supersedes the
 * FAQ-via-KnowledgeSource path that broke the multi-pair contract per
 * KAN-841). Each entry produces exactly one KnowledgeChunk linked via the
 * polymorphic `faqEntryId` parent FK; the embedder runs SYNCHRONOUSLY on
 * create/update so the operator gets a deterministic ready state on POST.
 *
 * **Synchronous embedding rationale:**
 * FAQ entries are short (Q + A capped at 2k + 10k chars) — well under one
 * 500-token chunk. Single embed() call ≈ 150-300ms. Sync flow gives the
 * admin UI a deterministic "ready" status without polling, no Pub/Sub
 * topic, no worker. PDFs and pasted text remain async (Pub/Sub → worker)
 * because they can produce 100+ chunks.
 *
 * **XOR parent invariant:**
 * KnowledgeChunk has `(source_id IS NULL) <> (faq_entry_id IS NULL)` as a
 * DB-layer CHECK constraint. This service only writes chunks with
 * `source_id=NULL, faq_entry_id=<id>` — sibling source-side writes in
 * `knowledge-ingestion-service.ts` only ever set the inverse. The DB enforces
 * the invariant regardless of app drift.
 *
 * **Tenant safety:** every read/write filters explicitly on `tenantId`;
 * the Prisma middleware in `packages/db/src/middleware/tenant.ts` provides
 * defense-in-depth on the typed-client paths. $executeRaw paths bind the
 * tenant ID via parameterized $N substitution (no string concat).
 */
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { embed, EmbeddingFailedError } from "./knowledge-embedder.js";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export interface FaqEntryRow {
  id: string;
  tenantId: string;
  question: string;
  answer: string;
  status: "queued" | "embedding" | "ready" | "error";
  errorDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListFaqEntriesOptions {
  /** Skip count (pagination). Default 0. */
  offset?: number;
  /** Page size. Default 50, capped at 200. */
  limit?: number;
}

export interface CreateFaqEntryInput {
  question: string;
  answer: string;
}

export interface UpdateFaqEntryInput {
  question?: string;
  answer?: string;
}

// ─────────────────────────────────────────────
// Cast-loose Prisma access — same posture as knowledge-ingestion-service.ts
// (KAN-826 cohort discipline; the typed delegates exist post-this-cohort
// but the cross-rootDir TS noise is tactical until KAN-689 lands).
// ─────────────────────────────────────────────

interface FaqEntryDelegate {
  findMany: (args: {
    where: Record<string, unknown>;
    orderBy: Record<string, unknown>;
    skip?: number;
    take?: number;
    select?: Record<string, unknown>;
  }) => Promise<FaqEntryRow[]>;
  findFirst: (args: {
    where: Record<string, unknown>;
    select?: Record<string, unknown>;
  }) => Promise<FaqEntryRow | null>;
  create: (args: {
    data: Record<string, unknown>;
  }) => Promise<FaqEntryRow>;
  update: (args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => Promise<FaqEntryRow>;
  count: (args: { where: Record<string, unknown> }) => Promise<number>;
}

interface KnowledgeChunkDelegate {
  deleteMany: (args: {
    where: { faqEntryId: string };
  }) => Promise<{ count: number }>;
}

function delegates(prisma: PrismaClient): {
  faq: FaqEntryDelegate;
  chunk: KnowledgeChunkDelegate;
} {
  const cast = prisma as unknown as {
    faqEntry: FaqEntryDelegate;
    knowledgeChunk: KnowledgeChunkDelegate;
  };
  return { faq: cast.faqEntry, chunk: cast.knowledgeChunk };
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const QUESTION_MAX_CHARS = 2_000;
const ANSWER_MAX_CHARS = 10_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * List non-deleted FAQ entries for the tenant. Newest first.
 */
export async function listFaqEntries(
  prisma: PrismaClient,
  tenantId: string,
  options: ListFaqEntriesOptions = {},
): Promise<FaqEntryRow[]> {
  const { faq } = delegates(prisma);
  const limit = Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  return faq.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    skip: options.offset ?? 0,
    take: limit,
  });
}

/**
 * Fetch a single non-deleted FAQ entry; returns null on not-found OR
 * cross-tenant probe (tenantId scoping forces 404 for both).
 */
export async function getFaqEntry(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<FaqEntryRow | null> {
  const { faq } = delegates(prisma);
  return faq.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
}

/**
 * Create a FAQ entry + synchronously embed the Q+A pair into a single
 * KnowledgeChunk. Throws on validation failure or terminal embed failure;
 * the row is left in `status='error'` with `errorDetail` populated so the
 * admin UI can surface the failure.
 */
export async function createFaqEntry(
  prisma: PrismaClient,
  tenantId: string,
  input: CreateFaqEntryInput,
): Promise<FaqEntryRow> {
  const question = input.question.trim();
  const answer = input.answer.trim();
  validateInputOrThrow(question, answer);

  const { faq } = delegates(prisma);
  const row = await faq.create({
    data: {
      tenantId,
      question,
      answer,
      status: "queued",
    },
  });

  return embedAndFinalize(prisma, row);
}

/**
 * Update a FAQ entry's question/answer. Re-embeds (deletes old chunks,
 * generates a new one) so retrieval surfaces the latest content. Returns
 * the updated row in its terminal status (ready/error).
 */
export async function updateFaqEntry(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
  input: UpdateFaqEntryInput,
): Promise<FaqEntryRow | null> {
  const existing = await getFaqEntry(prisma, tenantId, id);
  if (!existing) return null;

  const nextQuestion = (input.question ?? existing.question).trim();
  const nextAnswer = (input.answer ?? existing.answer).trim();
  // No-op short-circuit: nothing to do if neither field changed.
  if (nextQuestion === existing.question && nextAnswer === existing.answer) {
    return existing;
  }
  validateInputOrThrow(nextQuestion, nextAnswer);

  const { faq } = delegates(prisma);
  const updated = await faq.update({
    where: { id },
    data: {
      question: nextQuestion,
      answer: nextAnswer,
      status: "queued",
      errorDetail: null,
    },
  });

  return embedAndFinalize(prisma, updated);
}

/**
 * Soft-delete a FAQ entry. Marks `deletedAt`; chunks remain in the table
 * but become invisible to retrieval (which JOINs on `deleted_at IS NULL`).
 * Hourly cron hard-deletes after 30 days (mirrors the KnowledgeSource
 * lifecycle). Returns false on not-found or already-deleted; true on
 * successful soft-delete.
 */
export async function deleteFaqEntry(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const existing = await getFaqEntry(prisma, tenantId, id);
  if (!existing) return false;

  const { faq } = delegates(prisma);
  await faq.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return true;
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

function validateInputOrThrow(question: string, answer: string): void {
  if (question.length === 0) {
    throw new FaqValidationError("Question is required.");
  }
  if (question.length > QUESTION_MAX_CHARS) {
    throw new FaqValidationError(
      `Question is too long (max ${QUESTION_MAX_CHARS.toLocaleString()} chars).`,
    );
  }
  if (answer.length === 0) {
    throw new FaqValidationError("Answer is required.");
  }
  if (answer.length > ANSWER_MAX_CHARS) {
    throw new FaqValidationError(
      `Answer is too long (max ${ANSWER_MAX_CHARS.toLocaleString()} chars).`,
    );
  }
}

export class FaqValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaqValidationError";
  }
}

/**
 * Sync embed → chunk write → status finalize. Mirrors the FaqEntry-side of
 * the KnowledgeSource ingestion orchestrator's status machine but stays
 * in-process (no Pub/Sub) because FAQ entries are single-chunk + small.
 */
async function embedAndFinalize(
  prisma: PrismaClient,
  row: FaqEntryRow,
): Promise<FaqEntryRow> {
  const { faq, chunk } = delegates(prisma);

  // Status: queued → embedding (claim the row before embed runs).
  await faq.update({
    where: { id: row.id },
    data: { status: "embedding" },
  });

  try {
    const embedText = `Question: ${row.question}\n\nAnswer: ${row.answer}`;
    const embedded = await embed([
      { position: 0, text: embedText, tokenCount: 0 },
    ]);
    const vec = embedded[0]!.embedding;

    // Atomic: deleteMany old chunks (re-embed path) + INSERT new chunk +
    // UPDATE status='ready'. $executeRaw INSERT is required because the
    // pgvector embedding column is read-only via the typed Prisma client.
    await prisma.$transaction(async (tx) => {
      const txCast = tx as unknown as PrismaClient;
      const txDelegates = delegates(txCast);
      await txDelegates.chunk.deleteMany({ where: { faqEntryId: row.id } });

      const chunkId = randomUUID();
      const embeddingLiteral = `[${vec.join(",")}]`;
      const metadataJson = JSON.stringify({ tokenCount: embedded[0]!.tokenCount });
      await txCast.$executeRaw`
        INSERT INTO knowledge_chunk (
          id, tenant_id, source_id, faq_entry_id, chunk_text, position, category,
          status, question_text, embedding, metadata, created_at
        ) VALUES (
          ${chunkId},
          ${row.tenantId},
          NULL,
          ${row.id},
          ${row.answer},
          0,
          'faq',
          'ready',
          ${row.question},
          ${embeddingLiteral}::vector(1536),
          ${metadataJson}::jsonb,
          NOW()
        )
      `;

      await txDelegates.faq.update({
        where: { id: row.id },
        data: { status: "ready", errorDetail: null },
      });
    });

    return (await faq.findFirst({ where: { id: row.id, tenantId: row.tenantId } }))!;
  } catch (err) {
    const reason =
      err instanceof EmbeddingFailedError
        ? `embedding-failed: ${err.message}`
        : (err as Error)?.message ?? String(err);
    await faq.update({
      where: { id: row.id },
      data: {
        status: "error",
        errorDetail: reason.slice(0, 1000),
      },
    });
    // Best-effort: clean any partial chunks the failed transaction may have
    // produced so a subsequent retry doesn't leave duplicates.
    void chunk.deleteMany({ where: { faqEntryId: row.id } });
    return (await faq.findFirst({ where: { id: row.id, tenantId: row.tenantId } }))!;
  }
}
