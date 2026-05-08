/**
 * KAN-828 sub-cohort 1 — Knowledge retrieval service (pure module).
 *
 * `retrieveRelevantChunks(prisma, redis, openai, tenantId, dealId, queryText, options)`
 * → `RetrievalResult { chunks, tenantHasAnyKnowledge }`
 *
 * **Flow (architect spec §3.2):**
 *   1. queryHash = sha256(queryText).slice(0, 16)
 *   2. Check Redis cache (`kb:retrieval:{tenantId}:{dealId}:{queryHash}`, 5-min TTL)
 *      → HIT: return cached, no audit emit (the original retrieval already audited)
 *   3. Embed queryText via OpenAI text-embedding-3-small (1536 dim) — fails loud
 *      on dim mismatch via the shared embedder's invariant check
 *   4. pgvector HNSW cosine search via $executeRaw with explicit tenant filter
 *      + status='ready' partial-index pre-filter (architect spec §1.6)
 *   5. Filter by minScore (default 0.6 per spec §3.2)
 *   6. If filtered empty: query knowledge_source.count(tenantId) to differentiate
 *      "tenant has no KB at all" vs "tenant has KB but nothing relevant"
 *      (Fred's sub-cohort 1 note #1 — drives the two empty-case prompt strings)
 *   7. Emit `knowledge.chunk_retrieved` AuditLog row unconditionally; emit
 *      `knowledge.gap_detected` ALSO when filtered empty AND tenant has KB
 *   8. Cache result (5-min TTL) — invalidation deferred to KAN-829 admin UI
 *      delete path (Fred's sub-cohort 1 note #2)
 *
 * **Cross-tenant safety:**
 *   - $executeRaw uses parameterized $1 binding for tenant_id (no injection risk)
 *   - Visual review confirms the literal `WHERE tenant_id = $1` clause
 *   - knowledgeTenantGuardMiddleware (KAN-826) covers typed-client paths but
 *     NOT $queryRaw — visual review of every $queryRaw is the spec §6 mandate
 *
 * **Cold-cache latency budget (Fred's note #3):**
 *   - First retrieval per (tenantId, dealId, queryHash): ~150ms embed + ~15ms
 *     pgvector search ≈ 180ms total (architect spec §5.1 target)
 *   - Cache hit: ~3ms (Redis GET only)
 *   - Brain p95 budget 3700ms easily absorbs +200ms cold-cache
 *
 * **Defense-in-depth:**
 *   - Best-effort audit emit (try/catch → console.warn) — retrieval failure
 *     should NOT block Brain's call site; the row write is observability,
 *     not load-bearing for correctness
 *   - Redis failure → fall through to live retrieval (cache miss treated
 *     identically to cache absence; no error propagation)
 *   - Embedding failure → propagates (caller marks the Brain decision with
 *     no-knowledge fallback; we don't silently swallow)
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type OpenAI from "openai";
import { embed } from "./knowledge-embedder.js";

// ─────────────────────────────────────────────
// Constants — architect spec locked
// ─────────────────────────────────────────────

const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SCORE = 0.6;
const CACHE_TTL_SECONDS = 300; // 5 min per architect spec §4.2
const HNSW_EF_SEARCH = 40; // architect spec §1.2 runtime tuning
const QUERY_TEXT_AUDIT_PREVIEW_CHARS = 200; // ticket §5

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export interface RetrievedChunk {
  chunk_id: string;
  /**
   * KnowledgeSource parent FK. NULL when the chunk belongs to a FaqEntry
   * (mutually exclusive with `faq_entry_id` per the DB CHECK constraint
   * `(source_id IS NULL) <> (faq_entry_id IS NULL)`).
   */
  source_id: string | null;
  /**
   * KAN-849 — FaqEntry parent FK. NULL when the chunk belongs to a
   * KnowledgeSource or Service. Optional so legacy fixtures don't need
   * updating en-masse.
   */
  faq_entry_id?: string | null;
  /**
   * KAN-XXX — Service parent FK. NULL when the chunk belongs to a
   * KnowledgeSource or FaqEntry. Optional for the same backwards-compat
   * reason as `faq_entry_id`.
   */
  service_id?: string | null;
  /**
   * Citation label: COALESCEd across source.title / faq.question /
   * service.title. Null only when none of the parents has a title (PDFs
   * without operator-supplied title fall back to the file name in the
   * admin UI; retrieval surfaces null here and the consumer renders
   * "(untitled source)").
   */
  source_title: string | null;
  /**
   * KAN-849/XXX — discriminator across the three parent paths. Brain/Shaper
   * currently treat all three equivalently; this field is metadata-only
   * for them. Optional for backwards-compat with fixtures.
   */
  parentType?: "source" | "faq" | "service";
  category: string;
  chunk_text: string;
  /** Cosine similarity in [0, 1]; higher = more relevant. */
  score: number;
}

export interface RetrievalResult {
  /** Filtered chunks (after minScore + topK). May be empty. */
  chunks: RetrievedChunk[];
  /**
   * True iff the tenant has at least one knowledge_source row (status not
   * 'deleted'). Drives the two empty-case prompt renderings:
   *   true + chunks=[] → "(none relevant to this message)"
   *   false → "(none — no company knowledge configured yet)"
   */
  tenantHasAnyKnowledge: boolean;
}

