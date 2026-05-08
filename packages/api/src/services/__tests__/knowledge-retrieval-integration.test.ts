/**
 * KAN-828 sub-cohort 4 — Integration tests for the retrieval service's
 * Brain → Shaper handoff via Redis cache + cross-tenant safety.
 *
 * The two assertions Fred flagged as load-bearing for this ticket:
 *
 *   1. **Cache-hit handoff** — Brain's call (first) MISSes the cache, embeds
 *      via OpenAI, queries pgvector, emits audit, writes to cache. Shaper's
 *      call (second, within TTL) HITs the cache, returns cached chunks
 *      WITHOUT re-embedding, WITHOUT re-querying pgvector, WITHOUT re-emitting
 *      the audit row. Architectural payoff: exactly 1 embedding call total
 *      across the Brain → Shaper workflow.
 *
 *   2. **Cross-tenant cache isolation** — Brain for tenant A and Shaper for
 *      tenant B produce different cache keys (different tenantId in the
 *      key path) → completely independent results, zero cross-tenant
 *      chunk leakage at the cache layer.
 *
 * These are the canonical regressions to guard against. Future drift where
 * someone moves the audit emit outside the MISS-path branch would silently
 * double-emit, doubling audit log noise + KAN-830 aggregation costs.
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

import { retrieveRelevantChunks } from "../knowledge-retrieval-service.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const DEAL_A = "deal-tenant-a";
const DEAL_B = "deal-tenant-b";
const HAPPY_VEC_A = Array.from({ length: 1536 }, (_, i) => 0.1 + i * 0.0001);
const HAPPY_VEC_B = Array.from({ length: 1536 }, (_, i) => 0.2 + i * 0.0001);

interface MockChunkRow {
  chunk_id: string;
  source_id: string;
  source_title: string | null;
  category: string;
  chunk_text: string;
  score: number;
}

/**
 * State-tracking mock — Redis backed by an in-memory Map so writes are
 * visible to subsequent reads (true cache simulation). Prisma + embedder
 * track call counts for the architectural-payoff assertions.
 */
function makeStatefulMocks(opts: {
  // Per-tenant rows the pgvector query returns (keyed by tenantId so
  // tenant A and tenant B can have disjoint chunks).
  rowsByTenant?: Record<string, MockChunkRow[]>;
}) {
  const cache = new Map<string, string>();
  const redisGet = vi.fn(async (key: string) => cache.get(key) ?? null);
  const redisSet = vi.fn(async (key: string, value: string, _mode: string, _ttl: number) => {
    cache.set(key, value);
    return "OK";
  });
  const redis = { get: redisGet, set: redisSet } as unknown as Redis;

  const queryRawUnsafe = vi.fn(async (...args: unknown[]) => {
    // The retrieval service passes (sql, vectorLiteral, tenantId, topK).
    const tenantId = String(args[2]);
    return opts.rowsByTenant?.[tenantId] ?? [];
  });
  const executeRawUnsafe = vi.fn(async () => 1);
  const sourceCount = vi.fn(async () => 1); // tenant has KB by default
  // KAN-849/XXX — empty-case branch counts KnowledgeSource + FaqEntry +
  // Service; mock all three so the fallback (filtered.length === 0) doesn't
  // TypeError.
  const faqCount = vi.fn(async () => 0);
  const serviceCount = vi.fn(async () => 0);
  const auditLogCreate = vi.fn(async () => ({ id: "audit-1" }));

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

  const openai = {} as OpenAI;
  return {
    prisma,
    redis,
    openai,
    cache,
    redisGet,
    redisSet,
    queryRawUnsafe,
    executeRawUnsafe,
    auditLogCreate,
    $transaction,
  };
}

beforeEach(() => {
  embedMock.mockReset();
});

// ─────────────────────────────────────────────
// 1. Brain → Shaper handoff: exactly 1 embed + 1 pgvector + 1 audit total
// ─────────────────────────────────────────────

