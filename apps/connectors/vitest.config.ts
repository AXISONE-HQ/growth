import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      // KAN-697 (Sprint 0): packages/api/src/services unit tests piggyback on
      // the connectors vitest runner because packages/api has no test
      // infrastructure of its own. Scoped to services/__tests__/ only so
      // untracked scratch tests under packages/api/src/__tests__/integration/
      // don't get pulled in. KAN-692 will give packages/api its own runner.
      '../../packages/api/src/services/__tests__/*.test.ts',
    ],
    // Fake values — only used to satisfy env.ts parse at test-module-load. Never hit.
    env: {
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      INTERNAL_TRPC_AUTH_TOKEN: 'test-token-at-least-32-characters-long',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
});
