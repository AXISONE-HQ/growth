/**
 * KAN-828 sub-cohort 1 — knowledge-retrieval-service tests.
 *
 * Covers: cache hit short-circuit, cold-cache embed + pgvector + filter,
 * empty-case differentiation (no KB at all vs no relevant), audit emit
 * (chunk_retrieved unconditional + gap_detected conditional), prompt
 * rendering with sentinel-token field-name pin per KAN-817 pattern.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type OpenAI from "openai";

// Mock the embedder so tests don't call OpenAI for real.
const embedMock = vi.fn();
vi.mock("../knowledge-embedder.js", () => ({
  embed: (...args: unknown[]) => (embedMock as (...a: unknown[]) => unknown)(...args),
}));

import { retrieveRelevantChunks, renderKnowledgeSection, type RetrievalResult } from "../knowledge-retrieval-service.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const DEAL_A = "deal-a";
const HAPPY_VEC = Array.from({ length: 1536 }, () => 0.1);

interface MockChunkRow {
  chunk_id: string;
  source_id: string;
  source_title: string | null;
  category: string;
  chunk_text: string;
  score: number;
}

function makeMocks(opts: {
  cachedResult?: RetrievalResult | null;
  rows?: MockChunkRow[];
  sourceCount?: number;
  /** KAN-849 — empty-case branch counts KnowledgeSource AND FaqEntry. */
  faqCount?: number;
  /** KAN-XXX — and Service too (3-way XOR parent). */
  serviceCount?: number;
  redisFailRead?: boolean;
} = {}) {
  const redisGet = vi.fn(async () => {
    if (opts.redisFailRead) throw new Error("redis down");
    return opts.cachedResult ? JSON.stringify(opts.cachedResult) : null;
  });
  const redisSet = vi.fn(async () => "OK");
  const redis = { get: redisGet, set: redisSet } as unknown as Redis;

  const queryRawUnsafe = vi.fn(async () => opts.rows ?? []);
  const executeRawUnsafe = vi.fn(async () => 1);
  const sourceCount = vi.fn(async () => opts.sourceCount ?? 0);
  const faqCount = vi.fn(async () => opts.faqCount ?? 0);
  const serviceCount = vi.fn(async () => opts.serviceCount ?? 0);
  const auditLogCreate = vi.fn(async () => ({ id: "audit-1" }));
  // The mock tx has the same shape as prisma — the retrieval service calls
  // tx.$executeRawUnsafe + tx.$queryRawUnsafe inside the $transaction cb.
  const txMock = {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
  };
  const $transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(txMock),
  );
  const prisma = {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
    $transaction,
    knowledgeSource: { count: sourceCount },
    faqEntry: { count: faqCount },
    service: { count: serviceCount },
    auditLog: { create: auditLogCreate },
  } as unknown as PrismaClient;

  const openai = {} as OpenAI; // not invoked since embed() is mocked

  return { prisma, redis, openai, redisGet, redisSet, queryRawUnsafe, executeRawUnsafe, sourceCount, faqCount, serviceCount, auditLogCreate, $transaction };
}

beforeEach(() => {
  embedMock.mockReset();
});