describe("KAN-828 integration — Brain → Shaper cache-hit handoff", () => {
  it("first call (Brain) MISSes; second call (Shaper) HITs — exactly 1 embed + 1 pgvector + 1 audit across both", async () => {
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC_A },
    ]);
    const mocks = makeStatefulMocks({
      rowsByTenant: {
        [TENANT_A]: [
          {
            chunk_id: "c1",
            source_id: "s1",
            source_title: "Knowledge Doc",
            category: "faq",
            chunk_text: "verbatim chunk content",
            score: 0.91,
          },
        ],
      },
    });

    const queryText = "How does the Knowledge Layer chunk text?";

    // ── Call 1 (Brain) — cache MISS path
    const brainResult = await retrieveRelevantChunks(
      mocks.prisma,
      mocks.redis,
      mocks.openai,
      TENANT_A,
      DEAL_A,
      queryText,
    );
    expect(brainResult.chunks).toHaveLength(1);
    expect(brainResult.chunks[0]!.chunk_id).toBe("c1");

    // Brain side: full MISS-path assertions
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    expect(mocks.cache.size).toBe(1);

    // ── Call 2 (Shaper) — same (tenantId, dealId, queryText) → cache HIT
    const shaperResult = await retrieveRelevantChunks(
      mocks.prisma,
      mocks.redis,
      mocks.openai,
      TENANT_A,
      DEAL_A,
      queryText,
    );
    expect(shaperResult).toEqual(brainResult);

    // ── ARCHITECTURAL PAYOFF — these counters DID NOT increment on the
    //    Shaper call. The cache HIT short-circuits before embed/DB/audit.
    expect(embedMock).toHaveBeenCalledTimes(1); // STILL 1 (no Shaper-side embed)
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1); // STILL 1
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1); // STILL 1 (no double-emit)
    expect(mocks.$transaction).toHaveBeenCalledTimes(1); // STILL 1 (no Shaper-side tx)

    // Redis GET happened twice (once per call); SET happened only on Brain MISS.
    expect(mocks.redisGet).toHaveBeenCalledTimes(2);
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
  });

  it("Shaper call after TTL expiry (cache cleared) → MISSes and re-embeds (defensive)", async () => {
    embedMock.mockResolvedValue([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC_A },
    ]);
    const mocks = makeStatefulMocks({
      rowsByTenant: {
        [TENANT_A]: [
          { chunk_id: "c1", source_id: "s1", source_title: "Doc", category: "faq", chunk_text: "x", score: 0.9 },
        ],
      },
    });

    await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, DEAL_A, "q");
    expect(embedMock).toHaveBeenCalledTimes(1);

    // Simulate TTL expiry — operator-facing equivalent is the 5-min Redis
    // TTL elapsing between Brain and a delayed Shaper invocation (rare;
    // the 1-30s typical handoff stays well within TTL).
    mocks.cache.clear();

    await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, DEAL_A, "q");

    // Both calls re-embedded + re-queried + re-audited (correct behavior
    // when cache is cold).
    expect(embedMock).toHaveBeenCalledTimes(2);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────
// 2. Cross-tenant cache isolation
// ─────────────────────────────────────────────

