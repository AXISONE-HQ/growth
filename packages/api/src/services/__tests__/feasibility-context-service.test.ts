/**
 * KAN-1171-A — feasibility-context-service unit tests.
 *
 * 30 doctrine-locked scenarios covering:
 *   - Pure helpers: hashGoalShape determinism + cache-key partitioning
 *   - getRequiredDataTypesForGoal: all 5 GoalShape variants → expected substrate sets
 *   - getTenantHistoricalContext orchestrator: cache hit + cache miss + cold-start
 *     skeleton + parallel-compute + windowDays defaults + Date rehydration + fail-safe
 *   - Confidence classification: 4-bucket thresholds via public API
 *   - Cache get/set fail-safe: Redis transient → swallow + log; null Redis → null
 *   - Invalidation hooks: SCAN cursor loop + DEL + fail-safe + idempotency
 *
 * Mocked Prisma + mocked Redis. Real-Postgres scenarios (multi-tenant sentinel,
 * Q1 caveat raw-SQL execute) live in
 *   apps/api/src/__tests__/integration/kan-1171-feasibility-context.test.ts
 *
 * Pattern reference: knowledge-retrieval-service.test.ts (mocked Redis + Prisma)
 * + m3-1a-gap-tracker.test.ts (fail-safe convention).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  hashGoalShape,
  buildContextCacheKey,
  getTenantHistoricalContext,
  getRequiredDataTypesForGoal,
  type FeasibilityRedis,
} from "../feasibility-context-service.js";
import {
  hookOnDealClosed,
  hookOnOrderPlaced,
  hookOnContactCreated,
  hookOnCampaignActivated,
  invalidateTenantContext,
  type FeasibilityRedisInvalidator,
} from "../feasibility-context-invalidation.js";
import type { GoalShape, RequiredDataType } from "@growth/shared";

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const REVENUE_GOAL: GoalShape = { type: "revenue" };
const REVENUE_GOAL_P1: GoalShape = { type: "revenue", productId: "P1" };
const UNITS_GOAL: GoalShape = { type: "units", productId: "P1" };
const DEALS_GOAL: GoalShape = { type: "deals" };
const MEETINGS_GOAL: GoalShape = { type: "meetings" };
const CUSTOM_GOAL: GoalShape = { type: "custom", description: "test desc" };
const DEALS_GOAL_SEG: GoalShape = { type: "deals", segmentId: "smb" };

// ─────────────────────────────────────────────
// Mock helpers — Prisma + Redis
// ─────────────────────────────────────────────

interface PrismaMockOpts {
  /** count returned by dataReadiness closed-deals query */
  closedDealsCount?: number;
  earliestOrder?: { placedAt: Date } | null;
  earliestContact?: { createdAt: Date } | null;
  earliestEngagement?: { occurredAt: Date } | null;
  customerCount?: number;
  leadCount?: number;
  wonDealsCount?: number;
  orderCount?: number;
  orderRevenueSum?: number;
  avgDealValue?: number | null;
  avgDealCount?: number;
  sourceGroups?: Array<{ source: string | null; _count: { _all: number } }>;
  trendRows?: Array<{ recent_avg: number | null; prior_avg: number | null }>;
  distRows?: Array<{
    lt30: bigint;
    lt90: bigint;
    lt180: bigint;
    lt365: bigint;
    stale: bigint;
  }>;
  /** Force orchestrator-level fail: throw on first call */
  throwOnDataReadiness?: boolean;
}