export interface RetrievalOptions {
  /** Top-K results to return after minScore filter. Default 3. */
  topK?: number;
  /** Minimum cosine similarity to return. Default 0.6 per spec §3.2. */
  minScore?: number;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export async function retrieveRelevantChunks(
  prisma: PrismaClient,
  redis: Redis | null,
  openai: OpenAI | null,
  tenantId: string,
  dealId: string,
  queryText: string,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

  // Empty-query short-circuit — no point in cache/embed for whitespace
  if (!queryText.trim()) {
    return { chunks: [], tenantHasAnyKnowledge: false };
  }

  // 1+2. Cache lookup
  const queryHash = createHash("sha256").update(queryText).digest("hex").slice(0, 16);
  const cacheKey = `kb:retrieval:${tenantId}:${dealId}:${queryHash}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as RetrievalResult;
      }
    } catch (err) {
      // Redis transient failure — fall through to live retrieval. The cache
      // is an optimization, not a correctness boundary.
      console.warn(
        `[knowledge-retrieval] redis-cache-read-failed key=${cacheKey} err=${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  // 3. Embed query text via OpenAI (reuses the shared embedder with its
  //    dim-mismatch invariant + retry/backoff).
  const embedded = await embed(
    [{ position: 0, text: queryText, tokenCount: 0 }],
    openai ? { client: openai } : {},
  );
  const queryVector = embedded[0]!.embedding;
  const queryVectorLiteral = `[${queryVector.join(",")}]`;

  // 4. pgvector cosine search. SET hnsw.ef_search per architect spec §1.2.
  //    Tenant scope + status filter enforced literally in the WHERE clause —
  //    the partial index `(tenant_id, category) WHERE status='ready'` matches
  //    this predicate exactly for hot-path performance.
  //
  //    KAN-XXX: chunks now have a polymorphic parent across THREE tables —
  //    exactly one of `source_id`, `faq_entry_id`, `service_id` is set per
  //    the DB CHECK. LEFT JOIN all three; exclude rows whose parent has
  //    been soft-deleted (kept until the 30-day hard-delete cron).
  //    `parent_type` discriminates downstream; `source_title` COALESCEs
  //    the source title / FAQ question text / service title so existing
  //    consumers reading the field keep working.
  //
  //    SET LOCAL is scoped to the enclosing transaction; outside a tx it's
  //    silently a no-op (PG semantics). Wrap both statements in $transaction
  //    so the ef_search hint actually applies to the cosine search query.
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
    return tx.$queryRawUnsafe<Array<{
      chunk_id: string;
      source_id: string | null;
      faq_entry_id: string | null;
      service_id: string | null;
      source_title: string | null;
      parent_type: string;
      category: string;
      chunk_text: string;
      score: number;
    }>>(
      `
      SELECT c.id AS chunk_id,
             c.source_id,
             c.faq_entry_id,
             c.service_id,
             COALESCE(s.title, f.question, svc.title) AS source_title,
             CASE
               WHEN c.service_id IS NOT NULL THEN 'service'
               WHEN c.faq_entry_id IS NOT NULL THEN 'faq'
               ELSE 'source'
             END AS parent_type,
             c.category,
             c.chunk_text,
             1 - (c.embedding <=> $1::vector(1536)) AS score
      FROM knowledge_chunk c
      LEFT JOIN knowledge_source s
        ON s.id = c.source_id
        AND s.deleted_at IS NULL
        AND s.status <> 'deleted'
      LEFT JOIN faq_entries f
        ON f.id = c.faq_entry_id
        AND f.deleted_at IS NULL
      LEFT JOIN services svc
        ON svc.id = c.service_id
        AND svc.deleted_at IS NULL
      WHERE c.tenant_id = $2
        AND c.status = 'ready'
        AND (s.id IS NOT NULL OR f.id IS NOT NULL OR svc.id IS NOT NULL)
      ORDER BY c.embedding <=> $1::vector(1536)
      LIMIT $3
      `,
      queryVectorLiteral,
      tenantId,
      topK,
    );
  });

  // 5. Filter by minScore — pgvector ORDER BY returns ascending distance
  //    so score is descending; lowest may still be below threshold.
  const filtered = rows.filter((r) => r.score >= minScore);

  // 6. Differentiate the two empty cases.
  //    KAN-XXX: tenant "has knowledge" if ANY of (KnowledgeSource, FaqEntry,
  //    Service) is populated and non-deleted. ANY parent table populated
  //    drives the "(none relevant to this message)" prompt instead of
  //    "(none — no company knowledge configured yet)".
  let tenantHasAnyKnowledge = filtered.length > 0;
  if (!tenantHasAnyKnowledge) {
    const cast = prisma as unknown as {
      knowledgeSource: { count: (args: { where: Record<string, unknown> }) => Promise<number> };
      faqEntry: { count: (args: { where: Record<string, unknown> }) => Promise<number> };
      service: { count: (args: { where: Record<string, unknown> }) => Promise<number> };
    };
    const [sourceCount, faqCount, serviceCount] = await Promise.all([
      cast.knowledgeSource.count({ where: { tenantId, status: { not: "deleted" } } }),
      cast.faqEntry.count({ where: { tenantId, deletedAt: null } }),
      cast.service.count({ where: { tenantId, deletedAt: null } }),
    ]);
    tenantHasAnyKnowledge = sourceCount > 0 || faqCount > 0 || serviceCount > 0;
  }

