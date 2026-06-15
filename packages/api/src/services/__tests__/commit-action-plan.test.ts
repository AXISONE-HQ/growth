/**
 * KAN-1190 — Commit Action Plan unit tests.
 *
 * ~16 scenarios across 5 groups:
 *   (a) Happy path (4) — single-pipeline / multi-pipeline / status flip / audit shape
 *   (b) Idempotency + concurrency (3) — J8 already_committed / J11 match / J11 mismatch
 *   (c) Defense-in-depth (4) — J3 bounds / J3 schema parse / missing campaign / missing plan
 *   (d) Pipeline shape (3) — V3 objectiveId NULL / J5 per-pipeline strategy / segment captured
 *   (e) Fail-safe (2) — tx failure analyzer_unavailable / audit emit failure non-blocking
 *
 * Integration tests deferred to KAN-1192 (PR 11) per epic discipline.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionPlan, AudienceConditions } from "@growth/shared";

import {
  commitActionPlan,
  type CommitActionPlanPrisma,
  type CommitActionPlanTx,
} from "../commit-action-plan.js";

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const LEAD_AUDIENCE: AudienceConditions = {
  field: "lifecycleStage",
  op: "in",
  values: ["lead"],
};

const CUSTOMER_AUDIENCE: AudienceConditions = {
  field: "lifecycleStage",
  op: "in",
  values: ["customer"],
};

const SINGLE_PIPELINE_PLAN: ActionPlan = {
  pipelines: [
    {
      name: "Inbound Lead Pipeline",
      segment: "new_leads",
      strategy: "direct",
      audienceConditions: LEAD_AUDIENCE,
      audienceCount: 100,
      proposedStages: [
        { name: "Outreach", order: 0, description: "Day-0 outbound" },
        { name: "Qualify", order: 1, description: "Discovery" },
        { name: "Close", order: 2, description: "Proposal + close" },
      ],
      firstActions: [
        { day: 0, channel: "email", intent: "outreach", description: "Day-0 intro" },
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

const MULTI_PIPELINE_PLAN: ActionPlan = {
  ...SINGLE_PIPELINE_PLAN,
  pipelines: [
    SINGLE_PIPELINE_PLAN.pipelines[0],
    {
      name: "Inactive Customer Reengagement",
      segment: "inactive_customers_reengagement",
      strategy: "trust_build",
      audienceConditions: CUSTOMER_AUDIENCE,
      audienceCount: 50,
      proposedStages: [
        { name: "Introduce", order: 0, description: "Soft re-open" },
        { name: "Educate", order: 1, description: "Value reminder" },
        { name: "Recommend", order: 2, description: "Next-step CTA" },
      ],
      firstActions: [
        { day: 0, channel: "email", intent: "re_engage", description: "Soft re-open" },
      ],
      projectedContribution: 10,
      shareOfGoal: 10,
    },
  ],
};

function makeCampaign(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "campaign-1",
    name: "Test Campaign",
    status: "draft",
    proposedPlan: SINGLE_PIPELINE_PLAN,
    committedPlan: null,
    updatedAt: new Date("2026-06-15T12:00:00Z"),
    ...overrides,
  };
}

interface MockTracker {
  pipelineCreateCalls: Array<{ data: Record<string, unknown> }>;
  campaignUpdateCalls: Array<{ data: Record<string, unknown> }>;
}

function makePrisma(
  campaign: Record<string, unknown> | null,
  options: {
    pipelineCreateThrows?: boolean;
    pipelineCreateThrowsAfter?: number;
    auditCreateThrows?: boolean;
  } = {},
): {
  prisma: CommitActionPlanPrisma;
  tracker: MockTracker;
  auditCreate: ReturnType<typeof vi.fn>;
} {
  const tracker: MockTracker = {
    pipelineCreateCalls: [],
    campaignUpdateCalls: [],
  };
  let pipelineCallCount = 0;
  const auditCreate = vi.fn(async (args: unknown) => {
    if (options.auditCreateThrows) throw new Error("audit transient");
    return { id: `audit-${++pipelineCallCount}`, ...((args as { data?: unknown }).data ?? {}) };
  });

  const tx: CommitActionPlanTx = {
    campaign: {
      update: vi.fn(async (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data;
        tracker.campaignUpdateCalls.push({ data });
        return { id: campaign?.id, ...data };
      }),
    },
    pipeline: {
      create: vi.fn(async (args: unknown) => {
        pipelineCallCount += 1;
        if (
          options.pipelineCreateThrows ||
          (options.pipelineCreateThrowsAfter != null &&
            pipelineCallCount > options.pipelineCreateThrowsAfter)
        ) {
          throw new Error("pipeline tx transient");
        }
        const data = (args as { data: Record<string, unknown> }).data;
        tracker.pipelineCreateCalls.push({ data });
        const stagesData =
          (data.stages as { create?: Array<{ name: string; order: number }> })?.create ?? [];
        return {
          id: `pipeline-${pipelineCallCount}`,
          stages: stagesData.map((s, i) => ({
            id: `stage-${pipelineCallCount}-${i}`,
            order: s.order,
          })),
        };
      }),
    },
  };

  const prisma: CommitActionPlanPrisma = {
    $transaction: async <T>(
      fn: (tx: CommitActionPlanTx) => Promise<T>,
    ): Promise<T> => fn(tx),
    campaign: {
      findFirst: vi.fn(async () => campaign),
    },
    auditLog: {
      create: auditCreate,
    },
  };

  return { prisma, tracker, auditCreate };
}

const TODAY = new Date("2026-06-15T13:00:00.000Z");

// ─────────────────────────────────────────────
// (a) Happy path — 4 scenarios
// ─────────────────────────────────────────────

describe("Happy path commit", () => {
  it("commits a single-pipeline plan and returns persisted IDs", async () => {
    const { prisma, tracker } = makePrisma(makeCampaign());
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(result.kind).toBe("committed");
    if (result.kind === "committed") {
      expect(result.pipelineIds).toEqual(["pipeline-1"]);
      expect(result.stageIds).toEqual([["stage-1-0", "stage-1-1", "stage-1-2"]]);
      expect(result.committedPlan.pipelineIds).toEqual(["pipeline-1"]);
      expect(result.committedPlan.committedAt).toBe(TODAY.toISOString());
    }
    expect(tracker.pipelineCreateCalls).toHaveLength(1);
  });

  it("commits a multi-pipeline plan with N tx.pipeline.create calls", async () => {
    const { prisma, tracker } = makePrisma(
      makeCampaign({ proposedPlan: MULTI_PIPELINE_PLAN }),
    );
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(result.kind).toBe("committed");
    if (result.kind === "committed") {
      expect(result.pipelineIds).toEqual(["pipeline-1", "pipeline-2"]);
      expect(result.stageIds).toHaveLength(2);
      expect(result.stageIds[0]).toHaveLength(3);
      expect(result.stageIds[1]).toHaveLength(3);
    }
    expect(tracker.pipelineCreateCalls).toHaveLength(2);
  });

  it("flips status to 'committed' NOT 'active' (J4 INERT lock)", async () => {
    const { prisma, tracker } = makePrisma(makeCampaign());
    await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(tracker.campaignUpdateCalls).toHaveLength(1);
    expect(tracker.campaignUpdateCalls[0].data.status).toBe("committed");
    expect(tracker.campaignUpdateCalls[0].data.status).not.toBe("active");
    expect(tracker.campaignUpdateCalls[0].data.committedPlan).toBeDefined();
  });

  it("emits 'campaign.action_plan_committed' audit row (J7 dual-audit-type)", async () => {
    const { prisma, auditCreate } = makePrisma(makeCampaign());
    await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      userId: "user-1",
      todayUtc: TODAY,
    });

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = (auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(auditArg.actionType).toBe("campaign.action_plan_committed");
    expect(auditArg.actionType).not.toBe("campaign.commit");
    expect(auditArg.actor).toBe("user-1");
    const payload = auditArg.payload as Record<string, unknown>;
    expect(payload.pipelineCount).toBe(1);
    expect(payload.pipelineIds).toEqual(["pipeline-1"]);
  });
});

// ─────────────────────────────────────────────
// (b) Idempotency + concurrency — 3 scenarios
// ─────────────────────────────────────────────

describe("Idempotency + concurrency", () => {
  it("returns already_committed (J8) without writes when status='committed'", async () => {
    const existingSnapshot = {
      campaignName: "Test Campaign",
      committedAt: "2026-06-14T12:00:00.000Z",
      plan: SINGLE_PIPELINE_PLAN,
      pipelineIds: ["pipeline-existing-1"],
    };
    const { prisma, tracker } = makePrisma(
      makeCampaign({
        status: "committed",
        committedPlan: existingSnapshot,
      }),
    );
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(result.kind).toBe("already_committed");
    if (result.kind === "already_committed") {
      expect(result.pipelineIds).toEqual(["pipeline-existing-1"]);
      expect(result.committedPlan.committedAt).toBe("2026-06-14T12:00:00.000Z");
    }
    // J8 — NO writes on re-commit
    expect(tracker.pipelineCreateCalls).toHaveLength(0);
    expect(tracker.campaignUpdateCalls).toHaveLength(0);
  });

  it("accepts commit when expectedUpdatedAt matches Campaign.updatedAt (J11)", async () => {
    const { prisma } = makePrisma(makeCampaign());
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      expectedUpdatedAt: new Date("2026-06-15T12:00:00Z").toISOString(),
      todayUtc: TODAY,
    });

    expect(result.kind).toBe("committed");
  });

  it("rejects with concurrent_edit_conflict on updatedAt mismatch (J11)", async () => {
    const { prisma, tracker } = makePrisma(makeCampaign());
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      expectedUpdatedAt: "2026-06-14T00:00:00.000Z", // stale token
      todayUtc: TODAY,
    });

    expect(result.kind).toBe("concurrent_edit_conflict");
    if (result.kind === "concurrent_edit_conflict") {
      expect(result.currentPlan).toEqual(SINGLE_PIPELINE_PLAN);
    }
    // J11 — NO writes on conflict
    expect(tracker.pipelineCreateCalls).toHaveLength(0);
    expect(tracker.campaignUpdateCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// (c) Defense-in-depth — 4 scenarios
// ─────────────────────────────────────────────

describe("Defense-in-depth (J3 + missing inputs)", () => {
  it("rejects bounds_violation (J3) — stages outside STRATEGY_STAGE_BOUNDS", async () => {
    // 'direct' strategy: 2-4 stages allowed. Build a 5-stage plan → bounds violation.
    const overBoundsPlan: ActionPlan = {
      ...SINGLE_PIPELINE_PLAN,
      pipelines: [
        {
          ...SINGLE_PIPELINE_PLAN.pipelines[0],
          proposedStages: [
            { name: "A", order: 0, description: "x" },
            { name: "B", order: 1, description: "x" },
            { name: "C", order: 2, description: "x" },
            { name: "D", order: 3, description: "x" },
            { name: "E", order: 4, description: "x" },
          ],
        },
      ],
    };
    const { prisma, tracker } = makePrisma(
      makeCampaign({ proposedPlan: overBoundsPlan }),
    );
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(result.kind).toBe("bounds_violation");
    if (result.kind === "bounds_violation") {
      expect(result.strategy).toBe("direct");
      expect(result.attemptedStageCount).toBe(5);
    }
    expect(tracker.pipelineCreateCalls).toHaveLength(0);
  });

  it("returns analyzer_unavailable when proposedPlan fails ActionPlanSchema.parse", async () => {
    const { prisma } = makePrisma(
      makeCampaign({ proposedPlan: { malformed: true } }),
    );
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("returns analyzer_unavailable when Campaign row missing", async () => {
    const { prisma } = makePrisma(null);
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("returns analyzer_unavailable when Campaign.proposedPlan is NULL", async () => {
    const { prisma } = makePrisma(makeCampaign({ proposedPlan: null }));
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });
    expect(result.kind).toBe("analyzer_unavailable");
  });
});

// ─────────────────────────────────────────────
// (d) Pipeline shape — 3 scenarios
// ─────────────────────────────────────────────

describe("Pipeline shape (V3 + J5)", () => {
  it("writes Pipeline.objectiveId = NULL (V3 lock)", async () => {
    const { prisma, tracker } = makePrisma(makeCampaign());
    await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(tracker.pipelineCreateCalls[0].data.objectiveId).toBeNull();
  });

  it("propagates per-Pipeline strategy from ActionPlanPipeline.strategy (J5)", async () => {
    const { prisma, tracker } = makePrisma(
      makeCampaign({ proposedPlan: MULTI_PIPELINE_PLAN }),
    );
    await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(tracker.pipelineCreateCalls[0].data.strategy).toBe("direct");
    expect(tracker.pipelineCreateCalls[1].data.strategy).toBe("trust_build");
    // Pipeline.objectiveType strategy-defaulted per V3 lock
    expect(tracker.pipelineCreateCalls[0].data.objectiveType).toBe("book_appointment");
    expect(tracker.pipelineCreateCalls[1].data.objectiveType).toBe("warm_up_lead");
  });

  it("captures Pipeline.segment from ActionPlanPipeline.segment", async () => {
    const { prisma, tracker } = makePrisma(
      makeCampaign({ proposedPlan: MULTI_PIPELINE_PLAN }),
    );
    await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(tracker.pipelineCreateCalls[0].data.segment).toBe("new_leads");
    expect(tracker.pipelineCreateCalls[1].data.segment).toBe("inactive_customers_reengagement");
  });
});

// ─────────────────────────────────────────────
// (e) Fail-safe — 2 scenarios
// ─────────────────────────────────────────────

describe("Fail-safe", () => {
  it("returns analyzer_unavailable when tx pipeline.create throws", async () => {
    const { prisma } = makePrisma(makeCampaign(), {
      pipelineCreateThrows: true,
    });
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("commits successfully even when audit-create throws (best-effort post-tx)", async () => {
    const { prisma, auditCreate } = makePrisma(makeCampaign(), {
      auditCreateThrows: true,
    });
    const result = await commitActionPlan(prisma, {
      campaignId: "campaign-1",
      tenantId: "tenant-1",
      todayUtc: TODAY,
    });

    expect(result.kind).toBe("committed");
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });
});
