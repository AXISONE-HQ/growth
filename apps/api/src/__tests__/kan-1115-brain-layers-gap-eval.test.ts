/**
 * KAN-1115 — Backend-level test for getBrainLayersImpl.
 *
 * This test EXERCISES the actual backend handler logic (not mocked response
 * shapes) to catch the placement bug that shipped in KAN-1113 (gap rule #1
 * evaluation was below the empty-state early-return, so it never ran for
 * blueprintId=null tenants).
 *
 * The apps/web mocked-response-shape sentinel (page.test.tsx Test #6) did NOT
 * catch this bug because it returned the desired shape from the
 * `dashboardApi.getBrainLayers` mock without exercising backend logic. This
 * is the 3rd recurrence of the mocked-tests-mask-backend-logic pattern
 * (KAN-1089 raw SQL → KAN-1111 raw SQL → KAN-1115 branching logic).
 *
 * Discipline memo (banked post-merge):
 * feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md
 */
import { describe, it, expect } from 'vitest';
import {
  getBrainLayersImpl,
  evaluateDealPricingGap,
  type BrainLayersPrismaSurface,
} from '../services/brain-layers-impl.js';

const TENANT_ID = '9ca85088-f65b-4bac-b098-fff742281ede';

// Builder for a mock Prisma surface matching BrainLayersPrismaSurface.
function buildMockPrisma(opts: {
  tenant?: { blueprintId: string | null; blueprint: { isActive: boolean; vertical: string } | null } | null;
  snapshot?: { companyTruth: unknown; behavioralModel: unknown; outcomeModel: unknown } | null;
  totalDeals?: number;
  dealsWithZeroValue?: number;
}): BrainLayersPrismaSurface {
  return {
    tenant: {
      findUnique: async () => opts.tenant ?? null,
    },
    brainSnapshot: {
      findFirst: async () => opts.snapshot ?? null,
    },
    deal: {
      count: async (args: unknown) => {
        const where = (args as { where: { value?: number } }).where;
        if (where.value === 0) return opts.dealsWithZeroValue ?? 0;
        return opts.totalDeals ?? 0;
      },
    },
  };
}

describe('evaluateDealPricingGap (KAN-1115 helper)', () => {
  it('returns null when totalDeals=0 (no division-by-zero)', () => {
    expect(evaluateDealPricingGap(0, 0)).toBeNull();
  });

  it('returns null when pctMissing <= 25% threshold', () => {
    expect(evaluateDealPricingGap(100, 25)).toBeNull(); // exactly threshold
    expect(evaluateDealPricingGap(100, 20)).toBeNull(); // below threshold
  });

  it('returns gap object when pctMissing > 25% threshold', () => {
    const gap = evaluateDealPricingGap(100, 26);
    expect(gap).not.toBeNull();
    expect(gap?.id).toBe('deal_pricing_missing');
    expect(gap?.severity).toBe('warning');
    expect(gap?.message).toMatch(/26%/);
  });

  it('rounds pctMissing for operator-readable display (AxisOne case: 12/18 = 66.7% → 67%)', () => {
    const gap = evaluateDealPricingGap(18, 12);
    expect(gap?.message).toMatch(/67% of deals missing value/);
  });
});

describe('getBrainLayersImpl — empty-state branch (KAN-1115 placement bug)', () => {
  it('blueprintId=null AND 67% deals zero-value → gap rule #1 STILL FIRES (KAN-1115 fix)', async () => {
    // This is the AxisOne PROD day-1 case. KAN-1113 returned gaps=[]; KAN-1115
    // fix-forward hoists gap rule #1 evaluation above the empty-state branch.
    const prisma = buildMockPrisma({
      tenant: { blueprintId: null, blueprint: null },
      totalDeals: 18,
      dealsWithZeroValue: 12,
    });
    const result = await getBrainLayersImpl(prisma, TENANT_ID);

    expect(result.blueprint.isActive).toBeNull();
    expect(result.overallScore).toBeNull();
    expect(result.companyTruth.pct).toBe(0);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.id).toBe('deal_pricing_missing');
    expect(result.gaps[0]?.message).toMatch(/67% of deals missing value/);
  });

  it('blueprintId=null AND deals under threshold → no gaps (empty-state with no gap)', async () => {
    const prisma = buildMockPrisma({
      tenant: { blueprintId: null, blueprint: null },
      totalDeals: 100,
      dealsWithZeroValue: 20,
    });
    const result = await getBrainLayersImpl(prisma, TENANT_ID);

    expect(result.blueprint.isActive).toBeNull();
    expect(result.gaps).toHaveLength(0);
  });

  it('blueprintId=null AND zero deals → no gaps (no division-by-zero)', async () => {
    const prisma = buildMockPrisma({
      tenant: { blueprintId: null, blueprint: null },
      totalDeals: 0,
      dealsWithZeroValue: 0,
    });
    const result = await getBrainLayersImpl(prisma, TENANT_ID);

    expect(result.gaps).toHaveLength(0);
  });
});

