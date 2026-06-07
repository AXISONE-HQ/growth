/**
 * KAN-1117 — /readyz database health probe — `$queryRaw` integration test.
 *
 * **Doctrine compliance, not runtime bug-catching.** The PROD deploy smoke
 * step at `.github/workflows/deploy-api.yml:430-450` already exercises the
 * full `/readyz` handler against real Postgres post-deploy + fails the
 * deploy on a 503 (any dep failure including the SELECT 1 timeout). This
 * test exists to lock the integration-test discipline at CI time —
 * per the doctrine memo
 * `docs/memories/feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md`:
 *
 *   > Any $queryRaw / $executeRaw site must have at least one integration
 *   > test exercising real Postgres.
 *
 * The rule is binary. The SELECT 1 site at `apps/api/src/routes/readyz.ts:121`
 * is the simplest possible $queryRaw in the codebase (no parameters, no
 * schema dependency, no concurrency), but the doctrine applies uniformly.
 * Shipping this test forecloses the rationalization vector ("it's trivial,
 * skip it") and locks the harness exercise pattern as the binary default.
 *
 * The pre-existing unit test `apps/api/src/__tests__/readyz.test.ts`
 * (KAN-1013) covers the `/readyz` handler's behavior matrix (200 / 503
 * shapes, per-dep ok flags, timeout bounds) with mocked Prisma. This file
 * is the SQL-level sibling — it exercises the actual $queryRaw against
 * real Postgres via the KAN-1112 harness.
 *
 * Test isolation: withRollback. SELECT 1 is read-only; no state to clean.
 *
 * 16th-memo-candidate (`feedback_state_machine_extensions_must_enumerate_recovery_paths.md`)
 * is irrelevant here — no state machine touched. 17th-memo-candidate
 * (`feedback_memos_document_patterns_integration_tests_enforce_them.md`)
 * IS relevant: this test is the enforcement layer that backs the doctrine
 * memo with a runnable assertion.
 */
import { describe, expect, it } from 'vitest';
import { withRollback } from './setup.js';

describe("KAN-1117 — /readyz database health probe `SELECT 1`", () => {
  it("returns truthy result against real Postgres (shape lock)", async () => {
    // Mirrors the production call at readyz.ts:121 — `prisma.$queryRaw\`SELECT 1\``
    // — with an added column alias so we can assert the projection shape.
    // The production call discards the result; this test asserts the call
    // actually exchanged data with Postgres rather than silently no-op'd.
    await withRollback(async (prisma) => {
      const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(result).toHaveLength(1);
      expect(result[0]?.ok).toBe(1);
    });
  });

  it("does not throw against real Postgres (production call shape)", async () => {
    // Exact production call shape — no alias, no projection assertion. If
    // a future Prisma upgrade or pg driver change breaks the literal
    // `prisma.$queryRaw\`SELECT 1\`` invocation against pg15 + pgvector,
    // this test fails CI before the regression can reach the deploy-time
    // /readyz smoke (which would silently 503 every revision until the
    // first manual investigation).
    await withRollback(async (prisma) => {
      await expect(prisma.$queryRaw`SELECT 1`).resolves.toBeDefined();
    });
  });
});