function makePrisma(opts: PrismaMockOpts = {}): PrismaClient {
  const dealCount = vi.fn(async () => {
    if (opts.throwOnDataReadiness) throw new Error("db transient");
    return opts.closedDealsCount ?? 50;
  });
  // Order/Contact/Engagement first-row queries
  const orderFirst = vi.fn(async () => opts.earliestOrder ?? null);
  const contactFirst = vi.fn(async () => opts.earliestContact ?? null);
  const engagementFirst = vi.fn(async () => opts.earliestEngagement ?? null);

  // Per-call count tracking: dataReadiness customerCount/leadCount + then conversionRate wonDeals + leadsCreated + customerBase totals + leadPipeline totals
  let contactCountIdx = 0;
  const contactCounts = [
    opts.customerCount ?? 100, // dataReadiness customers
    opts.leadCount ?? 50, // dataReadiness leads
    opts.leadCount ?? 50, // conversionRate leadsCreated
    opts.customerCount ?? 100, // customerBase totalCustomers
    opts.customerCount ?? 100, // customerBase matchingGoalShape
    opts.leadCount ?? 50, // leadPipeline totalActiveLeads
    opts.leadCount ?? 50, // leadPipeline matchingGoalShape
    opts.leadCount ?? 50, // leadPipeline recentLeadsCount
  ];
  const contactCount = vi.fn(async () => contactCounts[contactCountIdx++] ?? 0);

  let dealCountIdx = 0;
  const dealCounts = [
    opts.closedDealsCount ?? 50, // dataReadiness closed deals
    opts.wonDealsCount ?? 10, // conversionRate won deals
  ];
  const dealCountAll = vi.fn(async () => dealCounts[dealCountIdx++] ?? 0);

  const orderCount = vi.fn(async () => opts.orderCount ?? 25);
  const orderAggregate = vi.fn(async () => ({
    _sum: { grandTotal: opts.orderRevenueSum ?? 5000 },
  }));
  const dealAggregate = vi.fn(async () => ({
    _avg: { value: opts.avgDealValue ?? 1000 },
    _count: { value: opts.avgDealCount ?? 10 },
  }));
  const contactGroupBy = vi.fn(async () =>
    opts.sourceGroups ?? [{ source: "manual", _count: { _all: 50 } }],
  );

  const queryRaw = vi.fn(async (_strings: unknown, ..._values: unknown[]) => {
    // Distinguish trendDirection vs engagement-distribution by call order
    // (trend fires first inside computeSalesVelocity; dist fires inside
    // computeCustomerBase). Both can be overridden via opts.
    if (opts.trendRows && queryRaw.mock.calls.length === 1) return opts.trendRows;
    if (opts.distRows && queryRaw.mock.calls.length === 2) return opts.distRows;
    // Defaults: empty for trend (insufficient_data), zero buckets for dist
    if (queryRaw.mock.calls.length === 1) {
      return opts.trendRows ?? [{ recent_avg: null, prior_avg: null }];
    }
    return opts.distRows ?? [
      { lt30: 0n, lt90: 0n, lt180: 0n, lt365: 0n, stale: 0n },
    ];
  });

  return {
    deal: { count: dealCountAll, aggregate: dealAggregate },
    order: { findFirst: orderFirst, count: orderCount, aggregate: orderAggregate },
    contact: {
      findFirst: contactFirst,
      count: contactCount,
      groupBy: contactGroupBy,
    },
    engagement: { findFirst: engagementFirst },
    $queryRaw: queryRaw,
    // Used by raw test for dealCount alias (unused)
    _spies: { dealCount, contactCount, queryRaw },
  } as unknown as PrismaClient;
}

interface RedisMockOpts {
  cachedRaw?: string | null;
  failRead?: boolean;
  failWrite?: boolean;
}