describe("knowledge-retrieval-service", () => {
  it("cache HIT — returns cached RetrievalResult without embedding or DB hit", async () => {
    const cached: RetrievalResult = {
      chunks: [
        { chunk_id: "c1", source_id: "s1", source_title: "Doc 1", category: "faq", chunk_text: "cached", score: 0.9 },
      ],
      tenantHasAnyKnowledge: true,
    };
    const mocks = makeMocks({ cachedResult: cached });

    const result = await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, DEAL_A, "test query");

    expect(result).toEqual(cached);
    expect(embedMock).not.toHaveBeenCalled();
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("cache MISS happy path — embeds, queries pgvector, filters, audits, caches", async () => {
    embedMock.mockResolvedValueOnce([{ position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC }]);
    const mocks = makeMocks({
      rows: [
        { chunk_id: "c1", source_id: "s1", source_title: "Knowledge Doc", category: "faq", chunk_text: "verbatim", score: 0.85 },
        { chunk_id: "c2", source_id: "s1", source_title: "Knowledge Doc", category: "faq", chunk_text: "second", score: 0.7 },
        { chunk_id: "c3", source_id: "s1", source_title: "Knowledge Doc", category: "faq", chunk_text: "below threshold", score: 0.4 },
      ],
    });

    const result = await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, DEAL_A, "How does X work?");

    // Default minScore=0.6 filters out the 0.4 chunk; topK=3 returns all three by default.
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]!.chunk_id).toBe("c1");
    expect(result.chunks[1]!.chunk_id).toBe("c2");
    expect(result.tenantHasAnyKnowledge).toBe(true);
    expect(embedMock).toHaveBeenCalledOnce();
    // SET LOCAL hnsw.ef_search must run inside the same $transaction as the
    // cosine query; outside a tx PG silently no-ops the SET LOCAL. Verifies
    // both the SET command AND the transactional wrap.
    expect(mocks.$transaction).toHaveBeenCalledOnce();
    expect(mocks.executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("hnsw.ef_search = 40"));
    expect(mocks.queryRawUnsafe).toHaveBeenCalledOnce();
    // chunk_retrieved audit fired with chunk_ids + scores
    expect(mocks.auditLogCreate).toHaveBeenCalledOnce();
    const auditArgs = mocks.auditLogCreate.mock.calls[0]![0] as { data: { actionType: string; payload: Record<string, unknown> } };
    expect(auditArgs.data.actionType).toBe("knowledge.chunk_retrieved");
    expect(auditArgs.data.payload.chunkIds).toEqual(["c1", "c2"]);
    // Result cached
    expect(mocks.redisSet).toHaveBeenCalledOnce();
    expect(mocks.redisSet.mock.calls[0]![3]).toBe(300); // TTL 5 min
  });

  it("empty result + tenant has KB → tenantHasAnyKnowledge=true + gap_detected audit", async () => {
    embedMock.mockResolvedValueOnce([{ position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC }]);
    const mocks = makeMocks({
      rows: [
        { chunk_id: "c1", source_id: "s1", source_title: null, category: "faq", chunk_text: "irrelevant", score: 0.4 },
      ],
      sourceCount: 5, // tenant has 5 KB sources
    });

    const result = await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, DEAL_A, "obscure query");

    expect(result.chunks).toHaveLength(0);
    expect(result.tenantHasAnyKnowledge).toBe(true);
    // Two audit calls: chunk_retrieved (with empty chunkIds) + gap_detected
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(2);
    const types = mocks.auditLogCreate.mock.calls.map((c: unknown[]) => (c[0] as { data: { actionType: string } }).data.actionType);
    expect(types).toContain("knowledge.chunk_retrieved");
    expect(types).toContain("knowledge.gap_detected");
  });

  it("empty result + no KB at all → tenantHasAnyKnowledge=false + NO gap_detected audit", async () => {
    embedMock.mockResolvedValueOnce([{ position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC }]);
    const mocks = makeMocks({
      rows: [],
      sourceCount: 0, // tenant has zero KB sources
    });

    const result = await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, DEAL_A, "anything");

    expect(result.chunks).toHaveLength(0);
    expect(result.tenantHasAnyKnowledge).toBe(false);
    // Only chunk_retrieved fires; gap_detected suppressed (not a "gap" if there's no KB)
    expect(mocks.auditLogCreate).toHaveBeenCalledOnce();
    const auditArgs = mocks.auditLogCreate.mock.calls[0]![0] as { data: { actionType: string } };
    expect(auditArgs.data.actionType).toBe("knowledge.chunk_retrieved");
  });

  it("Redis read failure → falls through to live retrieval (correctness preserved)", async () => {
    embedMock.mockResolvedValueOnce([{ position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC }]);
    const mocks = makeMocks({
      redisFailRead: true,
      rows: [
        { chunk_id: "c1", source_id: "s1", source_title: "Doc", category: "faq", chunk_text: "live", score: 0.9 },
      ],
    });

    const result = await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, DEAL_A, "q");

    // Live path executed despite redis read failure
    expect(result.chunks).toHaveLength(1);
    expect(embedMock).toHaveBeenCalledOnce();
    expect(mocks.queryRawUnsafe).toHaveBeenCalledOnce();
  });

  it("empty queryText → short-circuits to {chunks: [], tenantHasAnyKnowledge: false} without embed/DB", async () => {
    const mocks = makeMocks();

    const result = await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, DEAL_A, "   \n  ");

    expect(result).toEqual({ chunks: [], tenantHasAnyKnowledge: false });
    expect(embedMock).not.toHaveBeenCalled();
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// renderKnowledgeSection — sentinel-token field-name pins per KAN-817 pattern
// ─────────────────────────────────────────────

describe("renderKnowledgeSection — prompt assembly", () => {
  it("Sentinel-token pin — chunk_text + source_title appear verbatim in rendered prompt", () => {
    const sentinelTitle = "KAN-828-pin-source-token-abc123";
    const sentinelText = "KAN-828-pin-chunk-token-xyz789 — proves verbatim flow into prompt.";
    const result: RetrievalResult = {
      chunks: [
        {
          chunk_id: "c1",
          source_id: "s1",
          source_title: sentinelTitle,
          category: "faq",
          chunk_text: sentinelText,
          score: 0.92,
        },
      ],
      tenantHasAnyKnowledge: true,
    };
    const rendered = renderKnowledgeSection(result);
    expect(rendered).toContain(sentinelTitle);
    expect(rendered).toContain(sentinelText);
    expect(rendered).toContain("score 0.92");
    expect(rendered).toContain("(faq)");
  });

  it("empty + tenant has no KB → '(none — no company knowledge configured yet)' verbatim", () => {
    const rendered = renderKnowledgeSection({ chunks: [], tenantHasAnyKnowledge: false });
    expect(rendered).toBe("(none — no company knowledge configured yet)");
  });

  it("empty + tenant has KB → '(none relevant to this message)' verbatim", () => {
    const rendered = renderKnowledgeSection({ chunks: [], tenantHasAnyKnowledge: true });
    expect(rendered).toBe("(none relevant to this message)");
  });

  it("multi-chunk render — sorted by score descending, ascending positions, 400-char per-chunk truncation", () => {
    const longText = "A".repeat(500);
    const result: RetrievalResult = {
      chunks: [
        { chunk_id: "c1", source_id: "s1", source_title: "Low", category: "faq", chunk_text: "low score", score: 0.65 },
        { chunk_id: "c2", source_id: "s1", source_title: "High", category: "warranty", chunk_text: longText, score: 0.95 },
      ],
      tenantHasAnyKnowledge: true,
    };
    const rendered = renderKnowledgeSection(result);
    // High-score chunk listed first
    const idxHigh = rendered.indexOf("[High]");
    const idxLow = rendered.indexOf("[Low]");
    expect(idxHigh).toBeGreaterThan(-1);
    expect(idxLow).toBeGreaterThan(-1);
    expect(idxHigh).toBeLessThan(idxLow);
    // 400-char truncation applied
    expect(rendered).toContain("A".repeat(400));
    expect(rendered).not.toContain("A".repeat(401));
  });

  it("untitled source → '(untitled source)' fallback in rendered line", () => {
    const result: RetrievalResult = {
      chunks: [
        { chunk_id: "c1", source_id: "s1", source_title: null, category: "other", chunk_text: "x", score: 0.9 },
      ],
      tenantHasAnyKnowledge: true,
    };
    const rendered = renderKnowledgeSection(result);
    expect(rendered).toContain("[(untitled source)]");
  });
});

// ─────────────────────────────────────────────
// KAN-XXX — FAQ entries surface in retrieval (Option i: LEFT JOIN both parents)
// ─────────────────────────────────────────────

describe("KAN-XXX — FAQ entry retrieval", () => {
  it("FAQ chunk surfaces with parentType='faq' and source_title=question text", async () => {
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC },
    ]);
    // Simulate the SQL row shape the service maps from: parent_type='faq',
    // source_id NULL, faq_entry_id set, source_title COALESCEd from the
    // FAQ entry's question text.
    const mocks = makeMocks({
      rows: [
        {
          chunk_id: "fc1",
          source_id: null as unknown as string, // SQL returns NULL for FAQ chunks
          source_title: "What's the warranty?",
          category: "faq",
          chunk_text: "Five years parts and labor.",
          score: 0.92,
          // Extra fields the service projects from the SQL — pass them through
          // via type cast to avoid expanding the test fixture interface.
          ...({
            faq_entry_id: "f1",
            parent_type: "faq",
          } as object),
        } as MockChunkRow,
      ],
    });

    const result = await retrieveRelevantChunks(
      mocks.prisma,
      mocks.redis,
      mocks.openai,
      TENANT_A,
      DEAL_A,
      "How long is the warranty?",
    );

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.parentType).toBe("faq");
    expect(result.chunks[0]!.faq_entry_id).toBe("f1");
    expect(result.chunks[0]!.source_id).toBeNull();
    expect(result.chunks[0]!.source_title).toBe("What's the warranty?");
  });

  it("empty filtered + zero KnowledgeSource + non-zero FaqEntry → tenantHasAnyKnowledge=true", async () => {
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC },
    ]);
    // No rows from pgvector, but the tenant has FAQ entries — empty-case
    // branch should distinguish "no relevant chunks" from "no KB at all".
    const mocks = makeMocks({ rows: [], sourceCount: 0, faqCount: 3 });

    const result = await retrieveRelevantChunks(
      mocks.prisma,
      mocks.redis,
      mocks.openai,
      TENANT_A,
      DEAL_A,
      "anything",
    );

    expect(result.chunks).toHaveLength(0);
    expect(result.tenantHasAnyKnowledge).toBe(true);
    expect(mocks.faqCount).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// KAN-XXX — Service entries surface in retrieval (3-way LEFT JOIN)
