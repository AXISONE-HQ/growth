/**
 * KAN-1166 PR 2b — feasibility-analyzer unit tests.
 *
 * Scenarios:
 *   - Cold-start path (dataReadiness=insufficient) → cold_start_counsel,
 *     deterministic per Q-ADD-E templates, NO LLM call.
 *   - Sufficient path → feasibility_counsel with parsed LLM output +
 *     math-derived achievability override when LLM disagrees.
 *   - Partial path → low-confidence framing in user prompt.
 *   - LLM transient → analyzer_unavailable graceful degradation.
 *   - LLM parse failure → analyzer_unavailable on malformed JSON.
 *   - persistCampaignFeasibility fail-safe (DB transient swallowed).
 *
 * Mocked Prisma + mocked LLM + mocked FeasibilityContextService (via
 * vi.mock at module level since getTenantHistoricalContext is statically
 * imported).
 *
 * Pre-flight hardened: `npx vitest run` PASS-verified locally before push
 * per Memo 35 refinement (3× confirmed lesson from KAN-1171-A).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { TenantHistoricalContext, GoalShape } from "@growth/shared";
import type { LLMCompleteResult } from "../llm-client.js";

// ─────────────────────────────────────────────
// Module-level mock of getTenantHistoricalContext
// ─────────────────────────────────────────────

const mockGetContext = vi.fn();
const mockHashGoalShape = vi.fn((g: GoalShape) => `hash:${g.type}`);

vi.mock("../feasibility-context-service.js", () => ({
  getTenantHistoricalContext: (...args: unknown[]) => mockGetContext(...args),
  hashGoalShape: (g: GoalShape) => mockHashGoalShape(g),
}));

// Import AFTER vi.mock so the mock is wired
import {
  analyzeFeasibility,
  persistCampaignFeasibility,
  type LLMCompleteFn,
} from "../feasibility-analyzer.js";

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const TENANT_A = "11111111-1111-1111-1111-111111111111";

const REVENUE_GOAL: GoalShape = { type: "revenue" };
const DEALS_GOAL: GoalShape = { type: "deals" };
const CUSTOM_GOAL: GoalShape = { type: "custom", description: "expand into EU" };

function makeContext(
  overrides: Partial<TenantHistoricalContext> = {},
): TenantHistoricalContext {
  return {
    conversionRate: {
      value: 0.08,
      sampleSize: 50,
      confidence: "high",
      confidenceReason: "Based on 50 closed-won deals.",
    },
    salesVelocity: {
      unitsPerMonth: 5,
      revenuePerMonth: 5000,
      trendDirection: "up",
      confidence: "high",
    },
    customerBase: {
      totalCustomers: 200,
      matchingGoalShape: 200,
      avgDealSize: 1000,
      lastEngagementDistribution: {
        lt30days: 50,
        lt90days: 40,
        lt180days: 30,
        lt365days: 20,
        stale: 60,
      },
    },
    leadPipeline: {
      totalActiveLeads: 100,
      matchingGoalShape: 100,
      bySource: { manual: 100 },
      weeklyAcquisitionRate: 5,
    },
    dataReadiness: {
      overall: "sufficient",
      missingDataTypes: [],
      earliestDataDate: new Date("2025-06-01"),
    },
    windowMeta: {
      windowStart: new Date("2025-06-12"),
      windowEnd: new Date("2026-06-12"),
      cacheAge: 0,
    },
    ...overrides,
  };
}

function makePrisma(opts: { updateThrows?: boolean } = {}): PrismaClient {
  const campaignUpdate = vi.fn(async () => {
    if (opts.updateThrows) throw new Error("db transient");
    return { id: "campaign-1" };
  });
  return {
    campaign: { update: campaignUpdate },
    _spies: { campaignUpdate },
  } as unknown as PrismaClient;
}

function makeLLM(text: string, opts: { throws?: boolean } = {}): LLMCompleteFn {
  return vi.fn(async () => {
    if (opts.throws) throw new Error("llm transient");
    return {
      text,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 200,
      latencyMs: 500,
      modelPricingVersion: "v1",
    } as LLMCompleteResult;
  });
}

const VALID_LLM_RESPONSE = JSON.stringify({
  achievability: "stretch",
  honestAssessment:
    "Based on your 8% conversion rate and 5 closed deals/month historical baseline, " +
    "you'll close ~60 organically by Q1. Your goal of 100 is a stretch — 40% gap on current trajectory.",
  achievablePaths: [
    {
      label: "Increase Lead Volume",
      description: "Bring more qualified leads into the top of funnel.",
      requiredAction: "Increase weekly acquisition from 5 to 12 leads.",
      estimatedImpact: "Closes ~60% of the gap if conversion holds.",
    },
    {
      label: "Improve Conversion",
      description: "Convert more of your current leads.",
      requiredAction: "Reduce lead-to-close cycle by 15 days via faster follow-ups.",
      estimatedImpact: "Closes ~25% of the gap.",
    },
    {
      label: "Extend Window",
      description: "Give the math more time.",
      requiredAction: "Push goal window from 90 to 120 days.",
      estimatedImpact: "Closes the remaining gap on current trajectory.",
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────
// Cold-start path
// ─────────────────────────────────────────────

describe("analyzeFeasibility — cold-start path", () => {
  it("dataReadiness=insufficient with all 4 missing → cold_start_counsel; NO LLM call", async () => {
    mockGetContext.mockResolvedValueOnce(
      makeContext({
        dataReadiness: {
          overall: "insufficient",
          missingDataTypes: [
            "sales_history",
            "customer_base",
            "lead_history",
            "engagement_history",
          ],
          earliestDataDate: null,
        },
      }),
    );
    const llm = makeLLM("(unused)");
    const result = await analyzeFeasibility(makePrisma(), null, llm, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "Hit 100k revenue",
    });

    expect(result.kind).toBe("cold_start_counsel");
    expect(llm).not.toHaveBeenCalled();
    if (result.kind === "cold_start_counsel") {
      expect(result.counsel.missingDataTypes).toHaveLength(4);
      expect(result.counsel.acquisitionRecommendations).toHaveLength(4);
      expect(result.counsel.message).toContain("data");
    }
  });

  it("insufficient with sales_history only missing → 1 acquisition recommendation", async () => {
    mockGetContext.mockResolvedValueOnce(
      makeContext({
        dataReadiness: {
          overall: "insufficient",
          missingDataTypes: ["sales_history"],
          earliestDataDate: new Date("2026-04-01"),
        },
      }),
    );
    const llm = makeLLM("(unused)");
    const result = await analyzeFeasibility(makePrisma(), null, llm, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 50000,
      goalDescription: "ramp revenue",
    });
    expect(result.kind).toBe("cold_start_counsel");
    expect(llm).not.toHaveBeenCalled();
    if (result.kind === "cold_start_counsel") {
      expect(result.counsel.acquisitionRecommendations).toHaveLength(1);
      expect(result.counsel.acquisitionRecommendations[0].dataType).toBe("sales_history");
      expect(result.counsel.acquisitionRecommendations[0].operatorActions.length).toBeGreaterThan(0);
    }
  });

  it("zero missingDataTypes (empty insufficient) → generic message; no recs", async () => {
    mockGetContext.mockResolvedValueOnce(
      makeContext({
        dataReadiness: {
          overall: "insufficient",
          missingDataTypes: [],
          earliestDataDate: new Date(),
        },
      }),
    );
    const result = await analyzeFeasibility(makePrisma(), null, makeLLM("(unused)"), {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 50000,
      goalDescription: "test",
    });
    expect(result.kind).toBe("cold_start_counsel");
    if (result.kind === "cold_start_counsel") {
      expect(result.counsel.acquisitionRecommendations).toHaveLength(0);
      expect(result.counsel.message).toMatch(/enough|recent activity/);
    }
  });
});

// ─────────────────────────────────────────────
// Sufficient path — happy LLM
// ─────────────────────────────────────────────

describe("analyzeFeasibility — sufficient + LLM happy path", () => {
  it("returns feasibility_counsel with parsed LLM fields + projection math + provenance", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const llm = makeLLM(VALID_LLM_RESPONSE);
    const result = await analyzeFeasibility(makePrisma(), null, llm, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "Hit 100k revenue this year",
      goalWindowDays: 365,
    });

    expect(result.kind).toBe("feasibility_counsel");
    expect(llm).toHaveBeenCalledOnce();
    if (result.kind === "feasibility_counsel") {
      expect(result.counsel.honestAssessment).toContain("8%");
      expect(result.counsel.achievablePaths).toHaveLength(3);
      // revenuePerMonth=5000 × (365/30)≈12.17 months → ~60833 organic
      expect(result.counsel.projectedOrganic.count).toBe(60833);
      expect(result.counsel.projectedOrganic.unit).toBe("USD");
      // gap = 100000 - 60833 = 39167; ≈39.17% (still > 20% threshold = stretch)
      expect(result.counsel.goalGap.absolute).toBe(39167);
      expect(result.counsel.goalGap.percent).toBeCloseTo(39, 0);
      // confidence is dominant (both sufficient/high here → 'high')
      expect(result.counsel.confidence).toBe("high");
      // achievability = math classification on 40% gap = 'stretch'
      expect(result.counsel.achievability).toBe("stretch");
      // provenance populated
      expect(result.counsel.contextProvenance.hashUsed).toBe("hash:revenue");
      expect(result.counsel.contextProvenance.modelUsed).toBe("claude-sonnet-4-6");
    }
  });

  it("LLM tier='reasoning' + jsonMode + callerTag passed in input", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const llm = makeLLM(VALID_LLM_RESPONSE);
    await analyzeFeasibility(makePrisma(), null, llm, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "test",
    });
    const callArg = (llm as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      tier: string;
      jsonMode: boolean;
      callerTag: string;
      systemPrompt: string;
      tenantId: string;
    };
    expect(callArg.tier).toBe("reasoning");
    expect(callArg.jsonMode).toBe(true);
    expect(callArg.callerTag).toBe("feasibility-analyzer:analyze");
    expect(callArg.systemPrompt).toContain("growth feasibility analyst");
    expect(callArg.tenantId).toBe(TENANT_A);
  });

  it("achievability= 'feasible' when gap <= 20% (math override)", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const responseWithUnrealisticClaim = JSON.stringify({
      achievability: "unrealistic", // LLM disagrees — math wins
      honestAssessment: "test",
      achievablePaths: [
        { label: "A", description: "a", requiredAction: "a", estimatedImpact: "a" },
        { label: "B", description: "b", requiredAction: "b", estimatedImpact: "b" },
        { label: "C", description: "c", requiredAction: "c", estimatedImpact: "c" },
      ],
    });
    const result = await analyzeFeasibility(
      makePrisma(),
      null,
      makeLLM(responseWithUnrealisticClaim),
      {
        tenantId: TENANT_A,
        goalShape: REVENUE_GOAL,
        goalTarget: 60000, // exact match to revenuePerMonth × 12; 0% gap
        goalDescription: "test",
      },
    );
    expect(result.kind).toBe("feasibility_counsel");
    if (result.kind === "feasibility_counsel") {
      expect(result.counsel.achievability).toBe("feasible");
      expect(result.counsel.goalGap.percent).toBeCloseTo(0, 1);
    }
  });
});

// ─────────────────────────────────────────────
// Partial path — low-confidence framing
// ─────────────────────────────────────────────

describe("analyzeFeasibility — partial path", () => {
  it("dataReadiness=partial → LOW CONFIDENCE framing in user prompt", async () => {
    mockGetContext.mockResolvedValueOnce(
      makeContext({
        dataReadiness: {
          overall: "partial",
          missingDataTypes: ["engagement_history"],
          earliestDataDate: new Date("2026-04-01"),
        },
        conversionRate: {
          value: 0.08,
          sampleSize: 12,
          confidence: "medium",
          confidenceReason: "Based on 12 closed-won deals (medium confidence).",
        },
      }),
    );
    const llm = makeLLM(VALID_LLM_RESPONSE);
    await analyzeFeasibility(makePrisma(), null, llm, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "test",
    });
    const userPrompt = ((llm as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      userPrompt: string;
    }).userPrompt;
    expect(userPrompt).toContain("LOW CONFIDENCE FRAMING");
  });
});

// ─────────────────────────────────────────────
// Graceful degradation paths
// ─────────────────────────────────────────────

describe("analyzeFeasibility — graceful degradation", () => {
  it("LLM throws → analyzer_unavailable; NEVER throws to caller", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const llm = makeLLM("", { throws: true });
    const result = await analyzeFeasibility(makePrisma(), null, llm, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "test",
    });
    expect(result.kind).toBe("analyzer_unavailable");
    if (result.kind === "analyzer_unavailable") {
      expect(result.message).toMatch(/try again/i);
    }
  });

  it("LLM returns malformed JSON → analyzer_unavailable", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const llm = makeLLM("I think the answer is...");
    const result = await analyzeFeasibility(makePrisma(), null, llm, {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "test",
    });
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("LLM returns JSON missing required keys → analyzer_unavailable", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const incomplete = JSON.stringify({ achievability: "feasible" });
    const result = await analyzeFeasibility(makePrisma(), null, makeLLM(incomplete), {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "test",
    });
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("LLM returns invalid achievability value → analyzer_unavailable", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const invalid = JSON.stringify({
      achievability: "maybe",
      honestAssessment: "test",
      achievablePaths: [],
    });
    const result = await analyzeFeasibility(makePrisma(), null, makeLLM(invalid), {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "test",
    });
    expect(result.kind).toBe("analyzer_unavailable");
  });

  it("LLM markdown-fenced JSON → parser strips + still succeeds", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const fenced = "```json\n" + VALID_LLM_RESPONSE + "\n```";
    const result = await analyzeFeasibility(makePrisma(), null, makeLLM(fenced), {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "test",
    });
    expect(result.kind).toBe("feasibility_counsel");
  });

  it("getTenantHistoricalContext throws → orchestrator-level fail-safe", async () => {
    mockGetContext.mockRejectedValueOnce(new Error("db down"));
    const result = await analyzeFeasibility(makePrisma(), null, makeLLM("(unused)"), {
      tenantId: TENANT_A,
      goalShape: REVENUE_GOAL,
      goalTarget: 100000,
      goalDescription: "test",
    });
    expect(result.kind).toBe("analyzer_unavailable");
  });
});

// ─────────────────────────────────────────────
// Projection math
// ─────────────────────────────────────────────

describe("analyzeFeasibility — projection math per goalShape variant", () => {
  it("deals goal: leads × conversion × months", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext()); // leadPipeline.weekly=5 → ~22/month; conv=0.08
    const result = await analyzeFeasibility(
      makePrisma(),
      null,
      makeLLM(VALID_LLM_RESPONSE),
      {
        tenantId: TENANT_A,
        goalShape: DEALS_GOAL,
        goalTarget: 20,
        goalDescription: "deals goal",
        goalWindowDays: 90,
      },
    );
    expect(result.kind).toBe("feasibility_counsel");
    if (result.kind === "feasibility_counsel") {
      // weekly=5 → 5×52/12 = ~21.7 leads/mo × conv=0.08 × 3 months = ~5.2 deals
      // → round to 5
      expect(result.counsel.projectedOrganic.count).toBe(5);
      expect(result.counsel.projectedOrganic.unit).toBe("deals");
    }
  });

  it("custom goal: rough proxy via leads × 0.1 × months; unit='outcomes'", async () => {
    mockGetContext.mockResolvedValueOnce(makeContext());
    const result = await analyzeFeasibility(
      makePrisma(),
      null,
      makeLLM(VALID_LLM_RESPONSE),
      {
        tenantId: TENANT_A,
        goalShape: CUSTOM_GOAL,
        goalTarget: 10,
        goalDescription: "expand into EU",
      },
    );
    if (result.kind === "feasibility_counsel") {
      expect(result.counsel.projectedOrganic.unit).toBe("outcomes");
    }
  });
});

// ─────────────────────────────────────────────
// persistCampaignFeasibility — fail-safe
// ─────────────────────────────────────────────

describe("persistCampaignFeasibility — fail-safe", () => {
  it("happy path — writes feasibilityAnalysis + proposedPlan", async () => {
    const prisma = makePrisma();
    const result: import("@growth/shared").FeasibilityCounselResult = {
      kind: "feasibility_counsel",
      counsel: {
        achievability: "stretch",
        confidence: "high",
        projectedOrganic: { count: 60000, unit: "USD" },
        goalGap: { absolute: 40000, percent: 40 },
        honestAssessment: "test",
        achievablePaths: [
          { label: "A", description: "a", requiredAction: "a", estimatedImpact: "a" },
        ],
        contextProvenance: { hashUsed: "h", modelUsed: "m" },
      },
      computedAt: new Date().toISOString(),
    };
    await persistCampaignFeasibility(prisma, "campaign-1", result);
    const spies = (prisma as unknown as { _spies: { campaignUpdate: ReturnType<typeof vi.fn> } })
      ._spies;
    expect(spies.campaignUpdate).toHaveBeenCalledOnce();
  });

  it("DB transient → swallowed + logged; never throws", async () => {
    const prisma = makePrisma({ updateThrows: true });
    const result: import("@growth/shared").FeasibilityCounselResult = {
      kind: "analyzer_unavailable",
      message: "test",
      computedAt: new Date().toISOString(),
    };
    await expect(
      persistCampaignFeasibility(prisma, "campaign-1", result),
    ).resolves.not.toThrow();
  });
});
