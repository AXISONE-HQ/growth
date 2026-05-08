/**
 * KAN-829 sub-cohort 6 — tier-labels util tests.
 *
 * 8 tests covering: mapTierToLabel Title Case, nextTier synonym-skip
 * (free + starter both jump to pro), null at enterprise ceiling,
 * recommendedTierFor count-at-limit + feature-locked variants,
 * tierFeatures hardcoded parity with the server-side TierLimits map
 * (drift-loud assertion), buildComparisonRows row logic per Fred's
 * clarified spec, UPGRADE_INTENT_EMAIL constant value pin.
 */
import { describe, it, expect } from "vitest";
import {
  TIER_ORDER,
  UPGRADE_INTENT_EMAIL,
  mapTierToLabel,
  nextTier,
  tierFeatures,
  recommendedTierFor,
  buildComparisonRows,
  isKnownTier,
} from "../tier-labels";

describe("tier-labels — KAN-829 sub-cohort 6", () => {
  it("Test 1 — mapTierToLabel returns Title Case for all four tiers", () => {
    expect(mapTierToLabel("free")).toBe("Free");
    expect(mapTierToLabel("starter")).toBe("Starter");
    expect(mapTierToLabel("pro")).toBe("Pro");
    expect(mapTierToLabel("enterprise")).toBe("Enterprise");
  });

  it("Test 2 — nextTier synonym-skip: free + starter both jump to pro; pro→enterprise; enterprise→null", () => {
    expect(nextTier("free")).toBe("pro");
    expect(nextTier("starter")).toBe("pro");
    expect(nextTier("pro")).toBe("enterprise");
    expect(nextTier("enterprise")).toBeNull();
  });

  it("Test 3 — tierFeatures values match the server-side knowledge-tier-limits.ts map (drift-loud)", () => {
    // If this test fails the client mirror has drifted from the server.
    // Fix BOTH sides or KAN-848 (the consolidation ticket).
    expect(tierFeatures("free")).toEqual({
      maxSources: 1,
      maxFileSizeMb: 0,
      allowsPdf: false,
      description: "1 source, paste text only",
    });
    expect(tierFeatures("starter")).toEqual({
      maxSources: 1,
      maxFileSizeMb: 0,
      allowsPdf: false,
      description: "1 source, paste text only",
    });
    expect(tierFeatures("pro")).toEqual({
      maxSources: 5,
      maxFileSizeMb: 5,
      allowsPdf: true,
      description: "5 sources, PDF up to 5 MB",
    });
    expect(tierFeatures("enterprise")).toEqual({
      maxSources: 9999,
      maxFileSizeMb: 10,
      allowsPdf: true,
      description: "9,999 sources, PDF up to 10 MB",
    });
  });

  it("Test 4 — recommendedTierFor count-at-limit: free→pro, starter→pro, pro→enterprise, enterprise→null", () => {
    expect(recommendedTierFor("count-at-limit", "free")).toBe("pro");
    expect(recommendedTierFor("count-at-limit", "starter")).toBe("pro");
    expect(recommendedTierFor("count-at-limit", "pro")).toBe("enterprise");
    expect(recommendedTierFor("count-at-limit", "enterprise")).toBeNull();
  });

  it("Test 5 — recommendedTierFor feature-locked: pdf on free/starter→pro; on pro→null (already unlocked)", () => {
    // KAN-XXX dropped FAQ from feature-locked surface; only PDF remains.
    expect(recommendedTierFor("feature-locked", "free", "pdf")).toBe("pro");
    expect(recommendedTierFor("feature-locked", "starter", "pdf")).toBe("pro");
    // Already unlocked — no upgrade recommendation needed
    expect(recommendedTierFor("feature-locked", "pro", "pdf")).toBeNull();
    expect(recommendedTierFor("feature-locked", "enterprise", "pdf")).toBeNull();
  });

  it("Test 6 — buildComparisonRows row logic per Fred's clarified spec", () => {
    // free at limit → [Free (current), Pro (recommended), Enterprise]; skip starter
    expect(buildComparisonRows("free")).toEqual([
      { tier: "free", isCurrent: true, isRecommended: false },
      { tier: "pro", isCurrent: false, isRecommended: true },
      { tier: "enterprise", isCurrent: false, isRecommended: false },
    ]);
    // starter at limit → [Starter (current), Pro (recommended), Enterprise]; skip free
    expect(buildComparisonRows("starter")).toEqual([
      { tier: "starter", isCurrent: true, isRecommended: false },
      { tier: "pro", isCurrent: false, isRecommended: true },
      { tier: "enterprise", isCurrent: false, isRecommended: false },
    ]);
    // pro at limit → [Pro (current), Enterprise (recommended)] — no synthetic third row
    expect(buildComparisonRows("pro")).toEqual([
      { tier: "pro", isCurrent: true, isRecommended: false },
      { tier: "enterprise", isCurrent: false, isRecommended: true },
    ]);
    // enterprise → no comparison (caller renders custom-limit branch)
    expect(buildComparisonRows("enterprise")).toEqual([]);
  });

  it("Test 7 — UPGRADE_INTENT_EMAIL is the canonical pre-launch recipient", () => {
    expect(UPGRADE_INTENT_EMAIL).toBe("fred@axisone.io");
  });

  it("Test 8 — isKnownTier narrows safely; TIER_ORDER preserves canonical ordering", () => {
    expect(isKnownTier("pro")).toBe(true);
    expect(isKnownTier("growth")).toBe(false); // KAN-848 future rename
    expect(isKnownTier("")).toBe(false);
    expect(TIER_ORDER).toEqual(["free", "starter", "pro", "enterprise"]);
  });
});
