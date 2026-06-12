/**
 * KAN-1178 — FeasibilityContextService comprehensive integration tests.
 *
 * Sibling to KAN-1171-A (doctrine-critical) — this PR adds the comprehensive
 * verification surface deferred per the discipline-lock-honored split.
 * Real Postgres via withRollback + FakeRedis for cache/invalidation E2E.
 *
 * 9 scenarios across 4 groups:
 *   Group A — Per-method base (4):
 *     1. Sufficient data → full result shape + windowDays default 365
 *     2. Partial data → 'partial' overall + populated signals
 *     3. getRequiredDataTypesForGoal parameterized over 5 GoalShape variants
 *     4. windowDays minimum 90 enforced
 *   Group B — Cache TTL (2):
 *     5. Cache write then read returns cached value with updated cacheAge
 *     6. Cache write + manual delete → next read computes fresh
 *   Group C — Invalidation E2E (parameterized over 4 hooks):
 *     7-10. hookOnDealClosed / hookOnOrderPlaced / hookOnContactCreated /
 *           hookOnCampaignActivated each clear tenant cache; next read fresh
 *   Group D — GoalShape overlay (1):
 *     11. segmentId overlay excludes non-matching segment customers
 *
 * KAN-689 cohort 5th validated callsite — variable-specifier dynamic imports
 * for cross-rootDir TS6059 avoidance.
 *
 * Q-ADD-A: FakeRedis pattern (Q-ADD-2 lock from PR 2a Phase 1 preserved —
 *   no Redis testcontainer; in-memory Map suffices for cache mechanics)
 * Q-ADD-B: Inline fixture seeding (Q-ADD-1 lock from KAN-1171 Phase 1)
 * Q-ADD-C: windowDays default scenario folded into #1 sufficient-path
 *
 * Pre-flight: Memo 35 unit-vs-integration refinement applied — CI is the
 * canonical KAN-1112 verification surface for integration test PRs;
 * substitute-gate + typecheck local pre-flight is sufficient.
 */
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { GoalShape, TenantHistoricalContext } from "@growth/shared";
import {
  withRollback,
  createTenant,
  createContact,
  createPipeline,
  createOrder,
} from "./setup.js";

// ─────────────────────────────────────────────
// KAN-689 dynamic-import specs
// ─────────────────────────────────────────────

const serviceSpec =
  "../../../../../packages/api/src/services/feasibility-context-service.js";
const invalidationSpec =
  "../../../../../packages/api/src/services/feasibility-context-invalidation.js";

type ServiceModule = {
  getTenantHistoricalContext: (
    prisma: unknown,
    redis: unknown | null,
    params: { tenantId: string; goalShape: GoalShape; windowDays?: number },
  ) => Promise<TenantHistoricalContext>;
  getRequiredDataTypesForGoal: (g: GoalShape) => string[];
  buildContextCacheKey: (input: {
    tenantId: string;
    goalShape: GoalShape;
    windowDays: number;
  }) => string;
};

type HookFn = (redis: unknown, tenantId: string) => Promise<number>;

type InvalidationModule = {
  hookOnDealClosed: HookFn;
  hookOnOrderPlaced: HookFn;
  hookOnContactCreated: HookFn;
  hookOnCampaignActivated: HookFn;
  invalidateTenantContext: HookFn;
};

async function loadService(): Promise<ServiceModule> {
  return (await import(serviceSpec)) as ServiceModule;
}

async function loadInvalidation(): Promise<InvalidationModule> {
  return (await import(invalidationSpec)) as InvalidationModule;
}

// ─────────────────────────────────────────────
// FakeRedis — in-memory implementation of FeasibilityRedis +
// FeasibilityRedisInvalidator interfaces (Q-ADD-A: mocked Redis preserves
// the PR 2a Q-ADD-2 lock; no testcontainer needed for cache mechanics).
// ─────────────────────────────────────────────

