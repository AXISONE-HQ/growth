/**
 * KAN-1112 — Integration test vitest config.
 *
 * Separate from the unit-test vitest config (apps/connectors/vitest.config.ts)
 * to keep the discipline boundary explicit:
 * - Unit tests: mock Prisma; fast; no infra dependency
 * - Integration tests: real Postgres via docker-compose; slower; require setup
 *
 * Per KAN-1112 Phase 1 Q1 lock: integration tests live at
 *   apps/api/src/__tests__/integration/*.test.ts
 *   packages/api/src/services/__tests__/integration/*.test.ts (future scope)
 *
 * Run locally:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://test:test@localhost:5433/growth_test \
 *     npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
 *   npx vitest run --config apps/connectors/vitest.config.integration.ts
 *
 * CI (.github/workflows/ci.yml `integration-tests` job) handles the
 * docker-compose lifecycle automatically via service containers.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      // KAN-1112 — integration tests only; unit tests run via vitest.config.ts.
      // Paths are repo-root-relative because both CI and the documented local-run
      // command invoke vitest from the repo root (`npx vitest run --config
      // apps/connectors/vitest.config.integration.ts`). vitest resolves `include`
      // globs against `process.cwd()` when `root` is unset.
      'apps/api/src/__tests__/integration/*.test.ts',
      'packages/api/src/services/__tests__/integration/*.test.ts',
    ],
    // Integration tests run serially within a file (transaction rollback semantics)
    // but vitest parallelizes files by default. That's the correct posture.
    env: {
      // DATABASE_URL is overridden from the shell at test run time. The
      // placeholder here keeps env.ts parse happy at module load.
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5433/growth_test',
      GCP_PROJECT_ID: 'test-project',
      INTERNAL_TRPC_AUTH_TOKEN: 'test-token-at-least-32-characters-long',
      NODE_ENV: 'test',
    },
    // Per-suite timeout — DB queries + migrations need more time than unit tests.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['apps/api/src/**/*.ts', 'packages/api/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
        '**/dist/**',
        '**/*.d.ts',
      ],
    },
  },
});