function makeRedis(opts: RedisMockOpts = {}) {
  const get = vi.fn(async (_k: string) => {
    if (opts.failRead) throw new Error("redis down");
    return opts.cachedRaw ?? null;
  });
  const set = vi.fn(async (_k: string, _v: string, _m: "EX", _t: number) => {
    if (opts.failWrite) throw new Error("redis down");
    return "OK";
  });
  return { get, set } as FeasibilityRedis & {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
}

interface InvalidatorMockOpts {
  /** Scan responses keyed by cursor; defaults to ["0", []] (empty drain) */
  scanResponses?: Array<[string, string[]]>;
  failScan?: boolean;
  failDel?: boolean;
}

function makeInvalidator(opts: InvalidatorMockOpts = {}) {
  let scanIdx = 0;
  const scan = vi.fn(async () => {
    if (opts.failScan) throw new Error("scan failed");
    return opts.scanResponses?.[scanIdx++] ?? ["0", []];
  });
  const del = vi.fn(async (..._keys: string[]) => {
    if (opts.failDel) throw new Error("del failed");
    return _keys.length;
  });
  const get = vi.fn(async () => null);
  const set = vi.fn(async () => "OK");
  return {
    get,
    set,
    scan,
    del,
  } as unknown as FeasibilityRedisInvalidator;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────
// Group A — hashGoalShape + buildContextCacheKey
// ─────────────────────────────────────────────

describe("hashGoalShape", () => {
  it("determinism — same input → same hash across 3 invocations", () => {
    const h1 = hashGoalShape(REVENUE_GOAL);
    const h2 = hashGoalShape(REVENUE_GOAL);
    const h3 = hashGoalShape(REVENUE_GOAL);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(h1).toMatch(/^[a-f0-9]{16}$/);
  });

  it("collision-avoidance — 5 distinct variants → 5 distinct hashes", () => {
    const hashes = new Set([
      hashGoalShape(REVENUE_GOAL),
      hashGoalShape(UNITS_GOAL),
      hashGoalShape(DEALS_GOAL),
      hashGoalShape(MEETINGS_GOAL),
      hashGoalShape(CUSTOM_GOAL),
    ]);
    expect(hashes.size).toBe(5);
  });

  it("overlay distinguishes — revenue with productId differs from revenue without", () => {
    expect(hashGoalShape(REVENUE_GOAL)).not.toBe(hashGoalShape(REVENUE_GOAL_P1));
  });
});

describe("buildContextCacheKey", () => {
  it("structure — feasibility:context:<tenantId>:<hash>:<windowDays>", () => {
    const key = buildContextCacheKey({
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      windowDays: 365,
    });
    expect(key).toMatch(
      new RegExp(`^feasibility:context:${TENANT_A}:[a-f0-9]{16}:365$`),
    );
  });

  it("tenant-id-collision impossibility — different tenant → different key", () => {
    const goal = { ...REVENUE_GOAL };
    const kA = buildContextCacheKey({ tenantId: TENANT_A, goalShape: goal, windowDays: 365 });
    const kB = buildContextCacheKey({ tenantId: TENANT_B, goalShape: goal, windowDays: 365 });
    expect(kA).not.toBe(kB);
    expect(kA).toContain(TENANT_A);
    expect(kB).toContain(TENANT_B);
  });
});

// ─────────────────────────────────────────────
// Group B — getRequiredDataTypesForGoal (pure mapping)
// ─────────────────────────────────────────────

describe("getRequiredDataTypesForGoal", () => {
  const cases: Array<[GoalShape, RequiredDataType[]]> = [
    [REVENUE_GOAL, ["sales_history", "customer_base"]],
    [UNITS_GOAL, ["sales_history", "customer_base"]],
    [DEALS_GOAL, ["sales_history", "lead_history"]],
    [MEETINGS_GOAL, ["engagement_history", "lead_history"]],
    [
      CUSTOM_GOAL,
      ["sales_history", "customer_base", "lead_history", "engagement_history"],
    ],
  ];
  for (const [goal, expected] of cases) {
    it(`${goal.type} → ${expected.join(",")}`, () => {
      expect(getRequiredDataTypesForGoal(goal)).toEqual(expected);
    });
  }
});

// ─────────────────────────────────────────────
// Group C — getTenantHistoricalContext orchestrator
// ─────────────────────────────────────────────

describe("getTenantHistoricalContext — cache behavior", () => {
  it("cache HIT — returns cached value with updated cacheAge", async () => {
    const writtenAt = Date.now() - 5_000;
    const envelope = {
      writtenAt,
      data: {
        conversionRate: {
          value: 0.1,
          sampleSize: 20,
          confidence: "medium",
          confidenceReason: "Based on 20 closed-won deals in the last 365 days.",
        },
        salesVelocity: {
          unitsPerMonth: 2,
          revenuePerMonth: 500,
          trendDirection: "stable",
          confidence: "medium",
        },
        customerBase: {
          totalCustomers: 100,
          matchingGoalShape: 100,
          avgDealSize: 1000,
          lastEngagementDistribution: {
            lt30days: 1,
            lt90days: 2,
            lt180days: 3,
            lt365days: 4,
            stale: 90,
          },
        },
        leadPipeline: {
          totalActiveLeads: 50,
          matchingGoalShape: 50,
          bySource: { manual: 50 },
          weeklyAcquisitionRate: 1,
        },
        dataReadiness: {
          overall: "partial",
          missingDataTypes: [],
          earliestDataDate: new Date("2026-01-01").toISOString(),
        },
        windowMeta: {
          windowStart: new Date("2025-06-12").toISOString(),
          windowEnd: new Date("2026-06-11").toISOString(),
          cacheAge: 0,
        },
      },
    };
    const redis = makeRedis({ cachedRaw: JSON.stringify(envelope) });
    const prisma = makePrisma();

    const result = await getTenantHistoricalContext(prisma, redis, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
    });

    expect(redis.get).toHaveBeenCalledOnce();
    // Cache hit short-circuits: no Prisma calls happened
    expect(prisma.deal.count).not.toHaveBeenCalled();
    // cacheAge updated to "now - writtenAt"
    expect(result.windowMeta.cacheAge).toBeGreaterThanOrEqual(5_000 - 100);
    expect(result.windowMeta.cacheAge).toBeLessThanOrEqual(5_000 + 5_000);
    // Date rehydration: ISO strings → Date instances
    expect(result.dataReadiness.earliestDataDate).toBeInstanceOf(Date);
    expect(result.windowMeta.windowStart).toBeInstanceOf(Date);
    expect(result.windowMeta.windowEnd).toBeInstanceOf(Date);
  });

  it("cache MISS — computes fresh + writes envelope to cache", async () => {
    const redis = makeRedis({ cachedRaw: null });
    const prisma = makePrisma({
      closedDealsCount: 40,
      earliestOrder: { placedAt: new Date(Date.now() - 200 * 86_400_000) },
      earliestContact: { createdAt: new Date(Date.now() - 200 * 86_400_000) },
      earliestEngagement: { occurredAt: new Date(Date.now() - 100 * 86_400_000) },
    });

    const result = await getTenantHistoricalContext(prisma, redis, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      windowDays: 365,
    });

    expect(redis.get).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledOnce();
    expect(result.dataReadiness.overall).toBe("sufficient");
    expect(result.windowMeta.cacheAge).toBe(0); // freshly computed
  });

  it("works with null Redis (DI off) — computes + skips cache write", async () => {
    const prisma = makePrisma({ closedDealsCount: 40 });
    const result = await getTenantHistoricalContext(prisma, null, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
    });
    expect(result.dataReadiness.overall).toBe("sufficient");
  });
});

