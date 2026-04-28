/**
 * KAN-707 PR B — Worker run handler (extracted for testability).
 *
 * Pure orchestration: reads the ingestion row, idempotency-checks, dispatches
 * to the right path handler, embeds chunks via OpenAI, writes to the DB,
 * transitions status. All external deps (prisma, fetcher, downloadFile,
 * embedFn) are injected so unit tests can stub them.
 */
import type { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import { pathHandlers } from "../services/knowledge-paths/index.js";
import type { Chunk } from "../services/knowledge-chunker.js";

const EMBEDDING_MODEL = "text-embedding-3-small" as const;
const EMBEDDING_DIM = 1536;

export interface RunHandlerDeps {
  ingestionId: string;
  prisma: PrismaClient;
  fetcher: typeof globalThis.fetch;
  downloadFile: (gcsRef: string) => Promise<Buffer>;
  /** Optional override for unit tests — defaults to OpenAI text-embedding-3-small. */
  embedFn?: (texts: string[]) => Promise<number[][]>;
}

async function defaultEmbedFn(texts: string[]): Promise<number[][]> {
  const client = new OpenAI();
  const r = await client.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return r.data.map((d) => d.embedding);
}

export async function runHandler(deps: RunHandlerDeps): Promise<number> {
  const { ingestionId, prisma } = deps;
  const embedFn = deps.embedFn ?? defaultEmbedFn;

  // Idempotency guard — re-dispatch under Pub/Sub redelivery becomes a no-op.
  const row = await (prisma as any).knowledgeIngestion?.findUnique({
    where: { id: ingestionId },
    include: { source: true },
  });
  if (!row) {
    console.error(`[worker] ingestionId=${ingestionId} not found in DB`);
    return 1;
  }
  if (row.status === "processing" || row.status === "indexed") {
    console.log(`[worker] ingestionId=${ingestionId} already status=${row.status} — no-op (idempotency)`);
    return 0;
  }

  const source = row.source;
  if (!source) {
    console.error(`[worker] ingestionId=${ingestionId} has no source row`);
    return 1;
  }

  // pending → processing
  await (prisma as any).knowledgeIngestion.update({
    where: { id: ingestionId },
    data: { status: "processing", startedAt: new Date() },
  });
  await (prisma as any).knowledgeSource.update({
    where: { id: source.id },
    data: { status: "processing" },
  });

  try {
    // Reconstruct path-handler input from source columns. The original payload
    // isn't preserved on the DB rows — we re-derive what we need from
    // KnowledgeSource. Q&A originals aren't preserved (privacy: question +
    // answer content lives in KnowledgeChunk, not on the source row).
    let chunks: Chunk[];
    let urlsDiscovered = 0;
    let urlsIndexed = 0;
    const warnings: string[] = [];

    switch (source.type) {
      case "url": {
        const result = await pathHandlers.url(
          {
            path: "url",
            sourceUrl: source.sourceUrl!,
            // V1 ingest stores no separate crawlScope yet; default to "page"
            crawlScope: "page",
          },
          { fetch: deps.fetcher, downloadFile: deps.downloadFile },
        );
        chunks = result.chunks;
        urlsDiscovered = result.urlsDiscovered;
        urlsIndexed = result.urlsIndexed;
        warnings.push(...result.warnings);
        break;
      }
      case "document": {
        const result = await pathHandlers.document(
          {
            path: "document",
            uploadedFileRef: source.uploadedFileRef!,
            originalFileName: source.originalFileName!,
          },
          { fetch: deps.fetcher, downloadFile: deps.downloadFile },
        );
        chunks = result.chunks;
        warnings.push(...result.warnings);
        break;
      }
      case "qa_pair": {
        // Q&A originals aren't preserved on the source row by design (PII —
        // tenant text). Re-running a qa_pair ingestion requires the original
        // payload from the wizard. For idempotent re-runs, the original
        // chunks are still in KnowledgeChunk; PR B's worker doesn't try to
        // re-embed without payload. Surface as a warning + skip.
        const existing = await (prisma as any).knowledgeChunk?.count({ where: { sourceId: source.id } });
        if (existing > 0) {
          warnings.push("qa_pair re-ingest skipped — original payload not retained on source row, existing chunks intact");
          chunks = [];
        } else {
          warnings.push("qa_pair re-run without retained payload — no chunks ingested. KAN-728 follow-up tracks payload retention strategy.");
          chunks = [];
        }
        break;
      }
      default:
        throw new Error(`Unknown source.type: ${source.type}`);
    }

    if (chunks.length > 0) {
      // Embed in batch — text-embedding-3-small accepts up to 2048 inputs per
      // call. Splitting only matters at extreme document sizes.
      const BATCH = 96;
      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH).map((c) => c.content);
        const vectors = await embedFn(batch);
        embeddings.push(...vectors);
      }
      if (embeddings.length !== chunks.length) {
        throw new Error(`Embedding count mismatch: chunks=${chunks.length} embeddings=${embeddings.length}`);
      }
      // Insert chunks. Raw SQL because Prisma doesn't natively support
      // vector(N) insertion via the typed client (KAN-706 used Unsupported).
      // Each row written individually for clarity; bulk insert via $executeRawUnsafe
      // is a perf optimization for KAN-728+ if needed.
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const embeddingLiteral = `[${embeddings[i]!.join(",")}]`;
        await (prisma as any).$executeRawUnsafe(
          `INSERT INTO knowledge_chunks (id, source_id, chunk_index, total_chunks, content, embedding, embedding_model, embedding_version, token_count, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::vector, $6, $7, $8, NOW())`,
          source.id,
          c.index,
          c.total,
          c.content,
          embeddingLiteral,
          EMBEDDING_MODEL,
          `1536-${EMBEDDING_MODEL}`,
          c.tokenCount,
        );
      }
    }

    // processing → indexed
    await (prisma as any).knowledgeIngestion.update({
      where: { id: ingestionId },
      data: {
        status: "indexed",
        completedAt: new Date(),
        urlsDiscovered,
        urlsIndexed,
        errors: warnings.length > 0 ? { warnings } : null,
      },
    });
    await (prisma as any).knowledgeSource.update({
      where: { id: source.id },
      data: { status: "indexed", lastIndexedAt: new Date() },
    });

    console.log(`[worker] ingestionId=${ingestionId} indexed chunks=${chunks.length} warnings=${warnings.length}`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] ingestionId=${ingestionId} FAILED:`, err);
    await (prisma as any).knowledgeIngestion.update({
      where: { id: ingestionId },
      data: { status: "failed", completedAt: new Date(), errors: { error: message } },
    });
    await (prisma as any).knowledgeSource.update({
      where: { id: source.id },
      data: { status: "failed", errorMessage: message },
    });
    return 1;
  }
}
