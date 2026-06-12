/**
 * KAN-1179 — Feasibility Analyzer integration tests.
 *
 * Real Postgres via withRollback. LLM mocked via recorded fixtures in
 * packages/api/src/services/__tests__/__fixtures__/feasibility-counsel-fixtures.ts.
 *
 * Six scenarios covering the analyzer's full end-to-end orchestration:
 *   1. Cold-start path — zero-data tenant → cold_start_counsel + persist + (no LLM call)
 *   2. Sufficient path — seeded data + LLM fixture → feasibility_counsel + persist
 *   3. Partial path — partial-threshold data + low-confidence framing fixture
 *   4. analyzer_unavailable graceful — LLM throws → variant returned + persist still runs
 *   5. Idempotent re-run — priorCounsel preserved-state in Campaign field
 *   6. Multi-tenant isolation — tenant A's run doesn't affect tenant B's Campaign state
 *
 * KAN-689 cross-rootDir pattern: variable-specifier dynamic import for both
 * the analyzer module and the LLM fixtures module (both live in packages/api,
 * apps/api can't statically import). Mirrors kan-1167-foundation.test.ts:34-58.
 *
 * Q-ADD-D empirical: withRollback wraps the outer $transaction; the analyzer's
 * persistCampaignFeasibility issues prisma.campaign.update against the SAME tx
 * (we pass tx into analyzeFeasibility + persistCampaignFeasibility); rollback
 * sentinel discards all writes. Composes cleanly.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type {
  FeasibilityCounselResult,
  GoalShape,
  ColdStartCounsel,
} from "@growth/shared";
import {
  withRollback,
  createTenant,
  createContact,
  createPipeline,
  createOrder,
  createCommittedCampaign,
} from "./setup.js";

// ─────────────────────────────────────────────
// KAN-689 dynamic-import specs
// ─────────────────────────────────────────────

const analyzerSpec =
  "../../../../../packages/api/src/services/feasibility-analyzer.js";
const fixturesSpec =
  "../../../../../packages/api/src/services/__tests__/__fixtures__/feasibility-counsel-fixtures.js";

type AnalyzerModule = {
  analyzeFeasibility: (
    prisma: unknown,
    redis: unknown | null,
    llm: (input: unknown) => Promise<unknown>,
    params: {
      tenantId: string;
      goalShape: GoalShape;
      goalTarget: number;
      goalDescription: string;
      goalWindowDays?: number;
    },
  ) => Promise<FeasibilityCounselResult>;
  persistCampaignFeasibility: (
    prisma: unknown,
    campaignId: string,
    result: FeasibilityCounselResult,
  ) => Promise<void>;
};

type FixturesModule = {
  SUFFICIENT_FEASIBLE_FIXTURE: { text: string; model: string; provider: string };
  PARTIAL_LOWCONF_FIXTURE: { text: string; model: string; provider: string };
  COLD_START_EXPECTED: ColdStartCounsel;
};

async function loadAnalyzer(): Promise<AnalyzerModule> {
  return (await import(analyzerSpec)) as AnalyzerModule;
}

async function loadFixtures(): Promise<FixturesModule> {
  return (await import(fixturesSpec)) as FixturesModule;
}

// ─────────────────────────────────────────────
// Inline helpers — mirrors kan-1171 patterns
// ─────────────────────────────────────────────

const DAY_MS = 86_400_000;

async function setCustomer(prisma: PrismaClient, contactId: string): Promise<void> {
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
      grandTotal: args.grandTotal ?? 5000,
    },
    select: { id: true },
  });
}

/** Seed sufficient data for dataReadiness='sufficient'. */
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
  // Plant ancient order for ≥90-day history
  await createOrderAt(tx, {
    tenantId,
    contactId,
    placedAt: new Date(Date.now() - 200 * DAY_MS),
  });
  for (let i = 0; i < 24; i++) {
    await createOrder(tx, { tenantId, contactId, grandTotal: 5000 });
  }
  return { contactId };
}

/** Seed partial-threshold data (≥10 deals → 'partial'). */
async function seedPartialTenant(
  tx: PrismaClient,
  tenantId: string,
): Promise<{ contactId: string }> {
  const { id: contactId } = await createContact(tx, tenantId);
  await setCustomer(tx, contactId);
  const { id: pipelineId, stageId } = await createPipeline(tx, tenantId);
  for (let i = 0; i < 12; i++) {
    await createWonDeal(tx, { tenantId, contactId, pipelineId, stageId, value: 1000 });
  }
  await createOrderAt(tx, {
    tenantId,
    contactId,
    placedAt: new Date(Date.now() - 60 * DAY_MS),
  });
  return { contactId };
}

// ─────────────────────────────────────────────
// Scenario 1 — Cold-start E2E
// ─────────────────────────────────────────────