describe("KAN-828 integration — cross-tenant cache isolation", () => {
  it("tenant A and tenant B produce different cache keys; zero cross-tenant chunk leakage", async () => {
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC_A },
    ]);
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC_B },
    ]);
    const mocks = makeStatefulMocks({
      rowsByTenant: {
        [TENANT_A]: [
          {
            chunk_id: "tenant-a-chunk-1",
            source_id: "tenant-a-source-1",
            source_title: "Tenant A's Doc",
            category: "faq",
            chunk_text: "tenant-A-specific content",
            score: 0.95,
          },
        ],
        [TENANT_B]: [
          {
            chunk_id: "tenant-b-chunk-1",
            source_id: "tenant-b-source-1",
            source_title: "Tenant B's Doc",
            category: "faq",
            chunk_text: "tenant-B-specific content",
            score: 0.92,
          },
        ],
      },
    });

    const sameQueryText = "What does this product do?";

    // Brain for tenant A
    const resultA = await retrieveRelevantChunks(
      mocks.prisma,
      mocks.redis,
      mocks.openai,
      TENANT_A,
      DEAL_A,
      sameQueryText,
    );
    expect(resultA.chunks).toHaveLength(1);
    expect(resultA.chunks[0]!.chunk_id).toBe("tenant-a-chunk-1");
    expect(resultA.chunks[0]!.chunk_text).toBe("tenant-A-specific content");

    // Shaper for tenant B (different tenant, different deal, SAME queryText)
    const resultB = await retrieveRelevantChunks(
      mocks.prisma,
      mocks.redis,
      mocks.openai,
      TENANT_B,
      DEAL_B,
      sameQueryText,
    );
    expect(resultB.chunks).toHaveLength(1);
    expect(resultB.chunks[0]!.chunk_id).toBe("tenant-b-chunk-1");
    expect(resultB.chunks[0]!.chunk_text).toBe("tenant-B-specific content");

    // ── CRITICAL: zero cross-tenant leakage at the cache layer
    expect(resultA.chunks[0]!.chunk_text).not.toContain("tenant-B-specific");
    expect(resultB.chunks[0]!.chunk_text).not.toContain("tenant-A-specific");

    // Both calls were cache MISSes — different cache keys (different tenantId
    // in `kb:retrieval:{tenantId}:{dealId}:{queryHash}`).
    expect(mocks.cache.size).toBe(2);
    const cacheKeys = Array.from(mocks.cache.keys());
    expect(cacheKeys.some((k) => k.includes(TENANT_A))).toBe(true);
    expect(cacheKeys.some((k) => k.includes(TENANT_B))).toBe(true);

    // Both audited independently — each tenant gets its own audit row
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(2);
    const auditTenants = mocks.auditLogCreate.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { tenantId: string } }).data.tenantId,
    );
    expect(auditTenants).toContain(TENANT_A);
    expect(auditTenants).toContain(TENANT_B);

    // Embedder called twice (once per tenant — different MISS-path)
    expect(embedMock).toHaveBeenCalledTimes(2);
    // pgvector queried twice with different tenant_id args — verified via
    // the queryRawUnsafe mock's call arguments (tenantId is positional arg 2).
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(2);
    const tenantArgs = mocks.queryRawUnsafe.mock.calls.map((c: unknown[]) => c[2]);
    expect(tenantArgs).toContain(TENANT_A);
    expect(tenantArgs).toContain(TENANT_B);
  });

  it("tenant A's cache write does NOT leak into tenant B's read with same dealId/queryText", async () => {
    // Edge case: by coincidence two different tenants have a Deal with the
    // same UUID (unlikely but defensive). Same queryText. Cache key MUST
    // differ via tenantId in the path.
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC_A },
    ]);
    embedMock.mockResolvedValueOnce([
      { position: 0, text: "q", tokenCount: 0, embedding: HAPPY_VEC_B },
    ]);
    const mocks = makeStatefulMocks({
      rowsByTenant: {
        [TENANT_A]: [
          { chunk_id: "ax", source_id: "as", source_title: "A", category: "faq", chunk_text: "A-only", score: 0.9 },
        ],
        [TENANT_B]: [
          { chunk_id: "bx", source_id: "bs", source_title: "B", category: "faq", chunk_text: "B-only", score: 0.9 },
        ],
      },
    });

    const sharedDealId = "shared-deal-id-collision";
    const sharedQuery = "same query text";

    const a = await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_A, sharedDealId, sharedQuery);
    const b = await retrieveRelevantChunks(mocks.prisma, mocks.redis, mocks.openai, TENANT_B, sharedDealId, sharedQuery);

    expect(a.chunks[0]!.chunk_text).toBe("A-only");
    expect(b.chunks[0]!.chunk_text).toBe("B-only");
    expect(mocks.cache.size).toBe(2); // distinct cache entries despite shared dealId+query
  });
});
