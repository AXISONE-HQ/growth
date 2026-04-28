import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/__tests__/*.test.ts"],
    env: {
      GCP_PROJECT_ID: "test-project",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
  },
});
