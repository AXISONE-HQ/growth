/**
 * KAN-1171-A integration tests — doctrine-critical scenarios.
 *
 * Real Postgres via withRollback. Five it() blocks covering:
 *   1. Cold-start path verification (zero-data tenant → insufficient_data skeleton)
 *   2. Multi-tenant-isolation sentinel (Q5 lock: tenant A query sees ZERO tenant B data)
 *   3. Q1 caveat — trendDirection raw-SQL DATE_TRUNC + AVG window function executes
 *      against real Postgres + correct "up" semantic on seeded distribution
 *   4. Q1 caveat — trendDirection insufficient_data fallback (empty + small-N data)
 *   5. Q1 caveat — lastEngagementDistribution cohort COUNT FILTER + LEFT JOIN on
 *      signal_class='positive' executes + correct bucketing + Q3 lock verification
 *      (negative-class engagements MUST NOT count)
 *
 * Pattern: withRollback + inline fixture seeding (kan-1167-foundation precedent).
 * Helpers from ./setup.ts: getPrisma, createTenant, createContact, createPipeline,
 * createDeal, createOrder. Engagement + lifecycle updates inline (out of setup.ts
 * scope).
 *
 * Q-ADD-1 resolution: inline seeding; helper extraction trigger is 5+ scenarios
 * sharing identical setup (we're at 5 distinct shapes — opportunistic-only).
 */
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { GoalShape, TenantHistoricalContext } from "@growth/shared";
import {
  withRollback,
  createTenant,
  createContact,
  createPipeline,
  createDeal,
  createOrder,
} from "./setup.js";

// KAN-689 cohort — variable-specifier dynamic import keeps helpers out of
// the apps/api rootDir static graph (TS6059 avoidance per
// feedback_cc_prompt_cross_rootdir_imports_must_be_pattern_conformant).
// Same pattern as kan-1167-foundation.test.ts:34-58.
const feasibilityServiceSpec =
  "../../../../../packages/api/src/services/feasibility-context-service.js";

type GetTenantHistoricalContextFn = (
  prisma: unknown,
  redis: unknown | null,
  params: { tenantId: string; goalShape: GoalShape; windowDays?: number },
) => Promise<TenantHistoricalContext>;

type BuildContextCacheKeyFn = (input: {
  tenantId: string;
  goalShape: GoalShape;
  windowDays: number;
}) => string;

async function loadFeasibilityContextService(): Promise<{
  getTenantHistoricalContext: GetTenantHistoricalContextFn;
  buildContextCacheKey: BuildContextCacheKeyFn;
}> {
  return (await import(feasibilityServiceSpec)) as {
    getTenantHistoricalContext: GetTenantHistoricalContextFn;
    buildContextCacheKey: BuildContextCacheKeyFn;
  };
}

/** Thin wrapper — loads the service module via variable-specifier dynamic
 *  import then invokes getTenantHistoricalContext. Saves boilerplate at the
 *  6 callsites below. */
async function fetchContext(
  tx: unknown,
  params: { tenantId: string; goalShape: GoalShape; windowDays?: number },
): Promise<TenantHistoricalContext> {
  const { getTenantHistoricalContext } = await loadFeasibilityContextService();
  return getTenantHistoricalContext(tx, null, params);
}

// ─────────────────────────────────────────────
// Inline helpers — minimal extensions for engagement + lifecycle
// ─────────────────────────────────────────────

async function setCustomer(prisma: PrismaClient, contactId: string): Promise<void> {
  await prisma.contact.update({
    where: { id: contactId },
    data: { lifecycleStage: "customer" },
  });
}

/** Mirror of setup.ts createDeal that also sets closedAt — required so the
 *  service's dataReadiness + conversionRate queries (which filter
 *  `closedAt >= windowStart`) recognize the deal as closed-in-window. The
 *  shared setup.ts createDeal leaves closedAt NULL by default. */
async function createWonDeal(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    pipelineId: string;
    stageId: string;
    value?: number;
    closedAt?: Date;
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
      closedAt: args.closedAt ?? new Date(),
    },
    select: { id: true },
  });
}

async function createEngagement(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    dealId: string;
    contactId: string;
    occurredAt: Date;
    signalClass?: "positive" | "negative" | "neutral";
    engagementType?: string;
  },
): Promise<{ id: string }> {
  return prisma.engagement.create({
    data: {
      tenantId: args.tenantId,
      dealId: args.dealId,
      contactId: args.contactId,
      engagementType: args.engagementType ?? "email_reply",
      signalClass: args.signalClass ?? "positive",
      occurredAt: args.occurredAt,
    },
    select: { id: true },
  });
}

async function createOrderAt(
  prisma: PrismaClient,
  args: { tenantId: string; contactId: string; placedAt: Date; grandTotal?: number },
): Promise<void> {
  await prisma.order.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      orderNumber: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      placedAt: args.placedAt,
      status: "paid",
      currency: "USD",
      grandTotal: args.grandTotal ?? 100,
    },
    select: { id: true },
  });
}

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────
// Scenario 1 — Cold-start path
// ─────────────────────────────────────────────