class FakeRedis {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _mode: "EX",
    _ttlSeconds: number,
  ): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }

  async scan(
    _cursor: string,
    _matchToken: "MATCH",
    pattern: string,
    _countToken: "COUNT",
    _count: number,
  ): Promise<[string, string[]]> {
    // Single-iteration scan returning all matching keys
    const regexSource = "^" + pattern.replace(/\*/g, ".*") + "$";
    const regex = new RegExp(regexSource);
    const matches = Array.from(this.store.keys()).filter((k) => regex.test(k));
    return ["0", matches];
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
    }
    return count;
  }

  // Test-introspection surface
  size(): number {
    return this.store.size;
  }

  manualDelete(key: string): void {
    this.store.delete(key);
  }
}

// ─────────────────────────────────────────────
// Inline helpers (mirror KAN-1179 pattern — Q-ADD-B inline-with-extract-on-≥5)
// ─────────────────────────────────────────────

const DAY_MS = 86_400_000;

async function setCustomer(
  prisma: PrismaClient,
  contactId: string,
): Promise<void> {
  await prisma.contact.update({
    where: { id: contactId },
    data: { lifecycleStage: "customer" },
  });
}

async function createWonDeal(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    pipelineId: string;
    stageId: string;
    value?: number;
  },
): Promise<{ id: string }> {
  return prisma.deal.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      pipelineId: args.pipelineId,
      currentStageId: args.stageId,
      status: "won",
      value: args.value ?? 1000,
      closedAt: new Date(),
    },
    select: { id: true },
  });
}

async function createOrderAt(
  prisma: PrismaClient,
  args: { tenantId: string; contactId: string; placedAt: Date },
): Promise<void> {
  await prisma.order.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      orderNumber: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      placedAt: args.placedAt,
      status: "paid",
      currency: "USD",
      grandTotal: 5000,
    },
    select: { id: true },
  });
}

/** Seed sufficient-readiness data (≥30 closed deals + ≥90 days history). */
async function seedSufficientTenant(
  tx: PrismaClient,
  tenantId: string,
): Promise<{ contactId: string }> {
  const { id: contactId } = await createContact(tx, tenantId);
  await setCustomer(tx, contactId);
  const { id: pipelineId, stageId } = await createPipeline(tx, tenantId);
  for (let i = 0; i < 35; i++) {
    await createWonDeal(tx, { tenantId, contactId, pipelineId, stageId, value: 1000 });
  }
  await createOrderAt(tx, {
    tenantId,
    contactId,
    placedAt: new Date(Date.now() - 200 * DAY_MS),
  });
  for (let i = 0; i < 24; i++) {
    await createOrder(tx, { tenantId, contactId });
  }
  return { contactId };
}

/** Seed partial-readiness data (≥10 closed deals OR ≥30 days history). */
async function seedPartialTenant(
  tx: PrismaClient,
  tenantId: string,
): Promise<{ contactId: string }> {
  const { id: contactId } = await createContact(tx, tenantId);
  const { id: pipelineId, stageId } = await createPipeline(tx, tenantId);
  for (let i = 0; i < 12; i++) {
    await createWonDeal(tx, { tenantId, contactId, pipelineId, stageId });
  }
  await createOrderAt(tx, {
    tenantId,
    contactId,
    placedAt: new Date(Date.now() - 60 * DAY_MS),
  });
  return { contactId };
}

// ─────────────────────────────────────────────
// Group A — Per-method base (4 scenarios)
// ─────────────────────────────────────────────

