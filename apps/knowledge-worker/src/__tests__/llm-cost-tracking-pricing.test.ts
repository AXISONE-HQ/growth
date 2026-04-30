/**
 * KAN-734 — pricing surface unit tests for @growth/llm-cost-tracking.
 *
 * Per `decision_llm_cost_tracking_test_runner_assignment` memory: the new
 * package's tests run via the worker's vitest config (lowest blast radius;
 * 2-consumer shape doesn't yet justify a standalone vitest config in the
 * package itself).
 */
import { describe, it, expect } from "vitest";
import {
  MODEL_PRICING,
  MODEL_PRICING_VERSION,
  computeCostUsd,
} from "@growth/llm-cost-tracking";

describe("KAN-734 — MODEL_PRICING table coverage", () => {
  it("covers every model used in production tier maps", () => {
    // The 5 models that apps/api + apps/knowledge-worker currently call.
    // If a tier-map model is added without a pricing entry, the cost event
    // emits costUsd=0 silently — surface it here as a hard test fail.
    const requiredModels = [
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "gpt-4o",
      "gpt-4o-mini",
      "text-embedding-3-small",
    ];
    for (const model of requiredModels) {
      expect(MODEL_PRICING).toHaveProperty(model);
    }
  });

  it("MODEL_PRICING_VERSION is a non-empty version-shaped string", () => {
    expect(typeof MODEL_PRICING_VERSION).toBe("string");
    expect(MODEL_PRICING_VERSION.length).toBeGreaterThan(0);
    // Date-versioned: YYYY-MM-DD-vN per `feedback_model_pricing_refresh_discipline`
    expect(MODEL_PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/);
  });
});

describe("KAN-734 — computeCostUsd math", () => {
  it("computes claude-sonnet-4-6 at $3/M input + $15/M output", () => {
    // 1000 input @ $3/M = $0.003; 500 output @ $15/M = $0.0075; total $0.0105
    expect(computeCostUsd("claude-sonnet-4-6", 1000, 500)).toBeCloseTo(0.0105, 6);
  });

  it("computes text-embedding-3-small at $0.02/M input, no output cost", () => {
    expect(computeCostUsd("text-embedding-3-small", 1_000_000, 0)).toBeCloseTo(0.02, 5);
    // outputTokens param ignored for this model (outputPerMillion=0)
    expect(computeCostUsd("text-embedding-3-small", 1_000_000, 999)).toBeCloseTo(0.02, 5);
  });

  it("returns 0 for unknown models (defensive — never throw in cost-tracking hot path)", () => {
    expect(computeCostUsd("nonexistent-model-v9", 10_000, 5_000)).toBe(0);
    expect(computeCostUsd("", 100, 100)).toBe(0);
  });

  it("zero-token call yields zero cost", () => {
    expect(computeCostUsd("claude-sonnet-4-6", 0, 0)).toBe(0);
  });
});