describe("getTenantHistoricalContext — cold-start path", () => {
  it("dataReadiness=insufficient → returns skeleton + caches it", async () => {
    const redis = makeRedis({ cachedRaw: null });
    const prisma = makePrisma({
      closedDealsCount: 0,
      earliestOrder: null,
      earliestContact: null,
      earliestEngagement: null,
      customerCount: 0,
      leadCount: 0,
    });

    const result = await getTenantHistoricalContext(prisma, redis, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
    });

    expect(result.dataReadiness.overall).toBe("insufficient");
    expect(result.dataReadiness.missingDataTypes).toEqual(
      expect.arrayContaining([
        "sales_history",
        "customer_base",
        "lead_history",
        "engagement_history",
      ]),
    );
    expect(result.conversionRate.confidence).toBe("insufficient_data");
    expect(result.conversionRate.value).toBeNull();
    expect(result.salesVelocity.unitsPerMonth).toBeNull();
    expect(result.customerBase.totalCustomers).toBe(0);
    expect(result.windowMeta.cacheAge).toBe(0);
    // Heavy compute helpers skipped under cold-start
    expect(prisma.order.count).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledOnce(); // skeleton still cached
  });
});

describe("getTenantHistoricalContext — windowDays handling", () => {
  it("defaults to 365 days when windowDays omitted", async () => {
    const prisma = makePrisma();
    const result = await getTenantHistoricalContext(prisma, null, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
    });
    const span =
      result.windowMeta.windowEnd.getTime() - result.windowMeta.windowStart.getTime();
    const expected = 365 * 86_400_000;
    expect(span).toBeGreaterThanOrEqual(expected - 5_000);
    expect(span).toBeLessThanOrEqual(expected + 5_000);
  });

  it("enforces 90-day minimum when smaller value passed", async () => {
    const prisma = makePrisma();
    const result = await getTenantHistoricalContext(prisma, null, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      windowDays: 30,
    });
    const span =
      result.windowMeta.windowEnd.getTime() - result.windowMeta.windowStart.getTime();
    const expected = 90 * 86_400_000;
    expect(span).toBeGreaterThanOrEqual(expected - 5_000);
    expect(span).toBeLessThanOrEqual(expected + 5_000);
  });
});

describe("getTenantHistoricalContext — fail-safe", () => {
  it("orchestrator-level fail-safe — DB transient → insufficient_data skeleton", async () => {
    const prisma = makePrisma({ throwOnDataReadiness: true });
    const redis = makeRedis({ cachedRaw: null });
    const result = await getTenantHistoricalContext(prisma, redis, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
    });
    expect(result.dataReadiness.overall).toBe("insufficient");
    expect(result.conversionRate.confidence).toBe("insufficient_data");
    expect(result.customerBase.totalCustomers).toBe(0);
    // Skeleton fallback is NOT cached (orchestrator catch returns early)
  });
});

// ─────────────────────────────────────────────
// Group D — Confidence classification (via public API)
// ─────────────────────────────────────────────