describe("KAN-1178 Group A — Per-method base", () => {
  it("Sufficient data → 'sufficient' overall + full signal shape + windowDays default 365", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      await seedSufficientTenant(tx as unknown as PrismaClient, tenantId);
      const { getTenantHistoricalContext } = await loadService();

      const result = await getTenantHistoricalContext(tx, null, {
        tenantId,
        goalShape: { type: "revenue" },
      });

      expect(result.dataReadiness.overall).toBe("sufficient");
      expect(result.conversionRate.confidence).toBe("high");
      expect(result.salesVelocity.unitsPerMonth).not.toBeNull();
      expect(result.customerBase.totalCustomers).toBeGreaterThan(0);
      expect(result.leadPipeline).toBeDefined();
      // windowDays default = 365
      const span =
        (result.windowMeta.windowEnd.getTime() -
          result.windowMeta.windowStart.getTime()) /
        DAY_MS;
      expect(span).toBeGreaterThanOrEqual(364.9);
      expect(span).toBeLessThanOrEqual(365.1);
    });
  });

  it("Partial data → 'partial' overall + populated signals", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      await seedPartialTenant(tx as unknown as PrismaClient, tenantId);
      const { getTenantHistoricalContext } = await loadService();

      const result = await getTenantHistoricalContext(tx, null, {
        tenantId,
        goalShape: { type: "revenue" },
      });

      expect(result.dataReadiness.overall).toBe("partial");
      expect(result.conversionRate.sampleSize).toBe(12);
    });
  });

  it("getRequiredDataTypesForGoal parameterized over 5 GoalShape variants", async () => {
    const { getRequiredDataTypesForGoal } = await loadService();
    expect(getRequiredDataTypesForGoal({ type: "revenue" })).toEqual([
      "sales_history",
      "customer_base",
    ]);
    expect(
      getRequiredDataTypesForGoal({ type: "units", productId: "P1" }),
    ).toEqual(["sales_history", "customer_base"]);
    expect(getRequiredDataTypesForGoal({ type: "deals" })).toEqual([
      "sales_history",
      "lead_history",
    ]);
    expect(getRequiredDataTypesForGoal({ type: "meetings" })).toEqual([
      "engagement_history",
      "lead_history",
    ]);
    expect(
      getRequiredDataTypesForGoal({ type: "custom", description: "test" }),
    ).toEqual(["sales_history", "customer_base", "lead_history", "engagement_history"]);
  });

  it("windowDays minimum 90 enforced when caller passes a smaller value", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const { getTenantHistoricalContext } = await loadService();
      const result = await getTenantHistoricalContext(tx, null, {
        tenantId,
        goalShape: { type: "revenue" },
        windowDays: 30,
      });
      const span =
        (result.windowMeta.windowEnd.getTime() -
          result.windowMeta.windowStart.getTime()) /
        DAY_MS;
      expect(span).toBeGreaterThanOrEqual(89.9);
      expect(span).toBeLessThanOrEqual(90.1);
    });
  });
});

// ─────────────────────────────────────────────
// Group B — Cache TTL behavior (2 scenarios)
// ─────────────────────────────────────────────