// ─────────────────────────────────────────────

describe("KAN-XXX — Service entry retrieval", () => {
  it("Service chunk surfaces with parentType='service' + COALESCEd source_title from service.title", async () => {
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC },
    ]);
    // Simulate the SQL row shape: parent_type='service', source_id +
    // faq_entry_id NULL, service_id set, source_title COALESCEd from
    // service.title.
    const mocks = makeMocks({
      rows: [
        {
          chunk_id: "sc1",
          source_id: null as unknown as string,
          source_title: "Senior Mentorship",
          category: "service",
          chunk_text: "Service: Senior Mentorship\n\nDescription: ...",
          score: 0.93,
          ...({
            faq_entry_id: null,
            service_id: "svc-1",
            parent_type: "service",
          } as object),
        } as MockChunkRow,
      ],
    });

    const result = await retrieveRelevantChunks(
      mocks.prisma,
      mocks.redis,
      mocks.openai,
      TENANT_A,
      DEAL_A,
      "Do you offer mentorship?",
    );

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.parentType).toBe("service");
    expect(result.chunks[0]!.service_id).toBe("svc-1");
    expect(result.chunks[0]!.source_id).toBeNull();
    expect(result.chunks[0]!.faq_entry_id).toBeNull();
    expect(result.chunks[0]!.source_title).toBe("Senior Mentorship");
  });

  it("empty filtered + zero sources + zero faqs + non-zero services → tenantHasAnyKnowledge=true", async () => {
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC },
    ]);
    const mocks = makeMocks({
      rows: [],
      sourceCount: 0,
      faqCount: 0,
      serviceCount: 2,
    });

    const result = await retrieveRelevantChunks(
      mocks.prisma,
      mocks.redis,
      mocks.openai,
      TENANT_A,
      DEAL_A,
      "anything",
    );

    expect(result.chunks).toHaveLength(0);
    expect(result.tenantHasAnyKnowledge).toBe(true);
    expect(mocks.serviceCount).toHaveBeenCalled();
  });
});
