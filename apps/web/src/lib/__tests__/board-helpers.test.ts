/**
 * KAN-968 — Pure helpers for the Pipelines board.
 *
 * Coverage:
 *   - humanizeActionType: 5 spec-locked Brain action → user-facing copy
 *     mappings + identity fall-through for unknown values
 *   - confidenceLevel: bucket boundaries (85+/65–84/40–64/<40)
 *   - confidenceClasses: tier maps to a non-empty class string per level
 *   - formatStageAge: just-now / minutes / hours / days
 *   - contactDisplayName: first+last, missing parts, all-null fallback
 *   - formatMoney: USD formatting + non-finite fallback
 */
import { describe, it, expect } from "vitest";
import {
  humanizeActionType,
  confidenceLevel,
  confidencePercent,
  confidenceClasses,
  formatStageAge,
  contactDisplayName,
  formatMoney,
  type ConfidenceLevel,
} from "../board-helpers";

describe("KAN-968 — humanizeActionType (PRD-locked map)", () => {
  it("maps the 5 PRD-listed actions to their copy strings", () => {
    expect(humanizeActionType("send_follow_up")).toBe("Sending follow-up");
    expect(humanizeActionType("wait_for_response")).toBe("Waiting for reply");
    expect(humanizeActionType("advance_stage")).toBe("Advancing");
    expect(humanizeActionType("escalate_to_human")).toBe("Escalated");
    expect(humanizeActionType("no_action")).toBe("Monitoring");
  });
  it("falls through to raw actionType for unknown values (no crash on future Brain actions)", () => {
    expect(humanizeActionType("some_future_action")).toBe("some_future_action");
  });
});

describe("KAN-968 — confidenceLevel bucket boundaries", () => {
  it("85+ → high", () => {
    expect(confidenceLevel(0.85)).toBe("high");
    expect(confidenceLevel(0.99)).toBe("high");
    expect(confidenceLevel(1.0)).toBe("high");
  });
  it("65–84 → good (PR-B routing-flip smoke landed here: 0.82)", () => {
    expect(confidenceLevel(0.65)).toBe("good");
    expect(confidenceLevel(0.82)).toBe("good");
    expect(confidenceLevel(0.84)).toBe("good");
  });
  it("40–64 → uncertain", () => {
    expect(confidenceLevel(0.4)).toBe("uncertain");
    expect(confidenceLevel(0.5)).toBe("uncertain");
    expect(confidenceLevel(0.64)).toBe("uncertain");
  });
  it("<40 → low", () => {
    expect(confidenceLevel(0.0)).toBe("low");
    expect(confidenceLevel(0.39)).toBe("low");
  });
  it("confidencePercent rounds to integer", () => {
    expect(confidencePercent(0.823)).toBe(82);
    expect(confidencePercent(0.826)).toBe(83);
  });
  // KAN-986 — confidenceClasses migrated from raw Tailwind dark-theme
  // (text-emerald-300 etc.) to the design-system pastel tokens
  // (--ds-emerald-100 / --ds-violet-100 / --ds-warning-soft / --ds-danger-soft).
  // Test now pins each tier to its --ds-* token AND adds an explicit
  // pairwise-distinctness assertion to enforce the standing hard
  // requirement: the four tiers must remain visually distinguishable.
  it("confidenceClasses references the tier-specific --ds-* token", () => {
    expect(confidenceClasses("high")).toMatch(/ds-emerald/);
    expect(confidenceClasses("good")).toMatch(/ds-violet/);
    expect(confidenceClasses("uncertain")).toMatch(/ds-warning/);
    expect(confidenceClasses("low")).toMatch(/ds-danger/);
  });

  it("KAN-986 hard requirement — all 4 tier class strings are pairwise distinct", () => {
    const tiers: ConfidenceLevel[] = ["high", "good", "uncertain", "low"];
    const classes = tiers.map(confidenceClasses);
    const unique = new Set(classes);
    expect(unique.size).toBe(4);
  });
});

describe("KAN-968 — formatStageAge", () => {
  const NOW = new Date("2026-05-21T18:00:00Z");
  it("< 1 minute → 'just now'", () => {
    expect(formatStageAge(new Date("2026-05-21T17:59:30Z"), NOW)).toBe("just now");
  });
  it("minutes → 'Xm'", () => {
    expect(formatStageAge(new Date("2026-05-21T17:55:00Z"), NOW)).toBe("5m");
  });
  it("hours → 'Xh'", () => {
    expect(formatStageAge(new Date("2026-05-21T16:00:00Z"), NOW)).toBe("2h");
  });
  it("days → 'Xd'", () => {
    expect(formatStageAge(new Date("2026-05-18T18:00:00Z"), NOW)).toBe("3d");
  });
  it("accepts ISO string input (matches BoardDealCard.enteredStageAt shape)", () => {
    expect(formatStageAge("2026-05-21T16:00:00Z", NOW)).toBe("2h");
  });
});

describe("KAN-968 — contactDisplayName", () => {
  it("combines first + last when both present", () => {
    expect(contactDisplayName({ firstName: "Alice", lastName: "Anderson" })).toBe("Alice Anderson");
  });
  it("uses first only when last is null", () => {
    expect(contactDisplayName({ firstName: "Bob", lastName: null })).toBe("Bob");
  });
  it("uses last only when first is null", () => {
    expect(contactDisplayName({ firstName: null, lastName: "Solo" })).toBe("Solo");
  });
  it("falls back to '(no name)' when both null", () => {
    expect(contactDisplayName({ firstName: null, lastName: null })).toBe("(no name)");
  });
  it("treats whitespace-only as empty (no awkward bare spaces)", () => {
    expect(contactDisplayName({ firstName: "  ", lastName: null })).toBe("(no name)");
  });
});

describe("KAN-968 — formatMoney", () => {
  it("formats USD with currency symbol", () => {
    expect(formatMoney("1234.56", "USD")).toMatch(/\$1,234\.56/);
  });
  it("renders 0.00 cleanly", () => {
    expect(formatMoney("0", "USD")).toMatch(/\$0\.00/);
  });
  it("falls back to numeric form for non-finite input (defensive)", () => {
    expect(formatMoney("not-a-number", "USD")).toContain("USD");
  });
});