describe("KAN-1178 Group B — Cache TTL behavior", () => {
  it("Cache write then read returns cached value with updated cacheAge", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      await seedSufficientTenant(tx as unknown as PrismaClient, tenantId);
      const redis = new FakeRedis();
      const { getTenantHistoricalContext } = await loadService();

      // First call: cache MISS → compute + write envelope
      const first = await getTenantHistoricalContext(tx, redis as unknown, {
        tenantId,
        goalShape: { type: "revenue" },
      });
      expect(first.windowMeta.cacheAge).toBe(0);
      expect(redis.size()).toBeGreaterThan(0);

      // Brief delay so cacheAge increments measurably
      await new Promise((r) => setTimeout(r, 5));

      // Second call: cache HIT → cacheAge > 0
      const second = await getTenantHistoricalContext(tx, redis as unknown, {
        tenantId,
        goalShape: { type: "revenue" },
      });
      expect(second.windowMeta.cacheAge).toBeGreaterThan(0);
    });
  });

  it("Cache write + manual key delete → next read computes fresh (cacheAge=0)", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      await seedSufficientTenant(tx as unknown as PrismaClient, tenantId);
      const redis = new FakeRedis();
      const { getTenantHistoricalContext, buildContextCacheKey } = await loadService();

      await getTenantHistoricalContext(tx, redis as unknown, {
        tenantId,
        goalShape: { type: "revenue" },
      });

      const cacheKey = buildContextCacheKey({
        tenantId,
        goalShape: { type: "revenue" },
        windowDays: 365,
      });
      redis.manualDelete(cacheKey);

      const fresh = await getTenantHistoricalContext(tx, redis as unknown, {
        tenantId,
        goalShape: { type: "revenue" },
      });
      expect(fresh.windowMeta.cacheAge).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────
// Group C — Invalidation E2E (1 parameterized over 4 hooks = 4 sub-scenarios)
// ─────────────────────────────────────────────

describe("KAN-1178 Group C — Invalidation E2E", () => {
  const HOOK_NAMES = [
    "hookOnDealClosed",
    "hookOnOrderPlaced",
    "hookOnContactCreated",
    "hookOnCampaignActivated",
  ] as const;

  for (const hookName of HOOK_NAMES) {
    it(`${hookName} clears tenant cache; next read computes fresh`, async () => {
      await withRollback(async (tx) => {
        const { id: tenantId } = await createTenant(tx);
        await seedSufficientTenant(tx as unknown as PrismaClient, tenantId);
        const redis = new FakeRedis();
        const { getTenantHistoricalContext } = await loadService();
        const invalidation = await loadInvalidation();

        // Populate cache
        await getTenantHistoricalContext(tx, redis as unknown, {
          tenantId,
          goalShape: { type: "revenue" },
        });
        expect(redis.size()).toBeGreaterThan(0);

        // Fire the hook
        const deletedCount = await invalidation[hookName](
          redis as unknown,
          tenantId,
        );
        expect(deletedCount).toBeGreaterThan(0);
        expect(redis.size()).toBe(0);

        // Next read computes fresh
        const after = await getTenantHistoricalContext(tx, redis as unknown, {
          tenantId,
          goalShape: { type: "revenue" },
        });
        expect(after.windowMeta.cacheAge).toBe(0);
      });
    });
  }
});

// ─────────────────────────────────────────────
// Group D — GoalShape overlay (1 scenario)
// ─────────────────────────────────────────────

describe("KAN-1178 Group D — GoalShape overlay", () => {
  it("segmentId='A' overlay → matchingGoalShape excludes segment-B customers", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const { id: pipelineId, stageId } = await createPipeline(tx, tenantId);

      // Seed 5 customers in segment A
      for (let i = 0; i < 5; i++) {
        const { id: contactId } = await createContact(tx, tenantId);
        await tx.contact.update({
          where: { id: contactId },
          data: { lifecycleStage: "customer", segment: "A" },
        });
        await createWonDeal(tx, { tenantId, contactId, pipelineId, stageId });
      }
      // Seed 7 customers in segment B
      for (let i = 0; i < 7; i++) {
        const { id: contactId } = await createContact(tx, tenantId);
        await tx.contact.update({
          where: { id: contactId },
          data: { lifecycleStage: "customer", segment: "B" },
        });
        await createWonDeal(tx, { tenantId, contactId, pipelineId, stageId });
      }
      // Plant ancient order to establish ≥90-day history (for partial-readiness)
      const { id: anchor } = await createContact(tx, tenantId);
      await createOrderAt(tx, {
        tenantId,
        contactId: anchor,
        placedAt: new Date(Date.now() - 200 * DAY_MS),
      });

      const { getTenantHistoricalContext } = await loadService();

      const resultA = await getTenantHistoricalContext(tx, null, {
        tenantId,
        goalShape: { type: "revenue", segmentId: "A" },
      });
      const resultAll = await getTenantHistoricalContext(tx, null, {
        tenantId,
        goalShape: { type: "revenue" },
      });

      expect(resultA.customerBase.matchingGoalShape).toBe(5);
      expect(resultAll.customerBase.matchingGoalShape).toBe(12);
    });
  });
});
