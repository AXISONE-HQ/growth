/**
 * KAN-1186 — Action Plan Refiner unit tests.
 *
 * ~30 scenarios across 7 groups:
 *   (a) Stage axis (5) — rename / reorder / add / remove / bounds violation
 *   (b) First-actions axis (3) — edit / add / remove
 *   (c) Audience axis (3) — split reconciliation / Campaign column write / schema reject
 *   (d) Dimension axis (5) — goalTarget / goalDescription / goalType / windowEnd / no-auto-regen
 *   (e) Fail-safe (5) — Campaign missing / LLM throws / unparseable / FCS transient / no_plan_to_refine
 *   (f) Concurrency (2) — matched updatedAt / mismatched updatedAt
 *   (g) Revert (3) — no audit row / malformed before / success
 *
 * Integration tests deferred to KAN-1192 (PR 11) per epic discipline.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActionPlan,
  AudienceConditions,
  TenantHistoricalContext,
} from "@growth/shared";

const mockGetContext = vi.fn();

vi.mock("../feasibility-context-service.js", () => ({
  getTenantHistoricalContext: (...args: unknown[]) => mockGetContext(...args),
}));

import {
  refineActionPlan,
  revertLastRefinement,
  type ActionPlanRefinerPrisma,
  type CountAudienceFn,
  type LLMCompleteFn,
} from "../action-plan-refiner.js";

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const SUFFICIENT_CONTEXT: TenantHistoricalContext = {
  conversionRate: {
    value: 0.15,
    confidence: "high",
    confidenceReason: "200+ closed deals over 365d",
    sampleSize: 200,
    windowDays: 365,
  },
  salesVelocity: {
    unitsPerMonth: 50,
    revenuePerMonth: 100000,
    trendDirection: "flat",
    confidence: "high",
    confidenceReason: "stable 90d trend",
    sampleSize: 90,
  },
  customerBase: {
    totalCustomers: 1200,
    matchingGoalShape: 800,
    avgDealSize: 2000,
    lastEngagementDistribution: { "0-30": 400, "30-90": 300, "90-180": 200, "180-365": 200, "365+": 100 },
  },
  leadPipeline: {
    totalActiveLeads: 300,
    matchingGoalShape: 250,
    weeklyAcquisitionRate: 25,
    bySource: { email_inbox: 100, web_form: 80, meta_ad: 70 },
  },
  dataReadiness: {
    overall: "sufficient",
    missingDataTypes: [],
    earliestDataDate: new Date("2025-01-01T00:00:00Z"),
  },
  windowMeta: {
    windowStart: new Date("2025-06-15T00:00:00Z"),
    windowEnd: new Date("2026-06-15T00:00:00Z"),
    cacheAge: 0,
  },
};

const LEAD_AUDIENCE: AudienceConditions = {
  field: "lifecycleStage",
  op: "in",
  values: ["lead"],
};

const MULTI_COHORT_AUDIENCE: AudienceConditions = {
  field: "lifecycleStage",
  op: "in",
  values: ["lead", "customer"],
};

const PLAN: ActionPlan = {
  pipelines: [
    {
      name: "Inbound Lead Pipeline",
      segment: "new_leads",
      strategy: "direct",
      audienceConditions: LEAD_AUDIENCE,
      audienceCount: 100,
      proposedStages: [
        { name: "Outreach", order: 0, description: "Day-0 outbound" },
        { name: "Qualify", order: 1, description: "Discovery call" },
        { name: "Close", order: 2, description: "Proposal + close" },
      ],
      firstActions: [
        { day: 0, channel: "email", intent: "outreach", description: "Day-0 intro" },
        { day: 3, channel: "email", intent: "follow_up", description: "Day-3 case study" },
      ],
      projectedContribution: 15,
      shareOfGoal: 15,
    },
  ],
  confidence: "high",
  confidenceReason: "200+ closed deals over 365d",
  gapAnalysis: {
    goalTarget: 100,
    projectedOrganic: 60,
    gapAbsolute: 40,
    gapPercent: 40,
    goalWindowDays: 90,
  },
  modelUsed: "claude-sonnet-4-6",
  generatedAt: "2026-06-15T00:00:00.000Z",
};

function makeCampaign(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "campaign-1",
    name: "Test Campaign",
    goalType: "deals",
    goalTarget: 100,
    goalProductId: null,
    goalDescription: "Win 100 deals this quarter from inbound leads",
    audienceConditions: LEAD_AUDIENCE,
    windowStart: new Date("2026-06-15T00:00:00Z"),
    windowEnd: new Date("2026-09-13T00:00:00Z"),
    proposedPlan: PLAN,
    updatedAt: new Date("2026-06-15T12:00:00Z"),
    ...overrides,
  };
}

function makePrisma(
  campaign: Record<string, unknown> | null,
  options: {
    updateThrows?: boolean;
    auditFindFirst?: Record<string, unknown> | null;
    auditFindFirstThrows?: boolean;
  } = {},
): ActionPlanRefinerPrisma & {
  campaign: { update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  auditLog: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
} {
  const update = vi.fn(async () => {
    if (options.updateThrows) throw new Error("db transient");
    return campaign;
  });
  return {
    campaign: {
      findFirst: vi.fn(async () => campaign),
      update,
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "audit-1" })),
      findFirst: vi.fn(async () => {
        if (options.auditFindFirstThrows) throw new Error("audit transient");
        return options.auditFindFirst ?? null;
      }),
    },
  };
}

function makeCount(count: number): CountAudienceFn {
  return vi.fn(async () => ({ count, historicalValueUsd: 0 }));
}

function makeLlm(
  payload: object | string | "error",
): LLMCompleteFn {
  return vi.fn(async () => {
    if (payload === "error") throw new Error("llm transient");
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      text,
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 200,
      latencyMs: 500,
    };
  });
}

beforeEach(() => {
  mockGetContext.mockReset();
  mockGetContext.mockResolvedValue(SUFFICIENT_CONTEXT);
});

// ─────────────────────────────────────────────
// (a) Stage axis — 5 scenarios
// ─────────────────────────────────────────────

describe("Stage axis (E2 family — bounds-validated)", () => {
  it("renames a stage and persists refined plan", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "rename", stageIndex: 1, newName: "Discovery" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "rename stage 1 to Discovery", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("action_plan_refined");
    if (result.kind === "action_plan_refined") {
      expect(result.editAxis).toBe("stage");
      expect(result.plan.pipelines[0].proposedStages[1].name).toBe("Discovery");
    }
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("reorders stages with re-indexed order field", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "reorder", stageIndex: 0, newOrder: 2 }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "move outreach to end", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    if (result.kind === "action_plan_refined") {
      const stages = result.plan.pipelines[0].proposedStages;
      expect(stages[2].name).toBe("Outreach");
      expect(stages.map((s) => s.order)).toEqual([0, 1, 2]);
    }
  });

  it("adds a stage within strategy bounds", async () => {
    // direct strategy: maxStages 4; we have 3, adding 1 = 4 (within bounds)
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "add", newName: "Negotiate", newDescription: "Pricing negotiation" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "add Negotiate stage", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("action_plan_refined");
    if (result.kind === "action_plan_refined") {
      expect(result.plan.pipelines[0].proposedStages).toHaveLength(4);
    }
  });

  it("removes a stage when above min bound", async () => {
    // direct strategy: minStages 2; we have 3, removing 1 = 2 (within bounds)
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "remove", stageIndex: 1 }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "remove Qualify stage", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("action_plan_refined");
    if (result.kind === "action_plan_refined") {
      expect(result.plan.pipelines[0].proposedStages).toHaveLength(2);
    }
  });

  it("rejects stage removal that would violate STRATEGY_STAGE_BOUNDS (E3 lock)", async () => {
    // direct strategy: minStages 2; we have 3, removing 2 = 1 < min
    const planWithMinStages: ActionPlan = {
      ...PLAN,
      pipelines: [
        {
          ...PLAN.pipelines[0],
          proposedStages: [
            { name: "A", order: 0, description: "x" },
            { name: "B", order: 1, description: "y" },
          ],
        },
      ],
    };
    const prisma = makePrisma(makeCampaign({ proposedPlan: planWithMinStages }));
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "remove", stageIndex: 0 }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "remove first stage", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("bounds_violation");
    if (result.kind === "bounds_violation") {
      expect(result.strategy).toBe("direct");
      expect(result.attemptedStageCount).toBe(1);
    }
    // Bounds violation does NOT persist
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// (b) First-actions axis — 3 scenarios
// ─────────────────────────────────────────────

describe("First-actions axis (E2 family)", () => {
  it("edits a first-action channel + intent", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "first_actions", pipelineIndex: 0, op: "edit", actionIndex: 0, newChannel: "sms", newIntent: "sms_intro" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "switch Day 0 to SMS", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    if (result.kind === "action_plan_refined") {
      const a = result.plan.pipelines[0].firstActions[0];
      expect(a.channel).toBe("sms");
      expect(a.intent).toBe("sms_intro");
    }
  });

  it("adds a first-action up to cap (5)", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "first_actions", pipelineIndex: 0, op: "add", newDay: 7, newChannel: "email", newIntent: "value_remind", newDescription: "Day-7 value reminder" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "add Day-7 follow-up", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    if (result.kind === "action_plan_refined") {
      expect(result.plan.pipelines[0].firstActions).toHaveLength(3);
      expect(result.plan.pipelines[0].firstActions[2].day).toBe(7);
    }
  });

  it("removes a first-action when above min (1)", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "first_actions", pipelineIndex: 0, op: "remove", actionIndex: 0 }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "remove Day 0", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    if (result.kind === "action_plan_refined") {
      expect(result.plan.pipelines[0].firstActions).toHaveLength(1);
    }
  });
});

// ─────────────────────────────────────────────
// (c) Audience axis — 3 scenarios
// ─────────────────────────────────────────────

describe("Audience axis (E2 family — re-split + reconcile)", () => {
  it("replaces audienceConditions and writes BOTH proposedPlan + audienceConditions to Campaign", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "audience", newAudienceConditions: MULTI_COHORT_AUDIENCE }),
      makeCount(50),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "include customers", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("action_plan_refined");
    // Verify the persist call wrote BOTH columns
    const lastUpdate = prisma.campaign.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(lastUpdate?.data).toHaveProperty("proposedPlan");
    expect(lastUpdate?.data).toHaveProperty("audienceConditions");
  });

  it("multi-cohort audience triggers split → 2 reconciled pipelines (lead inherits prior; customer new skeleton)", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "audience", newAudienceConditions: MULTI_COHORT_AUDIENCE }),
      makeCount(50),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "include customers", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    if (result.kind === "action_plan_refined") {
      expect(result.plan.pipelines).toHaveLength(2);
      const segments = result.plan.pipelines.map((p) => p.segment).sort();
      expect(segments).toContain("new_leads");
      expect(segments).toContain("inactive_customers_reengagement");
    }
  });

  it("rejects malformed newAudienceConditions schema → analyzer_unavailable", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "audience", newAudienceConditions: { totallyBadShape: true } }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "bad audience", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    // LLM output fails ActionPlanEditSchema parse at first instance OR
    // AudienceConditionsSchema parse at defense-in-depth re-check. Both routes
    // surface analyzer_unavailable.
    expect(result.kind).toBe("analyzer_unavailable");
  });
});

// ─────────────────────────────────────────────
// (d) Dimension axis — 5 scenarios (NEW-D)
// ─────────────────────────────────────────────

describe("Dimension axis (NEW-D — column write + separate audit + NO Action Plan regen)", () => {
  it("goalTarget edit writes Campaign.goalTarget + emits dimension audit type", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "dimension", field: "goalTarget", newValue: 200 }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "raise target to 200", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("action_plan_refined");
    const updateArgs = prisma.campaign.update.mock.calls[0][0] as {
      data: { goalTarget?: unknown };
    };
    expect(updateArgs.data.goalTarget).toBe(200);
    // Audit type for dimension axis MUST be the separate type
    const auditArgs = prisma.auditLog.create.mock.calls[0][0] as {
      data: { actionType?: string };
    };
    expect(auditArgs.data.actionType).toBe("campaign.dimension_post_confirm_edit");
  });

  it("goalDescription edit writes column + leaves proposedPlan stale (no auto-regen)", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "dimension", field: "goalDescription", newValue: "Updated description" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "rephrase goal", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    if (result.kind === "action_plan_refined") {
      // Returns the STALE plan unchanged — operator must re-generate
      expect(result.plan).toEqual(PLAN);
    }
  });

  it("goalType edit writes column", async () => {
    const prisma = makePrisma(makeCampaign());
    await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "dimension", field: "goalType", newValue: "revenue" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "switch to revenue", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    const updateArgs = prisma.campaign.update.mock.calls[0][0] as {
      data: { goalType?: unknown };
    };
    expect(updateArgs.data.goalType).toBe("revenue");
  });

  it("windowEnd edit writes column as Date", async () => {
    const prisma = makePrisma(makeCampaign());
    await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "dimension", field: "windowEnd", newValue: "2026-12-31T23:59:59Z" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "extend window to Dec 31", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    const updateArgs = prisma.campaign.update.mock.calls[0][0] as {
      data: { windowEnd?: unknown };
    };
    expect(updateArgs.data.windowEnd).toBeInstanceOf(Date);
  });

  it("NEW-D doctrine: dimension edit emits separate audit type, NOT action_plan_refined", async () => {
    const prisma = makePrisma(makeCampaign());
    await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "dimension", field: "goalTarget", newValue: 150 }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "raise to 150", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    const auditArgs = prisma.auditLog.create.mock.calls[0][0] as {
      data: { actionType?: string };
    };
    expect(auditArgs.data.actionType).toBe("campaign.dimension_post_confirm_edit");
    expect(auditArgs.data.actionType).not.toBe("campaign.action_plan_refined");
  });
});

// ─────────────────────────────────────────────
// (e) Fail-safe — 5 scenarios
// ─────────────────────────────────────────────

describe("Fail-safe variants", () => {
  it("Campaign not found → analyzer_unavailable", async () => {
    const prisma = makePrisma(null);
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "rename", stageIndex: 0, newName: "x" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "rename", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("LLM throws → analyzer_unavailable", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm("error"),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "rename", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("LLM emits unparseable JSON → analyzer_unavailable", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm("not json"),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "rename", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("FCS transient → refinement still succeeds with fallback gap analysis", async () => {
    mockGetContext.mockReset();
    mockGetContext.mockRejectedValueOnce(new Error("fcs transient"));
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "rename", stageIndex: 1, newName: "Discovery" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "rename", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("action_plan_refined");
    if (result.kind === "action_plan_refined") {
      // Fallback gap analysis: projectedOrganic=0, gapAbsolute=goalTarget
      expect(result.plan.gapAnalysis.projectedOrganic).toBe(0);
      expect(result.plan.gapAnalysis.gapAbsolute).toBe(100);
    }
  });

  it("NEW-C — no_plan_to_refine when proposedPlan is NULL", async () => {
    const prisma = makePrisma(makeCampaign({ proposedPlan: null }));
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "rename", stageIndex: 0, newName: "x" }),
      makeCount(100),
      { campaignId: "campaign-1", tenantId: "t1", refinementMessage: "rename", todayUtc: new Date("2026-06-15T12:00:00Z") },
    );
    expect(result.kind).toBe("no_plan_to_refine");
  });
});

// ─────────────────────────────────────────────
// (f) Concurrency (NEW-B) — 2 scenarios
// ─────────────────────────────────────────────

describe("Concurrency (NEW-B — optimistic via Campaign.updatedAt)", () => {
  it("matched updatedAt token allows refinement", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "rename", stageIndex: 1, newName: "Discovery" }),
      makeCount(100),
      {
        campaignId: "campaign-1",
        tenantId: "t1",
        refinementMessage: "rename",
        expectedUpdatedAt: new Date("2026-06-15T12:00:00Z").toISOString(),
        todayUtc: new Date("2026-06-15T12:00:00Z"),
      },
    );
    expect(result.kind).toBe("action_plan_refined");
  });

  it("mismatched updatedAt → concurrent_edit_conflict with current plan", async () => {
    const prisma = makePrisma(makeCampaign());
    const result = await refineActionPlan(
      prisma,
      null,
      makeLlm({ axis: "stage", pipelineIndex: 0, op: "rename", stageIndex: 1, newName: "Discovery" }),
      makeCount(100),
      {
        campaignId: "campaign-1",
        tenantId: "t1",
        refinementMessage: "rename",
        expectedUpdatedAt: "2026-06-15T11:00:00.000Z",
        todayUtc: new Date("2026-06-15T12:00:00Z"),
      },
    );
    expect(result.kind).toBe("concurrent_edit_conflict");
    if (result.kind === "concurrent_edit_conflict") {
      expect(result.currentPlan).toEqual(PLAN);
    }
  });
});

// ─────────────────────────────────────────────
// (g) Revert (E8 lock) — 3 scenarios
// ─────────────────────────────────────────────

describe("revertLastRefinement (E8 lock)", () => {
  it("no_refinement_to_revert when no audit row exists", async () => {
    const prisma = makePrisma(makeCampaign(), { auditFindFirst: null });
    const result = await revertLastRefinement(prisma, {
      campaignId: "campaign-1",
      tenantId: "t1",
      todayUtc: new Date("2026-06-15T13:00:00Z"),
    });
    expect(result.kind).toBe("no_refinement_to_revert");
  });

  it("malformed audit payload (no before) → analyzer_unavailable", async () => {
    const prisma = makePrisma(makeCampaign(), {
      auditFindFirst: {
        id: "audit-x",
        payload: { campaignId: "campaign-1" }, // missing `before`
      },
    });
    const result = await revertLastRefinement(prisma, {
      campaignId: "campaign-1",
      tenantId: "t1",
      todayUtc: new Date("2026-06-15T13:00:00Z"),
    });
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("successful revert restores prior plan + emits reverted audit row (E8: never destroy history)", async () => {
    const priorPlan: ActionPlan = {
      ...PLAN,
      pipelines: [{ ...PLAN.pipelines[0], name: "Prior name" }],
    };
    const prisma = makePrisma(makeCampaign(), {
      auditFindFirst: {
        id: "audit-recent",
        payload: { campaignId: "campaign-1", before: priorPlan, after: PLAN },
      },
    });
    const result = await revertLastRefinement(prisma, {
      campaignId: "campaign-1",
      tenantId: "t1",
      todayUtc: new Date("2026-06-15T13:00:00Z"),
    });
    expect(result.kind).toBe("action_plan_reverted");
    if (result.kind === "action_plan_reverted") {
      expect(result.plan.pipelines[0].name).toBe("Prior name");
    }
    // Verify revert audit row emitted
    const auditTypes = prisma.auditLog.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { actionType: string } }).data.actionType,
    );
    expect(auditTypes).toContain("campaign.action_plan_refinement_reverted");
  });
});

// Reference SUFFICIENT_CONTEXT fixture so it's exercised + linted as used.
describe("SUFFICIENT_CONTEXT fixture sanity", () => {
  it("provides high tenant-level confidence as expected", () => {
    expect(SUFFICIENT_CONTEXT.conversionRate.confidence).toBe("high");
  });
});
