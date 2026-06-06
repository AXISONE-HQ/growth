/**
 * KAN-1113 (KAN-1108b) Brain Layers cognitive-readiness implementation.
 *
 * KAN-1115 fix-forward — Extracted from router.ts inline handler for testability
 * ahead of KAN-1112 raw-SQL integration test infrastructure. The placement bug
 * fixed here (gap rule #1 evaluation hoisted ABOVE the empty-state early-return)
 * was undetectable by the mocked-response-shape sentinel test (Test #6 in
 * `apps/web/src/app/dashboard/__tests__/page.test.tsx`) — the mocked test
 * returned the desired shape from the adapter mock without exercising backend
 * logic.
 *
 * This module is the testable backend boundary: tests in
 * `apps/api/src/__tests__/kan-1115-brain-layers-gap-eval.test.ts` mock the
 * Prisma client at the data-shape level and assert the actual handler logic
 * produces the expected response.
 *
 * Phase 1 + 1.5 LOCKED DECISIONS (Fred + PO 2026-06-06; see KAN-1113 ticket):
 * - Layer 1 Blueprint: boolean Active/Inactive
 * - Layer 2 Company Truth: populated_categories / 7 (Zod-declared categories)
 * - Layer 3 Behavioral: behavioralModel JSON top-level populated keys / 5
 * - Layer 4 Outcome: outcomeModel JSON top-level populated keys / 5
 * - HYBRID empty-state: blueprintId IS NULL → empty-state branch. isActive=false
 *   → Doctrine-gated cap 25. isActive=true → simple average.
 * - KAN-1115 fix-forward: gap rule #1 (Deal pricing) evaluates regardless of
 *   Blueprint state — it depends only on Deal table, not on cognitive infra.
 * - HARD RULE: NO raw SQL (per KAN-1111 banked memo; KAN-1112 prerequisite).
 */

export interface BrainLayersResponse {
  blueprint: { isActive: boolean | null; vertical: string | null };
  companyTruth: { populated: number; total: number; pct: number };
  behavioralLearning: { pct: number };
  outcomeLearning: { pct: number };
  overallScore: number | null;
  gaps: Array<{ id: string; message: string; severity: 'info' | 'warning' }>;
}

const CT_CATEGORIES = [
  'products', 'pricing', 'positioning', 'constraints', 'team', 'process', 'custom',
] as const;
const BM_EXPECTED = 5;
const OM_EXPECTED = 5;
const DEAL_PRICING_GAP_THRESHOLD_PCT = 25;

function isPopulated(val: unknown): boolean {
  if (val == null) return false;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val as object).length > 0;
  if (typeof val === 'string') return val.length > 0;
  return true;
}

/**
 * Minimal Prisma-client surface required by getBrainLayersImpl. Defined here
 * (vs importing the full PrismaClient type) so the test file can pass a
 * lightweight mock object that only implements these 3 methods.
 */
export interface BrainLayersPrismaSurface {
  tenant: {
    findUnique: (args: unknown) => Promise<
      | { blueprintId: string | null; blueprint: { isActive: boolean; vertical: string } | null }
      | null
    >;
  };
  brainSnapshot: {
    findFirst: (args: unknown) => Promise<
      | { companyTruth: unknown; behavioralModel: unknown; outcomeModel: unknown }
      | null
    >;
  };
  deal: {
    count: (args: unknown) => Promise<number>;
  };
}

/**
 * Pure helper — gap rule #1 (Deal.value=0 > 25% threshold). Doesn't depend on
 * Blueprint or BrainSnapshot, so evaluates regardless of cognitive-infra state.
 * Returns the gap object when threshold exceeded, null otherwise.
 */
export function evaluateDealPricingGap(
  totalDeals: number,
  dealsWithZeroValue: number,
): { id: string; message: string; severity: 'warning' } | null {
  if (totalDeals === 0) return null;
  const pctMissing = Math.round((dealsWithZeroValue / totalDeals) * 100);
  if (pctMissing <= DEAL_PRICING_GAP_THRESHOLD_PCT) return null;
  return {
    id: 'deal_pricing_missing',
    message: `Pricing data incomplete — ${pctMissing}% of deals missing value`,
    severity: 'warning',
  };
}

