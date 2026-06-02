/**
 * KAN-1063 (Cluster II PR I) — sub-objective-types vocab extension tests.
 *
 * Sentinel pins on:
 *   - SUB_OBJECTIVE_KEYS extension (3 new keys: cost_of_problem, roi_metrics,
 *     committed_amount) folding in KAN-1050
 *   - DEFAULT_SUB_OBJECTIVES_GENERIC_B2B extension (3 new entries with locked
 *     priorityWeight values per Phase 1 trace)
 *   - Order invariants (existing BANT-5 keys appear first; new keys appear
 *     after in declaration order)
 *   - requiredAtStage @deprecated discipline (new entries omit the field;
 *     existing BANT-5 entries keep their PRD-pinned values)
 *
 * Phase 1 trace lock (2026-06-02): priorityWeight values for new KAN-1050
 * keys are cost_of_problem=0.65 > roi_metrics=0.60 > committed_amount=0.55,
 * matching conversational order (problem → proof → close).
 */
import { describe, it, expect } from "vitest";
import {
  SUB_OBJECTIVE_KEYS,
  DEFAULT_SUB_OBJECTIVES_GENERIC_B2B,
  type SubObjectiveKey,
} from "../sub-objective-types.js";

describe("KAN-1063 — SUB_OBJECTIVE_KEYS vocab extension", () => {
  it("includes the original BANT-5 keys (back-compat)", () => {
    expect(SUB_OBJECTIVE_KEYS).toContain("timeline");
    expect(SUB_OBJECTIVE_KEYS).toContain("budget");
    expect(SUB_OBJECTIVE_KEYS).toContain("authority");
    expect(SUB_OBJECTIVE_KEYS).toContain("need");
    expect(SUB_OBJECTIVE_KEYS).toContain("motivation");
  });

  it("includes the 3 new KAN-1050 keys (Cluster II vocab extension)", () => {
    expect(SUB_OBJECTIVE_KEYS).toContain("cost_of_problem");
    expect(SUB_OBJECTIVE_KEYS).toContain("roi_metrics");
    expect(SUB_OBJECTIVE_KEYS).toContain("committed_amount");
  });

  it("has exactly 8 total keys (5 BANT + 3 KAN-1050)", () => {
    // Sentinel: if a future PR adds keys, this test fires and forces the
    // KAN-1063 vocab extension docstring to be updated in lockstep.
    expect(SUB_OBJECTIVE_KEYS).toHaveLength(8);
  });

  it("preserves BANT-5 keys in declaration-order positions 0-4 (composite-scoring back-compat)", () => {
    // sub-objective-gap-tracker.ts composite scoring iterates this array
    // for prioritizedGaps ordering. Preserving original positions
    // means existing gap-tracker tests pass unchanged.
    expect(SUB_OBJECTIVE_KEYS[0]).toBe("timeline");
    expect(SUB_OBJECTIVE_KEYS[1]).toBe("budget");
    expect(SUB_OBJECTIVE_KEYS[2]).toBe("authority");
    expect(SUB_OBJECTIVE_KEYS[3]).toBe("need");
    expect(SUB_OBJECTIVE_KEYS[4]).toBe("motivation");
  });

  it("new keys appear after BANT-5 in declaration order (positions 5-7)", () => {
    expect(SUB_OBJECTIVE_KEYS[5]).toBe("cost_of_problem");
    expect(SUB_OBJECTIVE_KEYS[6]).toBe("roi_metrics");
    expect(SUB_OBJECTIVE_KEYS[7]).toBe("committed_amount");
  });
});