describe("KAN-1179 — Scenario 1: Cold-start E2E", () => {
  it("zero-data tenant → cold_start_counsel + persist; NO LLM call", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const { id: campaignId } = await createCommittedCampaign(tx, { tenantId });

      const { analyzeFeasibility, persistCampaignFeasibility } = await loadAnalyzer();
      const llmMock = vi.fn();

      const result = await analyzeFeasibility(
        tx as unknown as PrismaClient,
        null,
        llmMock,
        {
          tenantId,
          goalShape: { type: "revenue" },
          goalTarget: 100000,
          goalDescription: "Test revenue goal",
        },
      );

      expect(result.kind).toBe("cold_start_counsel");
      expect(llmMock).not.toHaveBeenCalled();

      if (result.kind === "cold_start_counsel") {
        expect(result.counsel.missingDataTypes).toEqual(
          expect.arrayContaining([
            "sales_history",
            "customer_base",
            "lead_history",
            "engagement_history",
          ]),
        );
      }

      await persistCampaignFeasibility(tx as unknown as PrismaClient, campaignId, result);
      const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
      expect(campaign?.feasibilityAnalysis).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 2 — Sufficient E2E
// ─────────────────────────────────────────────

describe("KAN-1179 — Scenario 2: Sufficient E2E (with SUFFICIENT_FEASIBLE_FIXTURE)", () => {
  it("sufficient data + fixture LLM → feasibility_counsel + persist", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      await seedSufficientTenant(tx as unknown as PrismaClient, tenantId);
      const { id: campaignId } = await createCommittedCampaign(tx, {
        tenantId,
        goalType: "revenue",
        goalTarget: 100000,
      });

      const { analyzeFeasibility, persistCampaignFeasibility } = await loadAnalyzer();
      const fixtures = await loadFixtures();
      const llmMock = vi.fn(async () => fixtures.SUFFICIENT_FEASIBLE_FIXTURE);

      const result = await analyzeFeasibility(
        tx as unknown as PrismaClient,
        null,
        llmMock,
        {
          tenantId,
          goalShape: { type: "revenue" },
          goalTarget: 100000,
          goalDescription: "Test revenue goal",
        },
      );

      expect(result.kind).toBe("feasibility_counsel");
      expect(llmMock).toHaveBeenCalledOnce();

      if (result.kind === "feasibility_counsel") {
        expect(result.counsel.achievablePaths).toHaveLength(3);
        expect(result.counsel.contextProvenance.modelUsed).toBe("claude-sonnet-4-6");
      }

      await persistCampaignFeasibility(tx as unknown as PrismaClient, campaignId, result);
      const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
      expect(campaign?.feasibilityAnalysis).toBeTruthy();
      expect(campaign?.proposedPlan).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 3 — Partial E2E (low-confidence framing)
// ─────────────────────────────────────────────

describe("KAN-1179 — Scenario 3: Partial E2E (PARTIAL_LOWCONF_FIXTURE)", () => {
  it("partial data → LLM user prompt contains LOW CONFIDENCE FRAMING marker", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      await seedPartialTenant(tx as unknown as PrismaClient, tenantId);
      const { id: campaignId } = await createCommittedCampaign(tx, {
        tenantId,
        goalType: "revenue",
        goalTarget: 100000,
      });

      const { analyzeFeasibility, persistCampaignFeasibility } = await loadAnalyzer();
      const fixtures = await loadFixtures();
      const llmMock = vi.fn(async () => fixtures.PARTIAL_LOWCONF_FIXTURE);

      const result = await analyzeFeasibility(
        tx as unknown as PrismaClient,
        null,
        llmMock,
        {
          tenantId,
          goalShape: { type: "revenue" },
          goalTarget: 100000,
          goalDescription: "Test partial",
        },
      );

      expect(result.kind).toBe("feasibility_counsel");
      // Verify low-confidence framing was injected into the user prompt
      const calls = llmMock.mock.calls as unknown as Array<[{ userPrompt: string }]>;
      expect(calls[0]![0].userPrompt).toContain("LOW CONFIDENCE FRAMING");

      await persistCampaignFeasibility(tx as unknown as PrismaClient, campaignId, result);
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 4 — analyzer_unavailable graceful
// ─────────────────────────────────────────────

describe("KAN-1179 — Scenario 4: analyzer_unavailable graceful", () => {
  it("LLM throws → analyzer_unavailable variant; persist still writes Campaign field", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      await seedSufficientTenant(tx as unknown as PrismaClient, tenantId);
      const { id: campaignId } = await createCommittedCampaign(tx, { tenantId });

      const { analyzeFeasibility, persistCampaignFeasibility } = await loadAnalyzer();
      const llmMock = vi.fn(async () => {
        throw new Error("llm transient");
      });

      const result = await analyzeFeasibility(
        tx as unknown as PrismaClient,
        null,
        llmMock,
        {
          tenantId,
          goalShape: { type: "revenue" },
          goalTarget: 100000,
          goalDescription: "Test transient",
        },
      );

      expect(result.kind).toBe("analyzer_unavailable");

      // Persist still writes the unavailable result so audit chain captures it
      await persistCampaignFeasibility(tx as unknown as PrismaClient, campaignId, result);
      const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
      expect(campaign?.feasibilityAnalysis).toBeTruthy();
      // proposedPlan should be JsonNull (not feasibility_counsel variant)
      expect(campaign?.proposedPlan).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 5 — Idempotent re-run preserves prior in audit + overwrites field
// ─────────────────────────────────────────────

describe("KAN-1179 — Scenario 5: Idempotent re-run", () => {
  it("Campaign with priorCounsel → re-run overwrites field; prior available for audit chain", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      await seedSufficientTenant(tx as unknown as PrismaClient, tenantId);

      const priorCounsel: FeasibilityCounselResult = {
        kind: "cold_start_counsel",
        counsel: {
          missingDataTypes: ["sales_history"],
          acquisitionRecommendations: [],
          message: "PRIOR seeded counsel",
        },
        computedAt: new Date(Date.now() - 7 * DAY_MS).toISOString(),
      };
      const { id: campaignId } = await createCommittedCampaign(tx, {
        tenantId,
        priorCounsel: priorCounsel as unknown,
      });

      // Confirm prior is present BEFORE re-run
      const before = await tx.campaign.findUnique({
        where: { id: campaignId },
        select: { feasibilityAnalysis: true },
      });
      expect(before?.feasibilityAnalysis).toMatchObject({
        kind: "cold_start_counsel",
      });

      const { analyzeFeasibility, persistCampaignFeasibility } = await loadAnalyzer();
      const fixtures = await loadFixtures();
      const llmMock = vi.fn(async () => fixtures.SUFFICIENT_FEASIBLE_FIXTURE);

      const newResult = await analyzeFeasibility(
        tx as unknown as PrismaClient,
        null,
        llmMock,
        {
          tenantId,
          goalShape: { type: "revenue" },
          goalTarget: 100000,
          goalDescription: "Test idempotent",
        },
      );
      expect(newResult.kind).toBe("feasibility_counsel");

      // Persist overwrites
      await persistCampaignFeasibility(
        tx as unknown as PrismaClient,
        campaignId,
        newResult,
      );

      const after = await tx.campaign.findUnique({
        where: { id: campaignId },
        select: { feasibilityAnalysis: true },
      });
      expect(after?.feasibilityAnalysis).toMatchObject({
        kind: "feasibility_counsel",
      });
      // Prior is NOT preserved in Campaign field — that's the tRPC layer's
      // responsibility (audit-log payload). Verified at unit-test level in
      // PR 2b-core; this scenario locks the persist overwrite semantic.
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 6 — Multi-tenant isolation
// ─────────────────────────────────────────────

describe("KAN-1179 — Scenario 6: Multi-tenant isolation", () => {
  it("tenant A run doesn't affect tenant B Campaign state", async () => {
    await withRollback(async (tx) => {
      const { id: tenantA } = await createTenant(tx);
      const { id: tenantB } = await createTenant(tx);
      await seedSufficientTenant(tx as unknown as PrismaClient, tenantA);
      await seedSufficientTenant(tx as unknown as PrismaClient, tenantB);
      const { id: campaignA } = await createCommittedCampaign(tx, {
        tenantId: tenantA,
      });
      const { id: campaignB } = await createCommittedCampaign(tx, {
        tenantId: tenantB,
      });

      const { analyzeFeasibility, persistCampaignFeasibility } = await loadAnalyzer();
      const fixtures = await loadFixtures();
      const llmMock = vi.fn(async () => fixtures.SUFFICIENT_FEASIBLE_FIXTURE);

      // Run analyzer for tenant A only
      const resultA = await analyzeFeasibility(
        tx as unknown as PrismaClient,
        null,
        llmMock,
        {
          tenantId: tenantA,
          goalShape: { type: "revenue" },
          goalTarget: 100000,
          goalDescription: "Test A",
        },
      );
      await persistCampaignFeasibility(
        tx as unknown as PrismaClient,
        campaignA,
        resultA,
      );

      // Tenant A Campaign has counsel; tenant B unchanged
      const campA = await tx.campaign.findUnique({
        where: { id: campaignA },
        select: { feasibilityAnalysis: true },
      });
      const campB = await tx.campaign.findUnique({
        where: { id: campaignB },
        select: { feasibilityAnalysis: true },
      });
      expect(campA?.feasibilityAnalysis).toBeTruthy();
      expect(campB?.feasibilityAnalysis).toBeNull();
    });
  });
});