describe("KAN-1171-A — cold-start path (integration)", () => {
  it("zero-data tenant → insufficient_data skeleton with all 4 missingDataTypes", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const result = await fetchContext(tx, {
        tenantId,
        goalShape: { type: "revenue" },
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
      expect(result.leadPipeline.totalActiveLeads).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 2 — Multi-tenant-isolation sentinel (Q5 lock)
// ─────────────────────────────────────────────

describe("KAN-1171-A — multi-tenant isolation (Q5 sentinel)", () => {
  it("tenant A query sees ZERO tenant B data across all 4 signals", async () => {
    await withRollback(async (tx) => {
      const { id: tenantA } = await createTenant(tx);
      const { id: tenantB } = await createTenant(tx);
      const { id: contactA } = await createContact(tx, tenantA);
      const { id: contactB } = await createContact(tx, tenantB);
      await setCustomer(tx, contactA);
      await setCustomer(tx, contactB);
      const { id: pipelineA, stageId: stageA } = await createPipeline(tx, tenantA);
      const { id: pipelineB, stageId: stageB } = await createPipeline(tx, tenantB);

      // Tenant A: 35 won deals + 35 orders (sufficient + distinct shape)
      for (let i = 0; i < 35; i++) {
        await createWonDeal(tx, {
          tenantId: tenantA,
          contactId: contactA,
          pipelineId: pipelineA,
          stageId: stageA,
          value: 1000,
        });
        await createOrder(tx, { tenantId: tenantA, contactId: contactA });
      }
      // Tenant B: 5 won deals + 5 orders (distinct shape)
      for (let i = 0; i < 5; i++) {
        await createWonDeal(tx, {
          tenantId: tenantB,
          contactId: contactB,
          pipelineId: pipelineB,
          stageId: stageB,
          value: 5000,
        });
        await createOrder(tx, { tenantId: tenantB, contactId: contactB });
      }

      const resultA = await fetchContext(tx, {
        tenantId: tenantA,
        goalShape: { type: "revenue" },
      });
      const resultB = await fetchContext(tx, {
        tenantId: tenantB,
        goalShape: { type: "revenue" },
      });

      // Conversion sampleSize: tenant A has 35 wins, B has 5 — zero leak
      expect(resultA.conversionRate.sampleSize).toBe(35);
      expect(resultB.conversionRate.sampleSize).toBe(5);
      // Customer count: 1 customer per tenant (contacted seeded as customer)
      expect(resultA.customerBase.totalCustomers).toBe(1);
      expect(resultB.customerBase.totalCustomers).toBe(1);
      // avgDealSize reflects each tenant's distinct shape (1000 vs 5000)
      expect(resultA.customerBase.avgDealSize).toBeCloseTo(1000, 0);
      expect(resultB.customerBase.avgDealSize).toBeCloseTo(5000, 0);
    });
  });

  it("cache-key partitioning — different tenant → different cache key (structural)", async () => {
    const { buildContextCacheKey } = await loadFeasibilityContextService();
    const goal = { type: "revenue" as const };
    const kA = buildContextCacheKey({
      tenantId: "tenant-a",
      goalShape: goal,
      windowDays: 365,
    });
    const kB = buildContextCacheKey({
      tenantId: "tenant-b",
      goalShape: goal,
      windowDays: 365,
    });
    expect(kA).not.toBe(kB);
    expect(kA).toContain("tenant-a");
    expect(kB).toContain("tenant-b");
  });
});

// ─────────────────────────────────────────────
// Scenario 3 — Q1 caveat: trendDirection raw-SQL "up" semantic
// ─────────────────────────────────────────────

describe("KAN-1171-A — Q1 caveat trendDirection raw-SQL execute-against-Postgres", () => {
  it("seeded distribution recent > prior by 2x → trendDirection='up'", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const { id: contactId } = await createContact(tx, tenantId);
      await setCustomer(tx, contactId);
      const { id: pipelineId, stageId } = await createPipeline(tx, tenantId);

      // dataReadiness needs ≥30 closed deals + ≥90 days history for 'sufficient'.
      // Seed 35 won deals across the window so dataReadiness passes.
      for (let i = 0; i < 35; i++) {
        await createWonDeal(tx, {
          tenantId,
          contactId,
          pipelineId,
          stageId,
          value: 1000,
        });
      }

      const now = Date.now();
      // windowDays=365; halfway is ~182 days ago. Recent half (0-182): 6
      // months × 5 orders/month = 30 orders. Prior half (183-365): 6 months
      // × 2 orders/month = 12 orders. recent_avg=5, prior_avg=2 → ratio 2.5
      // → "up".
      for (let monthIdx = 0; monthIdx < 6; monthIdx++) {
        const recentMonthDayOffset = -(monthIdx * 30 + 15); // -15, -45, ..., -165
        const priorMonthDayOffset = -(180 + monthIdx * 30 + 15); // -195, ..., -345
        for (let k = 0; k < 5; k++) {
          await createOrderAt(tx, {
            tenantId,
            contactId,
            placedAt: new Date(now + recentMonthDayOffset * DAY_MS),
          });
        }
        for (let k = 0; k < 2; k++) {
          await createOrderAt(tx, {
            tenantId,
            contactId,
            placedAt: new Date(now + priorMonthDayOffset * DAY_MS),
          });
        }
      }
      // Plant an old order to establish ≥90 days of order history.
      await createOrderAt(tx, {
        tenantId,
        contactId,
        placedAt: new Date(now - 200 * DAY_MS),
      });

      const result = await fetchContext(tx, {
        tenantId,
        goalShape: { type: "revenue" },
      });

      expect(result.dataReadiness.overall).toBe("sufficient");
      expect(result.salesVelocity.trendDirection).toBe("up");
      expect(result.salesVelocity.unitsPerMonth).not.toBeNull();
    });
  });

  it("small-N data (<10 orders total) → trendDirection='insufficient_data' + no SQL error", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const { id: contactId } = await createContact(tx, tenantId);
      const { id: pipelineId, stageId } = await createPipeline(tx, tenantId);

      // dataReadiness needs ≥30 closed deals OR ≥90 days history for 'partial'.
      // Seed 12 won deals for partial gradient (still runs the compute helpers).
      for (let i = 0; i < 12; i++) {
        await createWonDeal(tx, {
          tenantId,
          contactId,
          pipelineId,
          stageId,
          value: 1000,
        });
      }
      // Seed 1 ancient contact + 1 ancient order so history >= 30 days for partial
      await createOrderAt(tx, {
        tenantId,
        contactId,
        placedAt: new Date(Date.now() - 60 * DAY_MS),
      });

      const result = await fetchContext(tx, {
        tenantId,
        goalShape: { type: "revenue" },
      });

      // <10 orders total → trendDirection insufficient_data; raw SQL still runs
      // without error (Q1 caveat satisfied — empirically validated)
      expect(result.salesVelocity.trendDirection).toBe("insufficient_data");
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 4 — Q1 caveat: lastEngagementDistribution + Q3 signalClass lock
// ─────────────────────────────────────────────

describe("KAN-1171-A — Q1 caveat lastEngagementDistribution raw-SQL + Q3 signalClass lock", () => {
  it("positive engagements bucket correctly + negative engagements DO NOT count", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const { id: pipelineId, stageId } = await createPipeline(tx, tenantId);

      // Seed 35 closed deals so dataReadiness is sufficient and compute runs.
      const anchorContact = await createContact(tx, tenantId);
      await setCustomer(tx, anchorContact.id);
      for (let i = 0; i < 35; i++) {
        await createWonDeal(tx, {
          tenantId,
          contactId: anchorContact.id,
          pipelineId,
          stageId,
          value: 1000,
        });
      }
      // Plant ancient order so history >= 90 days
      await createOrderAt(tx, {
        tenantId,
        contactId: anchorContact.id,
        placedAt: new Date(Date.now() - 200 * DAY_MS),
      });

      const now = Date.now();
      const seedBucket = async (daysAgo: number, count: number, signalClass: "positive" | "negative") => {
        for (let i = 0; i < count; i++) {
          const c = await createContact(tx, tenantId);
          await setCustomer(tx, c.id);
          const d = await createDeal(tx, {
            tenantId,
            contactId: c.id,
            pipelineId,
            stageId,
            status: "open",
          });
          await createEngagement(tx, {
            tenantId,
            dealId: d.id,
            contactId: c.id,
            occurredAt: new Date(now - daysAgo * DAY_MS),
            signalClass,
          });
        }
      };

      // Positive engagements in known buckets
      await seedBucket(10, 3, "positive"); // lt30days
      await seedBucket(60, 2, "positive"); // lt90days
      await seedBucket(120, 1, "positive"); // lt180days
      await seedBucket(300, 4, "positive"); // lt365days
      // Q3 lock verification: negative engagements at 5 days ago — MUST NOT
      // appear in any bucket. Their customer should land in 'stale' (no
      // positive engagement at all).
      await seedBucket(5, 5, "negative");

      const result = await fetchContext(tx, {
        tenantId,
        goalShape: { type: "revenue" },
      });

      const dist = result.customerBase.lastEngagementDistribution;
      // Positive seed counts land in the right buckets
      expect(dist.lt30days).toBe(3);
      expect(dist.lt90days).toBe(2);
      expect(dist.lt180days).toBe(1);
      expect(dist.lt365days).toBe(4);
      // Q3 lock: 5 negative-engagement customers + 1 anchor (no positive
      // engagement attached) + 0 positive-no-engagement = 6 stale
      expect(dist.stale).toBe(6);
    });
  });
});
