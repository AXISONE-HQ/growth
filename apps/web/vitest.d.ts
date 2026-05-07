/// <reference types="@testing-library/jest-dom" />

/**
 * KAN-829 sub-cohort 2 — TS type augmentation for jest-dom matchers
 * (toHaveStyle, toBeInTheDocument, toHaveAttribute, etc.) that test-setup.ts
 * registers at runtime via expect.extend(matchers). Without this triple-slash
 * reference, the matchers work at runtime but TypeScript flags
 * `Property 'toHaveStyle' does not exist on type 'Assertion<HTMLElement>'`.
 *
 * Picked up by tsconfig's `include` glob (default `**\/*.ts` covers it).
 */
import "vitest";

declare module "vitest" {
  // The `@testing-library/jest-dom` triple-slash above already extends the
  // global expect. This module declaration is a hook for any future
  // assertion extensions specific to apps/web.
}
