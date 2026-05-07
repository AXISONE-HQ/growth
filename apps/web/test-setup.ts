/**
 * KAN-829 sub-cohort 2 — vitest test setup for apps/web component tests.
 *
 * Imports jest-dom matchers via expect.extend (the `/vitest` subpath has a
 * known testPath getter incompat with vitest 1.x — pin pattern below works
 * across vitest 0.x / 1.x / 2.x). Registers toBeInTheDocument + class/style
 * matchers globally so test files don't need to import them individually.
 */
import { expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});