describe('getBrainLayersImpl — populated branch (KAN-1113 cognitive layers)', () => {
  it('Blueprint isActive=true + populated BrainSnapshot → simple average synthesis', async () => {
    const prisma = buildMockPrisma({
      tenant: { blueprintId: 'bp-1', blueprint: { isActive: true, vertical: 'b2b_saas' } },
      snapshot: {
        // All 7 CT categories populated (use non-empty objects/arrays — empty
        // {} is NOT populated per isPopulated semantic).
        companyTruth: {
          products: [{ name: 'P1' }],
          pricing: { tier: 'pro' },
          positioning: { valueProp: 'X' },
          constraints: { region: 'NA' },
          team: { sales: 5 },
          process: { stages: 4 },
          custom: { note: 'x' },
        },
        behavioralModel: { k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5' },
        outcomeModel: { k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5' },
      },
      totalDeals: 100,
      dealsWithZeroValue: 10,
    });
    const result = await getBrainLayersImpl(prisma, TENANT_ID);

    expect(result.blueprint.isActive).toBe(true);
    expect(result.blueprint.vertical).toBe('b2b_saas');
    expect(result.companyTruth.pct).toBe(100);
    expect(result.behavioralLearning.pct).toBe(100);
    expect(result.outcomeLearning.pct).toBe(100);
    // Simple average: (100 + 100 + 100 + 100) / 4 = 100 (all populated)
    expect(result.overallScore).toBe(100);
  });

  it('Blueprint isActive=false → overallScore capped at 25 (Doctrine 5)', async () => {
    const prisma = buildMockPrisma({
      tenant: { blueprintId: 'bp-1', blueprint: { isActive: false, vertical: 'b2b_saas' } },
      snapshot: {
        companyTruth: {
          products: [{ n: 'p' }], pricing: { t: 't' }, positioning: { v: 'v' },
          constraints: {}, team: {}, process: {}, custom: {},
        },
        behavioralModel: { k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5' },
        outcomeModel: { k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5' },
      },
      totalDeals: 0,
      dealsWithZeroValue: 0,
    });
    const result = await getBrainLayersImpl(prisma, TENANT_ID);

    expect(result.blueprint.isActive).toBe(false);
    // Even with all layers maxed, score capped at 25 when Blueprint inactive
    expect(result.overallScore).toBeLessThanOrEqual(25);
  });

  it('Blueprint isActive=true + empty companyTruth.pricing → rule #2 fires', async () => {
    const prisma = buildMockPrisma({
      tenant: { blueprintId: 'bp-1', blueprint: { isActive: true, vertical: 'b2b_saas' } },
      snapshot: {
        companyTruth: { products: [{ name: 'P1' }] }, // pricing missing
        behavioralModel: {},
        outcomeModel: {},
      },
      totalDeals: 0,
      dealsWithZeroValue: 0,
    });
    const result = await getBrainLayersImpl(prisma, TENANT_ID);

    const pricingGap = result.gaps.find((g: { id: string }) => g.id === 'company_truth_pricing_empty');
    expect(pricingGap).toBeTruthy();
  });

  it('Blueprint isActive=true + empty competitiveAdvantages → rule #3 fires', async () => {
    const prisma = buildMockPrisma({
      tenant: { blueprintId: 'bp-1', blueprint: { isActive: true, vertical: 'b2b_saas' } },
      snapshot: {
        companyTruth: { positioning: { valueProp: 'X' /* no competitiveAdvantages */ } },
        behavioralModel: {},
        outcomeModel: {},
      },
      totalDeals: 0,
      dealsWithZeroValue: 0,
    });
    const result = await getBrainLayersImpl(prisma, TENANT_ID);

    const competitorGap = result.gaps.find((g: { id: string }) => g.id === 'competitor_positioning_empty');
    expect(competitorGap).toBeTruthy();
  });
});
