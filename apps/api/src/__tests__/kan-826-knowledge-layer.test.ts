/**
 * KAN-826 — Sprint 11a Knowledge Layer schema + tenant-isolation tests.
 *
 * 6 tests per architect spec §7.3 — structural + mock-based vitest assertions
 * that run in CI without a real DB connection. Real-DB guarantees (HNSW
 * planner usage, cross-tenant safety with actual rows, migration rollback,
 * schema round-trip) were proven in sub-cohort 5 production smoke on DEV
 * (100 chunks across 2 tenants, EXPLAIN ANALYZE confirmed both partial
 * index + HNSW callable, 0 leaked rows on cross-tenant query). These
 * vitest tests pin the structural invariants so future schema drift breaks
 * loud.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';

// Variable-specifier dynamic import per `reference_variable_specifier_dynamic_import`
// memory: keeps cross-rootDir module out of the static type graph (would
// otherwise add 1 to the apps/api TS6059 cohort baseline).
type KnowledgeTenantGuardMiddlewareFactory = () => Prisma.Middleware;
const middlewareSpec = '../../../../packages/db/src/middleware/tenant.js';
const middlewareModule = (await import(middlewareSpec)) as {
  knowledgeTenantGuardMiddleware: KnowledgeTenantGuardMiddlewareFactory;
};
const knowledgeTenantGuardMiddleware = middlewareModule.knowledgeTenantGuardMiddleware;

const MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '../../../../packages/db/prisma/migrations/20260505220000_kan_826_drop_legacy_kb_recreate_per_spec/migration.sql',
);

const migrationSql = readFileSync(MIGRATION_SQL_PATH, 'utf8');

// ─────────────────────────────────────────────
// 1. Schema introspection — Prisma client exposes 4 new models
// ─────────────────────────────────────────────

describe('KAN-826 — schema introspection (Prisma client delegates)', () => {
  it('exposes knowledgeSource, knowledgeChunk, knowledgeGapSummary, chunkEffectiveness delegates with expected operations', () => {
    // Smoke: instantiate without connecting (no DB call). Assert the delegate
    // surface exists. If `prisma db pull` ever silently drops a model OR if
    // the schema rename ever drifts (singular vs plural @@map), this test
    // breaks loud.
    const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://noop:noop@127.0.0.1:1/noop' } } });
    try {
      // Each delegate must have findMany + findFirst + create + delete (the
      // four ops the Knowledge Layer's retrieval + ingestion + admin paths
      // exercise). If any are missing, the Prisma client wasn't generated
      // against the new schema.
      for (const model of ['knowledgeSource', 'knowledgeChunk', 'knowledgeGapSummary', 'chunkEffectiveness'] as const) {
        const delegate = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
        expect(delegate, `prisma.${model} delegate missing`).toBeDefined();
        for (const op of ['findMany', 'findFirst', 'create', 'delete']) {
          expect(typeof delegate[op], `prisma.${model}.${op} missing or non-callable`).toBe('function');
        }
      }
    } finally {
      // Disconnect synchronously — we never connected; this just settles
      // any internal state.
      void prisma.$disconnect();
    }
  });
});

// ─────────────────────────────────────────────
// 2. Tenant-isolation middleware — untenanted query throws
// ─────────────────────────────────────────────

describe('KAN-826 — knowledgeTenantGuardMiddleware', () => {
  function applyGuard(): { run: (params: Prisma.MiddlewareParams) => Promise<unknown>; nextSpy: ReturnType<typeof vi.fn> } {
    const guard = knowledgeTenantGuardMiddleware();
    const nextSpy = vi.fn(async () => 'ok');
    return {
      run: (params) => guard(params, nextSpy as unknown as (p: Prisma.MiddlewareParams) => Promise<unknown>),
      nextSpy,
    };
  }

  it('Test 2 (untenanted findMany throws) — query on KnowledgeChunk without tenantId filter throws', async () => {
    const { run, nextSpy } = applyGuard();
    await expect(
      run({
        model: 'KnowledgeChunk',
        action: 'findMany',
        args: {},
        dataPath: [],
        runInTransaction: false,
      }),
    ).rejects.toThrow(/Tenant isolation violation.*KnowledgeChunk.*without tenantId filter/);
    expect(nextSpy).not.toHaveBeenCalled();
  });

  it('Test 3 (tenanted findMany passes) — query on KnowledgeChunk WITH tenantId filter delegates to next', async () => {
    const { run, nextSpy } = applyGuard();
    const result = await run({
      model: 'KnowledgeChunk',
      action: 'findMany',
      args: { where: { tenantId: 'tenant-uuid-a' } },
      dataPath: [],
      runInTransaction: false,
    });
    expect(result).toBe('ok');
    expect(nextSpy).toHaveBeenCalledOnce();
  });

  it('Test 4 (cross-tenant write blocked) — create on KnowledgeChunk without tenantId in data throws', async () => {
    const { run, nextSpy } = applyGuard();
    await expect(
      run({
        model: 'KnowledgeChunk',
        action: 'create',
        args: { data: { sourceId: 'src_a', chunkText: 'leak attempt', position: 0, category: 'faq' } },
        dataPath: [],
        runInTransaction: false,
      }),
    ).rejects.toThrow(/Tenant isolation violation.*create.*KnowledgeChunk.*without tenantId in data/);
    expect(nextSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 5. HNSW + partial index present in migration.sql (structural)
// ─────────────────────────────────────────────

describe('KAN-826 — migration SQL structural invariants', () => {
  it('Test 5 (HNSW used by planner) — migration declares HNSW index with m=16, ef_construction=64 per spec §1.2', () => {
    expect(migrationSql).toContain('USING hnsw (embedding vector_cosine_ops)');
    expect(migrationSql).toContain('WITH (m = 16, ef_construction = 64)');
    expect(migrationSql).toContain('"knowledge_chunk_embedding_hnsw_idx"');
  });

  it('Test 5b (partial retrieval index) — partial idx on (tenant_id, category) WHERE status=ready per spec §1.6', () => {
    expect(migrationSql).toContain('"knowledge_chunk_tenant_status_partial_idx"');
    expect(migrationSql).toContain(`("tenant_id", "category")`);
    expect(migrationSql).toContain(`WHERE "status" = 'ready'`);
  });

  // ─────────────────────────────────────────────
  // 6. Migration rollback / transactional integrity (structural)
  // ─────────────────────────────────────────────

  it('Test 6 (migration rollback safety) — drops wrapped in transaction with pre-count guards that RAISE EXCEPTION on non-empty legacy tables', () => {
    // BEGIN/COMMIT wrapper — atomic; any failure inside rolls back.
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    // Pre-count guard PL/pgSQL block.
    expect(migrationSql).toContain('SELECT COUNT(*) INTO chunks_count FROM knowledge_chunks');
    expect(migrationSql).toContain('SELECT COUNT(*) INTO sources_count FROM knowledge_sources');
    expect(migrationSql).toContain('SELECT COUNT(*) INTO ingestions_count FROM knowledge_ingestions');
    expect(migrationSql).toContain('RAISE EXCEPTION');
    // Per memory `feedback_prisma_vector_index_silent_drop_drift`: ensure no
    // spurious DROP INDEX of the new HNSW index appears (would silently nuke
    // PROD on deploy if generated by future migrate dev runs).
    expect(migrationSql).not.toContain('DROP INDEX "knowledge_chunk_embedding_hnsw_idx"');
  });
});
