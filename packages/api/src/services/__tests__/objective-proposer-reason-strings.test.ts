/**
 * KAN-964 (slice 2a PR C) — reason-string regression test.
 *
 * PR B's PROD smoke surfaced: `sell_online` and `warm_up` rendered
 * `book_appointment`'s reason ("a structured book-demo flow converts
 * them faster") because the 3 types shared a switch-fallthrough case
 * in objective-proposer.ts:fallbackReason.
 *
 * This test pins per-type distinctness — every catalog type must yield
 * its OWN reason string, in BOTH the `ready` and `needs_more_data`
 * branches. A future refactor that re-groups types into shared cases
 * will fail this test.
 */
import { describe, it, expect } from "vitest";
import { fallbackProposal } from "../objective-proposer.js";

const CATALOG_TYPES = [
  "book_appointment",
  "sell_online",
  "enrich_lead",
  "warm_up",
  "reactivate",
  "retain_customer",
  "upsell",
  "recover_failed_payment",
] as const;

const baseInput = {
  objectiveName: "(display)",
  segment: "new_leads" as const,
  segmentCount: 5,
  accountContext: { industry: "SAAS", timeZone: "America/Toronto", defaultLanguage: "en" },
};

describe("KAN-964 — fallbackReason distinct-per-type (ready branch)", () => {
  it("all 8 catalog types produce DISTINCT reason strings on ready", () => {
    const reasons = new Map<string, string>();
    for (const type of CATALOG_TYPES) {
      const out = fallbackProposal({
        ...baseInput,
        objectiveType: type,
        sufficiency: "ready",
      });
      reasons.set(type, out.reason);
    }
    const unique = new Set(reasons.values());
    expect(unique.size).toBe(CATALOG_TYPES.length);
  });

  it("PR B PROD regression: sell_online reason ≠ book_appointment reason", () => {
    const book = fallbackProposal({
      ...baseInput,
      objectiveType: "book_appointment",
      sufficiency: "ready",
    });
    const sell = fallbackProposal({
      ...baseInput,
      objectiveType: "sell_online",
      sufficiency: "ready",
    });
    expect(book.reason).not.toBe(sell.reason);
    // Pin the type-correct keyword each reason MUST contain
    expect(book.reason).toMatch(/book-demo/i);
    expect(sell.reason).toMatch(/online-checkout|checkout/i);
    // Pin that sell_online does NOT reference book-demo
    expect(sell.reason).not.toMatch(/book-demo/i);
  });

  it("PR B PROD regression: warm_up reason ≠ book_appointment reason", () => {
    const book = fallbackProposal({
      ...baseInput,
      objectiveType: "book_appointment",
      sufficiency: "ready",
    });
    const warm = fallbackProposal({
      ...baseInput,
      objectiveType: "warm_up",
      sufficiency: "ready",
    });
    expect(book.reason).not.toBe(warm.reason);
    expect(warm.reason).toMatch(/warm-up|warm up/i);
    expect(warm.reason).not.toMatch(/book-demo/i);
  });
});

describe("KAN-964 — fallbackReason distinct-per-type (needs_more_data branch)", () => {
  it("all 8 catalog types produce DISTINCT reason strings on needs_more_data", () => {
    const reasons = new Map<string, string>();
    for (const type of CATALOG_TYPES) {
      const out = fallbackProposal({
        ...baseInput,
        objectiveType: type,
        sufficiency: "needs_more_data",
      });
      reasons.set(type, out.reason);
    }
    const unique = new Set(reasons.values());
    expect(unique.size).toBe(CATALOG_TYPES.length);
  });

  it("needs_more_data: sell_online ≠ book_appointment (preventive — both surface as ready in PROD today, but the grouping bug existed here too)", () => {
    const book = fallbackProposal({
      ...baseInput,
      objectiveType: "book_appointment",
      sufficiency: "needs_more_data",
    });
    const sell = fallbackProposal({
      ...baseInput,
      objectiveType: "sell_online",
      sufficiency: "needs_more_data",
    });
    expect(book.reason).not.toBe(sell.reason);
    expect(sell.reason).toMatch(/online|checkout|sale/i);
  });

  it("needs_more_data: warm_up ≠ book_appointment (same preventive pinning)", () => {
    const book = fallbackProposal({
      ...baseInput,
      objectiveType: "book_appointment",
      sufficiency: "needs_more_data",
    });
    const warm = fallbackProposal({
      ...baseInput,
      objectiveType: "warm_up",
      sufficiency: "needs_more_data",
    });
    expect(book.reason).not.toBe(warm.reason);
    expect(warm.reason).toMatch(/warm-up|warm up|qualification context/i);
  });
});
