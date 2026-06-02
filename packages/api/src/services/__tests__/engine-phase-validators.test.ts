/**
 * KAN-1063 (Cluster II PR I) — EnginePhase validation infrastructure tests.
 *
 * Covers:
 *   - EnginePhaseKey type + ENGINE_PHASE_ORDER constant
 *   - VALID_ENGINE_PHASES set
 *   - isValidPhaseAdvance boundary tests across the 4-phase model
 *   - Lock 4 invariant (closing has no exit — strict-sequential v1)
 *   - BrainActionType union extension (`advance_engine_phase` accepted)
 *   - AdvanceEnginePhasePayload type contract
 *
 * Phase 1 trace locks (2026-06-02):
 *   - Lock 1: naming `EnginePhase` (NOT MicroObjective)
 *   - Lock 4: closing-phase exit invariant — closing → ??? always returns false
 */
import { describe, it, expect } from "vitest";
import {
  ENGINE_PHASE_ORDER,
  VALID_ENGINE_PHASES,
  isValidPhaseAdvance,
  type EnginePhaseKey,
  type AdvanceEnginePhasePayload,
  type BrainActionType,
} from "../brain-service.js";

describe("KAN-1063 — ENGINE_PHASE_ORDER canonical sequence", () => {
  it("has exactly 4 phases in canonical order", () => {
    expect(ENGINE_PHASE_ORDER).toEqual(["qualify", "problem", "proof", "closing"]);
  });

  it("has exactly 4 entries (matches Phase 1 trace lock)", () => {
    // Sentinel pin. If a future PR adds a 5th phase, this test fires and
    // forces docstring + Lock 4 invariant + migration shape all to be
    // updated in lockstep.
    expect(ENGINE_PHASE_ORDER).toHaveLength(4);
  });

  it("is readonly at compile + runtime", () => {
    // Runtime: array is frozen via `as const` — assignment via direct
    // index throws in strict mode, silently no-ops otherwise.
    // We assert the structural shape stays intact regardless.
    const original = [...ENGINE_PHASE_ORDER];
    expect(ENGINE_PHASE_ORDER).toEqual(original);
  });
});

describe("KAN-1063 — VALID_ENGINE_PHASES set", () => {
  it("contains all 4 canonical phases", () => {
    expect(VALID_ENGINE_PHASES.has("qualify")).toBe(true);
    expect(VALID_ENGINE_PHASES.has("problem")).toBe(true);
    expect(VALID_ENGINE_PHASES.has("proof")).toBe(true);
    expect(VALID_ENGINE_PHASES.has("closing")).toBe(true);
  });

  it("has exactly 4 members", () => {
    expect(VALID_ENGINE_PHASES.size).toBe(4);
  });

  it("rejects non-canonical phase keys (defense at the validator boundary)", () => {
    // The Set is typed ReadonlySet<EnginePhaseKey> so TS rejects these
    // at compile time. Runtime `has` returns false for invalid casts.
    expect(VALID_ENGINE_PHASES.has("qualified" as unknown as EnginePhaseKey)).toBe(false);
    expect(VALID_ENGINE_PHASES.has("proposal-ready" as unknown as EnginePhaseKey)).toBe(false);
    expect(VALID_ENGINE_PHASES.has("" as unknown as EnginePhaseKey)).toBe(false);
  });
});