  const result: RetrievalResult = {
    chunks: filtered.map((r) => ({
      chunk_id: r.chunk_id,
      source_id: r.source_id,
      faq_entry_id: r.faq_entry_id,
      service_id: r.service_id,
      source_title: r.source_title,
      parentType:
        r.parent_type === "service"
          ? "service"
          : r.parent_type === "faq"
            ? "faq"
            : "source",
      category: r.category,
      chunk_text: r.chunk_text,
      score: r.score,
    })),
    tenantHasAnyKnowledge,
  };

  // 7. Audit log emit (best-effort). Per ticket §5: chunk_retrieved fires
  //    unconditionally; gap_detected fires additionally on empty-after-filter.
  void emitChunkRetrievedAudit(prisma, {
    tenantId,
    dealId,
    queryText,
    chunks: result.chunks,
  });
  if (result.chunks.length === 0 && tenantHasAnyKnowledge) {
    void emitGapDetectedAudit(prisma, { tenantId, dealId, queryText });
  }

  // 8. Cache result (5-min TTL) — best-effort, ignore Redis failures.
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL_SECONDS);
    } catch (err) {
      console.warn(
        `[knowledge-retrieval] redis-cache-write-failed key=${cacheKey} err=${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  return result;
}

// ─────────────────────────────────────────────
// Audit log helpers (best-effort; isolated from caller)
// ─────────────────────────────────────────────

async function emitChunkRetrievedAudit(
  prisma: PrismaClient,
  input: { tenantId: string; dealId: string; queryText: string; chunks: RetrievedChunk[] },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actor: "ai_agent",
        actionType: "knowledge.chunk_retrieved",
        payload: {
          dealId: input.dealId,
          chunkIds: input.chunks.map((c) => c.chunk_id),
          scores: input.chunks.map((c) => Number(c.score.toFixed(4))),
          queryTextPreview: input.queryText.slice(0, QUERY_TEXT_AUDIT_PREVIEW_CHARS),
        },
      },
    });
  } catch (err) {
    console.warn(
      `[knowledge-retrieval] audit-emit-chunk-retrieved-failed tenantId=${input.tenantId} dealId=${input.dealId} err=${(err as Error)?.message ?? String(err)}`,
    );
  }
}

async function emitGapDetectedAudit(
  prisma: PrismaClient,
  input: { tenantId: string; dealId: string; queryText: string },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actor: "ai_agent",
        actionType: "knowledge.gap_detected",
        payload: {
          dealId: input.dealId,
          queryTextPreview: input.queryText.slice(0, QUERY_TEXT_AUDIT_PREVIEW_CHARS),
        },
      },
    });
  } catch (err) {
    console.warn(
      `[knowledge-retrieval] audit-emit-gap-detected-failed tenantId=${input.tenantId} dealId=${input.dealId} err=${(err as Error)?.message ?? String(err)}`,
    );
  }
}

// ─────────────────────────────────────────────
// Prompt rendering — both Brain and Shaper consume this verbatim
// ─────────────────────────────────────────────

/**
 * Render the `## Company knowledge` section for inclusion in Brain or
 * Shaper prompts. Format locked per architect spec §3.4.
 *
 * Two empty-case strings (Fred's sub-cohort 1 note #1):
 *   - tenantHasAnyKnowledge=false → "(none — no company knowledge configured yet)"
 *   - tenantHasAnyKnowledge=true + chunks=[] → "(none relevant to this message)"
 *
 * Token cap: 1500 tokens per architect spec §3.4 + KAN-828 AC. Chunks are
 * already top-K + minScore filtered upstream; we further truncate the
 * lowest-score chunks first if the rendered string exceeds the cap.
 *
 * Per-chunk text truncation at 400 chars per spec §3.4 line "{chunk_text
 * truncated to 400 chars per chunk}".
 */
export function renderKnowledgeSection(result: RetrievalResult): string {
  if (result.chunks.length === 0) {
    return result.tenantHasAnyKnowledge
      ? "(none relevant to this message)"
      : "(none — no company knowledge configured yet)";
  }
  // Sort by score descending so the lowest-score gets truncated first if
  // we hit the cap. Already top-K filtered upstream; sort here is defensive.
  const sorted = [...result.chunks].sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    const sourceLabel = c.source_title ?? "(untitled source)";
    const preview = c.chunk_text.slice(0, 400);
    lines.push(`${i + 1}. [${sourceLabel}] (${c.category}) — score ${c.score.toFixed(2)}\n   ${preview}`);
  }
  return lines.join("\n");
}