describe("KAN-1063 — DEFAULT_SUB_OBJECTIVES_GENERIC_B2B vocab extension", () => {
  it("has 8 entries (one per SUB_OBJECTIVE_KEYS key)", () => {
    expect(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B).toHaveLength(8);
  });

  it("every SUB_OBJECTIVE_KEYS entry has a corresponding default definition", () => {
    const defaultKeys = new Set(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => d.key));
    for (const key of SUB_OBJECTIVE_KEYS) {
      expect(defaultKeys.has(key), `key '${key}' missing from defaults`).toBe(true);
    }
  });

  it("new KAN-1050 entries carry locked priorityWeight values from Phase 1 trace", () => {
    const byKey = new Map(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => [d.key, d]));

    // cost_of_problem = 0.65 — Problem phase, between motivation (0.70) and roi_metrics
    expect(byKey.get("cost_of_problem")?.priorityWeight).toBe(0.65);

    // roi_metrics = 0.60 — Proof phase
    expect(byKey.get("roi_metrics")?.priorityWeight).toBe(0.60);

    // committed_amount = 0.55 — Closing phase, lowest base weight per Phase 1 lock
    // (stageWeight in composite scoring handles Closing-specific elevation)
    expect(byKey.get("committed_amount")?.priorityWeight).toBe(0.55);
  });

  it("priorityWeight ordering: BANT-5 keys all rank higher than new KAN-1050 keys", () => {
    // BANT-5 range: 0.70..0.90; KAN-1050 range: 0.55..0.65. Pre-launch
    // discipline: original keys retain priority; new keys slot below.
    // If/when empirical signal warrants re-ranking, file a Phase 2.5 ticket.
    const byKey = new Map(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => [d.key, d]));
    const bantMinWeight = Math.min(
      byKey.get("timeline")!.priorityWeight,
      byKey.get("budget")!.priorityWeight,
      byKey.get("authority")!.priorityWeight,
      byKey.get("need")!.priorityWeight,
      byKey.get("motivation")!.priorityWeight,
    );
    const newMaxWeight = Math.max(
      byKey.get("cost_of_problem")!.priorityWeight,
      byKey.get("roi_metrics")!.priorityWeight,
      byKey.get("committed_amount")!.priorityWeight,
    );
    expect(bantMinWeight).toBeGreaterThan(newMaxWeight);
  });

  it("new KAN-1050 entries omit requiredAtStage (deprecated field discipline)", () => {
    // The @deprecated JSDoc on SubObjectiveDefault.requiredAtStage instructs
    // new entries to omit the field. Existing BANT-5 entries retain their
    // PRD-pinned values (back-compat with 5+ consumers per KAN-1068).
    const byKey = new Map(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => [d.key, d]));

    expect(byKey.get("cost_of_problem")?.requiredAtStage).toBeUndefined();
    expect(byKey.get("roi_metrics")?.requiredAtStage).toBeUndefined();
    expect(byKey.get("committed_amount")?.requiredAtStage).toBeUndefined();
  });

  it("existing BANT-5 entries preserve their PRD-pinned requiredAtStage values (back-compat)", () => {
    // Load-bearing back-compat per KAN-1068 verified consumers (UI panel,
    // composite scoring, action-determiner, decision-run-push). PR I cannot
    // drop these values; KAN-1068 tracks the migration plan.
    const byKey = new Map(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => [d.key, d]));

    expect(byKey.get("timeline")?.requiredAtStage).toBe("qualified");
    expect(byKey.get("budget")?.requiredAtStage).toBe("proposal-ready");
    expect(byKey.get("authority")?.requiredAtStage).toBe("proposal-ready");
    expect(byKey.get("need")?.requiredAtStage).toBe("qualified");
    expect(byKey.get("motivation")?.requiredAtStage).toBe("qualified");
  });

  it("new KAN-1050 entries have human-readable labels (operator UI surface)", () => {
    const byKey = new Map(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => [d.key, d]));

    expect(byKey.get("cost_of_problem")?.label).toBeTruthy();
    expect(byKey.get("cost_of_problem")?.label.length).toBeGreaterThan(0);
    expect(byKey.get("roi_metrics")?.label).toBeTruthy();
    expect(byKey.get("roi_metrics")?.label.length).toBeGreaterThan(0);
    expect(byKey.get("committed_amount")?.label).toBeTruthy();
    expect(byKey.get("committed_amount")?.label.length).toBeGreaterThan(0);
  });

  it("SubObjectiveKey type compile-time inclusion (type-level sentinel)", () => {
    // Type-level pin: if SUB_OBJECTIVE_KEYS shrinks back to BANT-5, this
    // const assignment fails to compile. Runtime is trivial (truthy
    // assertion); the load-bearing check is at tsc time.
    const sentinelKeys: SubObjectiveKey[] = [
      "timeline",
      "budget",
      "authority",
      "need",
      "motivation",
      "cost_of_problem",
      "roi_metrics",
      "committed_amount",
    ];
    expect(sentinelKeys).toHaveLength(8);
  });
});
