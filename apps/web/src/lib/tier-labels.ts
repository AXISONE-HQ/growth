// PROMOTION CANDIDATE: lift into packages/ui (or packages/shared) in KAN-847
// Used by: UpgradePromptDialog (KAN-829 sub-cohort 6), Add Source dialog tier-gating

/**
 * Client-side mirror of the server tier-limits map for upgrade-prompt UX.
 *
 * Mirrors `packages/api/src/services/knowledge-tier-limits.ts`. Keep these
 * values in sync — `tier-labels.test.ts` asserts the parity. KAN-848 will
 * collapse this duplication to a single source of truth (and rename
 * Prisma `pro` → `growth`, `enterprise` → `revenue` per PRD vocab).
 *
 * Why a client mirror exists at all: the upgrade dialog needs to render the
 * comparison table BEFORE the user takes any action. Network round-tripping
 * for a static feature matrix would lag the UX, and the server stays the
 * source of truth on enforcement (403 on quota / 400 on disallowed feature).
 */

/**
 * Single recipient for upgrade-intent mailto links. Swap to upgrades@axisone.io
 * (or similar) when the inbox exists; only `upgrade-prompt-dialog.tsx` should
 * reference this constant. The test file asserts that callers don't hardcode
 * the address inline.
 */
export const UPGRADE_INTENT_EMAIL = "fred@axisone.io";

export const TIER_ORDER = ["free", "starter", "pro", "enterprise"] as const;
export type Tier = (typeof TIER_ORDER)[number];

export interface TierFeatureMap {
  maxSources: number;
  maxFileSizeMb: number;
  allowsPdf: boolean;
  allowsFaq: boolean;
  /** Short "what it includes" copy rendered in the comparison table. */
  description: string;
}

const TIER_FEATURES: Record<Tier, TierFeatureMap> = {
  free: {
    maxSources: 1,
    maxFileSizeMb: 0,
    allowsPdf: false,
    allowsFaq: false,
    description: "1 source, paste text only",
  },
  starter: {
    maxSources: 1,
    maxFileSizeMb: 0,
    allowsPdf: false,
    allowsFaq: false,
    description: "1 source, paste text only",
  },
  pro: {
    maxSources: 5,
    maxFileSizeMb: 5,
    allowsPdf: true,
    allowsFaq: true,
    description: "5 sources, PDF up to 5 MB, FAQ entries",
  },
  enterprise: {
    maxSources: 9999,
    maxFileSizeMb: 10,
    allowsPdf: true,
    allowsFaq: true,
    description: "9,999 sources, PDF up to 10 MB, FAQ entries",
  },
};

const TIER_LABELS: Record<Tier, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  enterprise: "Enterprise",
};

export function mapTierToLabel(tier: Tier): string {
  return TIER_LABELS[tier];
}

export function tierFeatures(tier: Tier): TierFeatureMap {
  return TIER_FEATURES[tier];
}

/**
 * Returns the next *meaningfully different* tier above `tier`, or `null` at
 * the ceiling.
 *
 * Free + starter both map to FREE_LIMITS server-side today.
 * Recommending starter from free would be a no-op upgrade.
 * When KAN-848 differentiates them, this skip becomes naturally inert
 * (each tier has its own limits, no synonyms).
 */
export function nextTier(tier: Tier): Tier | null {
  switch (tier) {
    case "free":
    case "starter":
      return "pro";
    case "pro":
      return "enterprise";
    case "enterprise":
      return null;
  }
}

/**
 * Returns the lowest tier that resolves the upgrade reason. `null` when the
 * user is already at a tier where the reason cannot be resolved by a higher
 * plan (e.g., enterprise count-at-limit — they need a custom-limit conversation).
 */
export function recommendedTierFor(
  reason: "count-at-limit" | "feature-locked",
  currentTier: Tier,
  feature?: "pdf" | "faq",
): Tier | null {
  if (reason === "count-at-limit") {
    return nextTier(currentTier);
  }
  // feature-locked — pdf and faq both unlock at pro
  if (feature === "pdf" || feature === "faq") {
    if (TIER_FEATURES[currentTier][feature === "pdf" ? "allowsPdf" : "allowsFaq"]) {
      return null;
    }
    return "pro";
  }
  return null;
}

/**
 * Builds the comparison-table rows per Fred's clarified row logic:
 *  - free       → [Free (current), Pro (recommended), Enterprise]
 *  - starter    → [Starter (current), Pro (recommended), Enterprise]
 *  - pro        → [Pro (current), Enterprise (recommended)]
 *  - enterprise → []  (custom-limit branch; caller hides the table)
 *
 * Synonym skip: from `free` we never show `starter`, from `starter` we never
 * show `free` — both are FREE_LIMITS server-side, so listing both is noise.
 */
export interface ComparisonRow {
  tier: Tier;
  isCurrent: boolean;
  isRecommended: boolean;
}

export function buildComparisonRows(currentTier: Tier): ComparisonRow[] {
  if (currentTier === "enterprise") return [];
  if (currentTier === "pro") {
    return [
      { tier: "pro", isCurrent: true, isRecommended: false },
      { tier: "enterprise", isCurrent: false, isRecommended: true },
    ];
  }
  // free or starter — current + Pro (recommended) + Enterprise (top)
  return [
    { tier: currentTier, isCurrent: true, isRecommended: false },
    { tier: "pro", isCurrent: false, isRecommended: true },
    { tier: "enterprise", isCurrent: false, isRecommended: false },
  ];
}

/** Type-narrowing helper — accepts the Prisma string column safely. */
export function isKnownTier(tier: string): tier is Tier {
  return (TIER_ORDER as readonly string[]).includes(tier);
}