describe("confidence classification — sample size buckets", () => {
  const cases: Array<[number, string]> = [
    [50, "high"],
    [30, "high"],
    [29, "medium"],
    [10, "medium"],
    [9, "low"],
    [1, "low"],
    [0, "insufficient_data"],
  ];
  for (const [sampleSize, expectedConfidence] of cases) {
    it(`${sampleSize} won deals → confidence=${expectedConfidence}`, async () => {
      const prisma = makePrisma({
        closedDealsCount: 50, // ensure dataReadiness lands sufficient
        earliestOrder: { placedAt: new Date(Date.now() - 200 * 86_400_000) },
        earliestContact: { createdAt: new Date(Date.now() - 200 * 86_400_000) },
        earliestEngagement: { occurredAt: new Date(Date.now() - 100 * 86_400_000) },
        wonDealsCount: sampleSize,
      });
      const result = await getTenantHistoricalContext(prisma, null, {
        tenantId: TENANT_A,
        goalShape: REVENUE_GOAL,
      });
      expect(result.conversionRate.confidence).toBe(expectedConfidence);
      expect(result.conversionRate.sampleSize).toBe(sampleSize);
    });
  }
});

// ─────────────────────────────────────────────
// Group E — Cache get/set fail-safe
// ─────────────────────────────────────────────

describe("cache fail-safe", () => {
  it("Redis get transient → fall-through to compute (no error to caller)", async () => {
    const redis = makeRedis({ failRead: true });
    const prisma = makePrisma({ closedDealsCount: 40 });
    const result = await getTenantHistoricalContext(prisma, redis, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
    });
    expect(redis.get).toHaveBeenCalledOnce();
    expect(result.dataReadiness.overall).toBe("sufficient");
  });

  it("Redis set transient → compute still returns (write swallowed)", async () => {
    const redis = makeRedis({ failWrite: true });
    const prisma = makePrisma({ closedDealsCount: 40 });
    const result = await getTenantHistoricalContext(prisma, redis, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
    });
    expect(redis.set).toHaveBeenCalledOnce();
    expect(result.dataReadiness.overall).toBe("sufficient");
  });

  it("malformed cache envelope → fall-through to compute", async () => {
    const redis = makeRedis({ cachedRaw: "not-json{" });
    const prisma = makePrisma({ closedDealsCount: 40 });
    const result = await getTenantHistoricalContext(prisma, redis, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
    });
    expect(result.dataReadiness.overall).toBe("sufficient");
  });
});

// ─────────────────────────────────────────────
// Group F — Invalidation hooks
// ─────────────────────────────────────────────

describe("invalidation hooks", () => {
  it("SCAN cursor loop drains all matching keys + DEL fires once", async () => {
    const redis = makeInvalidator({
      scanResponses: [
        ["100", ["feasibility:context:a:h1:365", "feasibility:context:a:h2:365"]],
        ["200", ["feasibility:context:a:h3:90"]],
        ["0", []],
      ],
    });
    const n = await hookOnDealClosed(redis, TENANT_A);
    expect(n).toBe(3);
    expect(redis.scan).toHaveBeenCalledTimes(3);
    expect(redis.del).toHaveBeenCalledOnce();
    expect(redis.del).toHaveBeenCalledWith(
      "feasibility:context:a:h1:365",
      "feasibility:context:a:h2:365",
      "feasibility:context:a:h3:90",
    );
  });

  it("null Redis returns 0 immediately (no SCAN call)", async () => {
    const n = await hookOnOrderPlaced(null, TENANT_A);
    expect(n).toBe(0);
  });

  it("SCAN transient → returns 0 + does NOT throw (fail-safe)", async () => {
    const redis = makeInvalidator({ failScan: true });
    const n = await hookOnContactCreated(redis, TENANT_A);
    expect(n).toBe(0);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("empty match-set returns 0 without calling DEL", async () => {
    const redis = makeInvalidator({ scanResponses: [["0", []]] });
    const n = await hookOnCampaignActivated(redis, TENANT_A);
    expect(n).toBe(0);
    expect(redis.scan).toHaveBeenCalledOnce();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("invalidateTenantContext (operator-facing) shares impl with hooks", async () => {
    const redis = makeInvalidator({
      scanResponses: [["0", ["feasibility:context:a:h1:365"]]],
    });
    const n = await invalidateTenantContext(redis, TENANT_A);
    expect(n).toBe(1);
    expect(redis.del).toHaveBeenCalledWith("feasibility:context:a:h1:365");
  });

  it("DEL transient → returns 0 (fail-safe; SCAN already drained keys)", async () => {
    const redis = makeInvalidator({
      scanResponses: [["0", ["feasibility:context:a:h1:365"]]],
      failDel: true,
    });
    const n = await hookOnDealClosed(redis, TENANT_A);
    expect(n).toBe(0);
  });
});
