/**
 * KAN-829 sub-cohort 2 — first vitest config in apps/web. Sets up jsdom
 * for component tests + path alias `@/*` matching tsconfig.json.
 *
 * Will be reused by Sprint 11a sub-cohorts 3-7 (KAN-829) + KAN-831 (Persona)
 * + KAN-847 (DS v1 promotion). One-time infra investment per pre-flight
 * Decision B2.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test-setup.ts"],
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
