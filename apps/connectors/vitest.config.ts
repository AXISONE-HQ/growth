import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/*.test.ts'],
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
