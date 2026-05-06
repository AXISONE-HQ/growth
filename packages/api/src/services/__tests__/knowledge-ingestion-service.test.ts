/**
 * KAN-827 sub-cohort 6 — knowledge-ingestion-service orchestrator tests.
 *
 * Mocks chunker + embedder via vi.mock; constructs a minimal Prisma
 * delegate stand-in. Covers: happy-path completion (queued → embedding →
 * ready), already-completed skip, embedding-failure → status='error'.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mock chunker + embedder before importing the orchestrator.
const chunkMock = vi.fn();
const embedMock = vi.fn();

vi.mock("../knowledge-chunker.js", () => ({
  chunk: (...args: unknown[]) => chunkMock(...args),
  DEFAULT_CHUNK_TOKEN_CAP: 500,
  DEFAULT_OVERLAP_TOKENS: 50,
}));
vi.mock("../knowledge-embedder.js", async () => {
  const actual = (await vi.importActual<typeof import("../knowledge-embedder.js")>(
    "../knowledge-embedder.js",
  )) as Record<string, unknown>;
  return {
    ...actual,
    embed: (...args: unknown[]) => embedMock(...args),
  };
});

import { ingestSource } from "../knowledge-ingestion-service.js";

interface MockSourceRow {
  id: string;
  tenantId: string;
  sourceType: string;
  category: string;
  status: string;
  rawContent: string | null;
  metadata: Record<string, unknown>;
}

function makePrismaMock(initialRow: MockSourceRow | null) {
  let row = initialRow ? { ...initialRow } : null;
  const findUnique = vi.fn(async () => row);
  const sourceUpdate = vi.fn(async (args: { data: Partial<MockSourceRow> }) => {
    if (row) Object.assign(row, args.data);
    return { id: row?.id ?? "" };
  });
  const chunkDeleteMany = vi.fn(async () => ({ count: 0 }));
  const executeRawCalls: unknown[][] = [];

  const prisma = {
    knowledgeSource: { findUnique, update: sourceUpdate },
    knowledgeChunk: { deleteMany: chunkDeleteMany },
    $executeRaw: vi.fn(async (...args: unknown[]) => {
      executeRawCalls.push(args);
      return 1;
    }),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      // Pass the same mock through — tests aren't asserting tx isolation.
      return cb(prisma);
    }),
  } as unknown as PrismaClient;

  return { prisma, findUnique, sourceUpdate, chunkDeleteMany, executeRawCalls, getRow: () => row };
}

beforeEach(() => {
  chunkMock.mockReset();
  embedMock.mockReset();
});

describe("knowledge-ingestion-service", () => {
  it("happy path — queued paste_text → chunk → embed → write rows → status=ready", async () => {
    const mock = makePrismaMock({
      id: "src-1",
      tenantId: "tenant-a",
      sourceType: "paste_text",
      category: "faq",
      status: "queued",
      rawContent: "Some FAQ content for chunking.",
      metadata: {},
    });
    chunkMock.mockReturnValue([
      { position: 0, text: "chunk-0", tokenCount: 4 },
      { position: 1, text: "chunk-1", tokenCount: 5 },
    ]);
    embedMock.mockResolvedValue([
      { position: 0, text: "chunk-0", tokenCount: 4, embedding: Array(1536).fill(0.1) },
      { position: 1, text: "chunk-1", tokenCount: 5, embedding: Array(1536).fill(0.2) },
    ]);

    const result = await ingestSource(mock.prisma, "src-1");

    expect(result).toEqual({ type: "completed", sourceId: "src-1", chunksWritten: 2 });
    // Status transitioned: queued → embedding (claim) → ready (commit).
    const statusUpdates = mock.sourceUpdate.mock.calls.map((c: unknown[]) => (c[0] as { data: { status?: string } }).data.status);
    expect(statusUpdates).toEqual(["embedding", "ready"]);
    // 2 chunks written via $executeRaw.
    expect(mock.executeRawCalls).toHaveLength(2);
  });

  it("idempotent skip — status=ready on row → returns skipped without re-embedding", async () => {
    const mock = makePrismaMock({
      id: "src-2",
      tenantId: "tenant-a",
      sourceType: "paste_text",
      category: "faq",
      status: "ready",
      rawContent: "already processed",
      metadata: {},
    });

    const result = await ingestSource(mock.prisma, "src-2");

    expect(result).toEqual({ type: "skipped", sourceId: "src-2", reason: "status-already-ready" });
    expect(mock.sourceUpdate).not.toHaveBeenCalled();
    expect(chunkMock).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("embedding failure → status=error with errorDetail; chunks not written", async () => {
    const mock = makePrismaMock({
      id: "src-3",
      tenantId: "tenant-a",
      sourceType: "paste_text",
      category: "warranty",
      status: "queued",
      rawContent: "doomed content",
      metadata: {},
    });
    chunkMock.mockReturnValue([{ position: 0, text: "x", tokenCount: 1 }]);
    embedMock.mockRejectedValue(new Error("OpenAI down"));

    const result = await ingestSource(mock.prisma, "src-3");

    expect(result.type).toBe("failed");
    // Final status is 'error' with non-null errorDetail.
    const lastUpdate = mock.sourceUpdate.mock.calls.at(-1)![0] as { data: { status: string; errorDetail: string } };
    expect(lastUpdate.data.status).toBe("error");
    expect(lastUpdate.data.errorDetail).toContain("OpenAI down");
    expect(mock.executeRawCalls).toHaveLength(0);
  });

  it("source not found → returns skipped without writes", async () => {
    const mock = makePrismaMock(null);
    const result = await ingestSource(mock.prisma, "src-missing");
    expect(result).toEqual({ type: "skipped", sourceId: "src-missing", reason: "source-not-found" });
    expect(mock.sourceUpdate).not.toHaveBeenCalled();
  });

  it("FAQ path — embeds question, stores answer in chunk_text + question on row", async () => {
    const mock = makePrismaMock({
      id: "src-faq",
      tenantId: "tenant-a",
      sourceType: "faq",
      category: "faq",
      status: "queued",
      rawContent: "Yes, refunds are honored within 30 days.",
      metadata: { question: "What is your refund policy?" },
    });
    // For FAQ, chunker is called with the question text; orchestrator
    // synthesizes a single chunk with the question as text.
    chunkMock.mockReturnValue([{ position: 0, text: "What is your refund policy?", tokenCount: 7 }]);
    embedMock.mockResolvedValue([
      {
        position: 0,
        text: "What is your refund policy?",
        tokenCount: 7,
        embedding: Array(1536).fill(0.5),
      },
    ]);

    const result = await ingestSource(mock.prisma, "src-faq");

    expect(result.type).toBe("completed");
    expect(mock.executeRawCalls).toHaveLength(1);
  });
});