export async function getBrainLayersImpl(
  prisma: BrainLayersPrismaSurface,
  tenantId: string,
): Promise<BrainLayersResponse> {
  // KAN-1115 fix-forward — hoist Deal aggregation + gap rule #1 evaluation
  // ABOVE the empty-state early-return. Rule #1 depends only on Deal table;
  // it's evaluatable even when blueprintId IS NULL. Without this hoist,
  // AxisOne day-1 PROD returns gaps=[] instead of the expected 67%-pricing
  // gap signal.
  const [tenant, totalDeals, dealsWithZeroValue] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        blueprintId: true,
        blueprint: { select: { isActive: true, vertical: true } },
      },
    }),
    prisma.deal.count({ where: { tenantId, deletedAt: null } }),
    prisma.deal.count({ where: { tenantId, deletedAt: null, value: 0 } }),
  ]);

  const dealPricingGap = evaluateDealPricingGap(totalDeals, dealsWithZeroValue);

  // Item 5 HYBRID empty-state: blueprintId IS NULL → empty-state branch fires
  // for entire panel. Honest Doctrine 5 framing: "engine has no starting
  // model yet". The UI consumes `blueprint.isActive = null` as the empty
  // signal. KAN-1115: gap rule #1 fires here too if Deal threshold met.
  if (!tenant?.blueprintId || !tenant.blueprint) {
    return {
      blueprint: { isActive: null, vertical: null },
      companyTruth: { populated: 0, total: CT_CATEGORIES.length, pct: 0 },
      behavioralLearning: { pct: 0 },
      outcomeLearning: { pct: 0 },
      overallScore: null,
      gaps: dealPricingGap ? [dealPricingGap] : [],
    };
  }

  // Read latest BrainSnapshot (orderBy version desc; null when not yet written
  // — Phase 1.5 finding: AxisOne PROD has none today).
  const snapshot = await prisma.brainSnapshot.findFirst({
    where: { tenantId },
    orderBy: { version: 'desc' },
    select: { companyTruth: true, behavioralModel: true, outcomeModel: true },
  });

  // Layer 2 — Company Truth: 7 canonical categories.
  const ct = (snapshot?.companyTruth ?? {}) as Record<string, unknown>;
  const ctPopulated = CT_CATEGORIES.filter((cat) => isPopulated(ct[cat])).length;
  const ctPct = Math.round((ctPopulated / CT_CATEGORIES.length) * 100);

  // Layer 3 — Behavioral Learning: behavioralModel JSON top-level populated keys.
  const bm = (snapshot?.behavioralModel ?? {}) as Record<string, unknown>;
  const bmPopulated = Object.values(bm).filter(isPopulated).length;
  const bmPct = Math.min(100, Math.round((bmPopulated / BM_EXPECTED) * 100));

  // Layer 4 — Outcome Learning: same pattern as Layer 3.
  const om = (snapshot?.outcomeModel ?? {}) as Record<string, unknown>;
  const omPopulated = Object.values(om).filter(isPopulated).length;
  const omPct = Math.min(100, Math.round((omPopulated / OM_EXPECTED) * 100));

  // Overall Intelligence Score HYBRID:
  // - isActive=false → Doctrine-gated cap 25
  // - isActive=true → simple average of 4 layers (Blueprint = 100 when active)
  const blueprintPct = tenant.blueprint.isActive ? 100 : 0;
  const rawAvg = (blueprintPct + ctPct + bmPct + omPct) / 4;
  const overallScore = tenant.blueprint.isActive
    ? Math.round(rawAvg)
    : Math.min(25, Math.round(rawAvg));

  // Gap detection — rules #2 + #3 (rule #1 was evaluated above the empty-state
  // branch). KAN-1114 replaces all 3 hardcoded rules with blueprint-config-diff
  // system in Phase 3+.
  const gaps: Array<{ id: string; message: string; severity: 'info' | 'warning' }> = [];

  // Rule #1 — Deal pricing gap (already evaluated above; include if firing).
  if (dealPricingGap) gaps.push(dealPricingGap);

  // Rule #2 — Company Truth pricing not yet defined.
  if (!isPopulated(ct['pricing'])) {
    gaps.push({
      id: 'company_truth_pricing_empty',
      message: 'Pricing not yet defined in Company Truth',
      severity: 'info',
    });
  }

  // Rule #3 — Competitive positioning not yet ingested.
  const positioning = ct['positioning'] as Record<string, unknown> | undefined;
  if (!isPopulated(positioning?.['competitiveAdvantages'])) {
    gaps.push({
      id: 'competitor_positioning_empty',
      message: 'Competitor positioning not yet ingested',
      severity: 'info',
    });
  }

  return {
    blueprint: {
      isActive: tenant.blueprint.isActive,
      vertical: tenant.blueprint.vertical,
    },
    companyTruth: { populated: ctPopulated, total: CT_CATEGORIES.length, pct: ctPct },
    behavioralLearning: { pct: bmPct },
    outcomeLearning: { pct: omPct },
    overallScore,
    gaps,
  };
}