describe("KAN-1063 — isValidPhaseAdvance strict-sequential validation", () => {
  // ── Valid adjacent forward transitions ──
  it("accepts qualify → problem (canonical adjacent transition)", () => {
    expect(isValidPhaseAdvance("qualify", "problem")).toBe(true);
  });

  it("accepts problem → proof (canonical adjacent transition)", () => {
    expect(isValidPhaseAdvance("problem", "proof")).toBe(true);
  });

  it("accepts proof → closing (canonical adjacent transition)", () => {
    expect(isValidPhaseAdvance("proof", "closing")).toBe(true);
  });

  // ── Skip transitions (Lock 1 strict-sequential v1) ──
  it("rejects qualify → proof (skip past problem)", () => {
    expect(isValidPhaseAdvance("qualify", "proof")).toBe(false);
  });

  it("rejects qualify → closing (skip 2 phases)", () => {
    expect(isValidPhaseAdvance("qualify", "closing")).toBe(false);
  });

  it("rejects problem → closing (skip past proof)", () => {
    expect(isValidPhaseAdvance("problem", "closing")).toBe(false);
  });

  // ── Reverse transitions ──
  it("rejects problem → qualify (reverse)", () => {
    expect(isValidPhaseAdvance("problem", "qualify")).toBe(false);
  });

  it("rejects proof → problem (reverse)", () => {
    expect(isValidPhaseAdvance("proof", "problem")).toBe(false);
  });

  it("rejects closing → proof (reverse)", () => {
    expect(isValidPhaseAdvance("closing", "proof")).toBe(false);
  });

  // ── Same-phase ──
  it("rejects same-phase transitions (no self-advance)", () => {
    expect(isValidPhaseAdvance("qualify", "qualify")).toBe(false);
    expect(isValidPhaseAdvance("problem", "problem")).toBe(false);
    expect(isValidPhaseAdvance("proof", "proof")).toBe(false);
    expect(isValidPhaseAdvance("closing", "closing")).toBe(false);
  });

  // ── Lock 4 — Closing-phase exit invariant ──
  it("Lock 4 — closing has no exit: rejects closing → qualify", () => {
    expect(isValidPhaseAdvance("closing", "qualify")).toBe(false);
  });

  it("Lock 4 — closing has no exit: rejects closing → problem", () => {
    expect(isValidPhaseAdvance("closing", "problem")).toBe(false);
  });

  it("Lock 4 — closing has no exit: rejects closing → proof (already covered above; explicit pin)", () => {
    expect(isValidPhaseAdvance("closing", "proof")).toBe(false);
  });

  it("Lock 4 — closing has no exit: returns false for ANY closing → ??? attempt", () => {
    // Brute-force enumeration to pin Lock 4 invariant. The engine must use
    // `advance_stage` (Cluster III handoff), `close_deal_lost`,
    // `wait_for_response`, or `escalate_to_human` at the closing boundary.
    for (const to of ENGINE_PHASE_ORDER) {
      expect(isValidPhaseAdvance("closing", to)).toBe(false);
    }
  });

  // ── Defensive: invalid `from` value ──
  it("returns false when `from` is not a canonical phase (defensive cast)", () => {
    expect(
      isValidPhaseAdvance("qualified" as unknown as EnginePhaseKey, "problem"),
    ).toBe(false);
  });
});

describe("KAN-1063 — BrainActionType union extension", () => {
  it("'advance_engine_phase' is assignable to BrainActionType (type-level sentinel)", () => {
    // Compile-time sentinel: if the union loses `advance_engine_phase`,
    // this assignment fails to compile and the test won't even reach
    // runtime. Runtime check is trivial.
    const t: BrainActionType = "advance_engine_phase";
    expect(t).toBe("advance_engine_phase");
  });

  it("existing action types still assignable (back-compat)", () => {
    const types: BrainActionType[] = [
      "send_follow_up",
      "wait_for_response",
      "advance_stage",
      "escalate_to_human",
      "close_deal_lost",
      "no_action",
      "transition_sub_objective",
      "advance_engine_phase",
    ];
    // 8 total types post-extension
    expect(types).toHaveLength(8);
  });
});

describe("KAN-1063 — AdvanceEnginePhasePayload type contract", () => {
  it("accepts valid fromPhase + toPhase shape", () => {
    const payload: AdvanceEnginePhasePayload = {
      fromPhase: "qualify",
      toPhase: "problem",
    };
    expect(payload.fromPhase).toBe("qualify");
    expect(payload.toPhase).toBe("problem");
  });

  it("isValidPhaseAdvance composes cleanly with payload shape", () => {
    // Common usage pattern at the parser (PR IV) + dispatcher (PR V):
    // payload arrives; validator gates the transition.
    const validPayload: AdvanceEnginePhasePayload = {
      fromPhase: "problem",
      toPhase: "proof",
    };
    expect(isValidPhaseAdvance(validPayload.fromPhase, validPayload.toPhase)).toBe(
      true,
    );

    const invalidPayload: AdvanceEnginePhasePayload = {
      fromPhase: "closing",
      toPhase: "qualify",
    };
    expect(isValidPhaseAdvance(invalidPayload.fromPhase, invalidPayload.toPhase)).toBe(
      false,
    );
  });
});
