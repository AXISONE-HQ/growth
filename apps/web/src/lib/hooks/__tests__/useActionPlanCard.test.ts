/**
 * KAN-1191 — useActionPlanCard hook RTL coverage.
 *
 * Hook-layer test family (L4 — ui_hook_layer_test_family memo, KAN-1205):
 *   - Uses `renderHook` from `@testing-library/react` (NOT deprecated
 *     `@testing-library/react-hooks`)
 *   - Wraps with QueryClientProvider per canonical pattern
 *   - Asserts hook STATE transitions, not DOM
 *
 * Memos cited:
 *   - ui_hook_layer_test_family (L4 — KAN-1205 substrate)
 *   - discriminated_union_rejected_variant_doctrine (every variant covered)
 *   - j11_j8_redundancy_doctrine (KAN-1205: NO expectedUpdatedAt from UI)
 *
 * Scope:
 *   (a) refine happy → setPlan with returned plan; refineResult populated
 *   (b) refine variant bounds_violation → refineResult only; plan unchanged
 *   (c) refine variant concurrent_edit_conflict → refineResult only; plan unchanged
 *   (d) revert happy → setPlan to prior plan
 *   (e) revert variant no_refinement_to_revert → revertResult only
 *   (f) commit happy → commitResult kind 'committed' with pipelineIds
 *   (g) commit variant already_committed → same shape with same pipelineIds (J8)
 *   (h) commit variant bounds_violation → commitResult only
 *   (i) KAN-1205 contract: refine + commit MUST NOT pass expectedUpdatedAt
 *   (j) applyExternalPlan resets refineResult + commitResult
 *   (k) clearCommitResult dismisses commit banner
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActionPlan } from "@/lib/api";

const refineMock = vi.fn();
const revertMock = vi.fn();
const commitMock = vi.fn();

vi.mock("@/lib/api", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    campaignsApi: {
      ...(actual as { campaignsApi?: Record<string, unknown> }).campaignsApi,
      refineActionPlan: (input: unknown) => refineMock(input),
      revertLastActionPlanRefinement: (input: unknown) => revertMock(input),
      commitActionPlan: (input: unknown) => commitMock(input),
    },
  };
});

import { useActionPlanCard } from "../useActionPlanCard";

const INITIAL_PLAN: ActionPlan = {
  pipelines: [
    {
      name: "Inbound Lead Pipeline",
      segment: "new_leads",
      strategy: "direct",
      audienceConditions: {
        field: "lifecycleStage",
        op: "in",
        values: ["lead"],
      },
      audienceCount: 300,
      proposedStages: [
        { name: "Outreach", order: 0, description: "Day-0 outbound" },
        { name: "Qualify", order: 1, description: "Discovery call" },
        { name: "Close", order: 2, description: "Proposal + close" },
      ],
      firstActions: [
        {
          day: 0,
          channel: "email",
          intent: "outreach",
          description: "Day-0 personalized intro",
        },
      ],
      projectedContribution: 15,
      shareOfGoal: 30,
    },
  ],
  confidence: "high",
  confidenceReason: "200+ closed deals over 365d",
  gapAnalysis: {
    goalTarget: 50,
    projectedOrganic: 15,
    gapAbsolute: 35,
    gapPercent: 70,
    goalWindowDays: 90,
  },
  modelUsed: "claude-sonnet-4-6",
  generatedAt: "2026-06-15T19:00:00.000Z",
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  refineMock.mockReset();
  revertMock.mockReset();
  commitMock.mockReset();
});

describe("useActionPlanCard — refine paths", () => {
  it("happy: refine → setPlan with returned plan + refineResult populated", async () => {
    const refinedPlan: ActionPlan = {
      ...INITIAL_PLAN,
      pipelines: [
        { ...INITIAL_PLAN.pipelines[0], name: "Refined Pipeline" },
      ],
    };
    refineMock.mockResolvedValueOnce({
      kind: "action_plan_refined",
      plan: refinedPlan,
      campaignId: "campaign-1",
      editAxis: "stage",
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.refine("rename stage 1 to Discovery"));
    await waitFor(() => {
      expect(result.current.plan.pipelines[0].name).toBe("Refined Pipeline");
      expect(result.current.refineResult?.kind).toBe("action_plan_refined");
    });
  });

  it("variant bounds_violation: refineResult set; plan unchanged", async () => {
    refineMock.mockResolvedValueOnce({
      kind: "bounds_violation",
      message: "Stage edit rejected — direct strategy requires 2-4 stages.",
      campaignId: "campaign-1",
      strategy: "direct",
      attemptedStageCount: 1,
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.refine("remove stage 1"));
    await waitFor(() => {
      expect(result.current.refineResult?.kind).toBe("bounds_violation");
    });
    // Plan unchanged on bounds violation
    expect(result.current.plan.pipelines[0].name).toBe(
      INITIAL_PLAN.pipelines[0].name,
    );
  });

  it("variant concurrent_edit_conflict: refineResult set with currentPlan; plan unchanged", async () => {
    const serverPlan = { ...INITIAL_PLAN, generatedAt: "2026-06-15T22:00:00.000Z" };
    refineMock.mockResolvedValueOnce({
      kind: "concurrent_edit_conflict",
      message: "Another edit landed.",
      campaignId: "campaign-1",
      currentPlan: serverPlan,
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.refine("rename"));
    await waitFor(() => {
      expect(result.current.refineResult?.kind).toBe("concurrent_edit_conflict");
    });
    expect(result.current.plan.generatedAt).toBe(INITIAL_PLAN.generatedAt);
  });
});

describe("useActionPlanCard — revert paths", () => {
  it("happy: revert → setPlan to prior plan", async () => {
    const priorPlan: ActionPlan = {
      ...INITIAL_PLAN,
      pipelines: [
        { ...INITIAL_PLAN.pipelines[0], name: "Pre-revert Pipeline" },
      ],
    };
    revertMock.mockResolvedValueOnce({
      kind: "action_plan_reverted",
      plan: priorPlan,
      campaignId: "campaign-1",
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.revert());
    await waitFor(() => {
      expect(result.current.plan.pipelines[0].name).toBe("Pre-revert Pipeline");
      expect(result.current.revertResult?.kind).toBe("action_plan_reverted");
    });
  });

  it("variant no_refinement_to_revert: revertResult set; plan unchanged", async () => {
    revertMock.mockResolvedValueOnce({
      kind: "no_refinement_to_revert",
      message: "No refinement history to revert.",
      campaignId: "campaign-1",
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.revert());
    await waitFor(() => {
      expect(result.current.revertResult?.kind).toBe("no_refinement_to_revert");
    });
    expect(result.current.plan.pipelines[0].name).toBe(
      INITIAL_PLAN.pipelines[0].name,
    );
  });
});

describe("useActionPlanCard — commit paths", () => {
  it("happy: commit → commitResult kind 'committed' with pipelineIds", async () => {
    commitMock.mockResolvedValueOnce({
      kind: "committed",
      campaignId: "campaign-1",
      pipelineIds: ["pipeline-1"],
      stageIds: [["stage-1", "stage-2", "stage-3"]],
      committedPlan: {
        campaignName: "Q3 Push",
        committedAt: "2026-06-15T20:00:00.000Z",
        plan: INITIAL_PLAN,
        pipelineIds: ["pipeline-1"],
      },
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.commit());
    await waitFor(() => {
      expect(result.current.commitResult?.kind).toBe("committed");
    });
    if (result.current.commitResult?.kind === "committed") {
      expect(result.current.commitResult.pipelineIds).toEqual(["pipeline-1"]);
    }
  });

  it("J8 idempotency: commit returns 'already_committed' with same pipelineIds", async () => {
    commitMock.mockResolvedValueOnce({
      kind: "already_committed",
      campaignId: "campaign-1",
      pipelineIds: ["pipeline-1"],
      committedPlan: {
        campaignName: "Q3 Push",
        committedAt: "2026-06-15T20:00:00.000Z",
        plan: INITIAL_PLAN,
        pipelineIds: ["pipeline-1"],
      },
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.commit());
    await waitFor(() => {
      expect(result.current.commitResult?.kind).toBe("already_committed");
    });
    if (result.current.commitResult?.kind === "already_committed") {
      expect(result.current.commitResult.pipelineIds).toEqual(["pipeline-1"]);
    }
  });

  it("variant bounds_violation: commitResult set; can be cleared", async () => {
    commitMock.mockResolvedValueOnce({
      kind: "bounds_violation",
      message: "STRATEGY_STAGE_BOUNDS re-check failed at commit time.",
      campaignId: "campaign-1",
      strategy: "direct",
      attemptedStageCount: 1,
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.commit());
    await waitFor(() => {
      expect(result.current.commitResult?.kind).toBe("bounds_violation");
    });
    act(() => result.current.clearCommitResult());
    expect(result.current.commitResult).toBeNull();
  });
});

// KAN-1205 LOAD-BEARING — assert UI hook DOES NOT pass expectedUpdatedAt.
// Original wiring sent plan.generatedAt as the J11 token, which always
// false-positived as concurrent_edit_conflict (T1 < T2). UI now relies on
// J8 idempotency for double-click protection.
describe("useActionPlanCard — KAN-1205 contract (NO expectedUpdatedAt from UI)", () => {
  it("refine invocation MUST NOT include expectedUpdatedAt", async () => {
    refineMock.mockResolvedValueOnce({
      kind: "action_plan_refined",
      plan: INITIAL_PLAN,
      campaignId: "campaign-1",
      editAxis: "stage",
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.refine("rename stage 1"));
    await waitFor(() => {
      expect(refineMock).toHaveBeenCalledTimes(1);
    });
    const callArg = refineMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).toMatchObject({
      campaignId: "campaign-1",
      refinementMessage: "rename stage 1",
    });
    expect(callArg).not.toHaveProperty("expectedUpdatedAt");
  });

  it("commit invocation MUST NOT include expectedUpdatedAt", async () => {
    commitMock.mockResolvedValueOnce({
      kind: "committed",
      campaignId: "campaign-1",
      pipelineIds: ["pipeline-1"],
      stageIds: [["stage-1"]],
      committedPlan: {
        campaignName: "Q3 Push",
        committedAt: "2026-06-15T20:00:00.000Z",
        plan: INITIAL_PLAN,
        pipelineIds: ["pipeline-1"],
      },
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.commit());
    await waitFor(() => {
      expect(commitMock).toHaveBeenCalledTimes(1);
    });
    const callArg = commitMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).toMatchObject({ campaignId: "campaign-1" });
    expect(callArg).not.toHaveProperty("expectedUpdatedAt");
  });
});

describe("useActionPlanCard — applyExternalPlan + clearCommitResult", () => {
  it("applyExternalPlan: replaces plan + resets refineResult + commitResult", async () => {
    // Seed a refineResult first
    refineMock.mockResolvedValueOnce({
      kind: "bounds_violation",
      message: "msg",
      campaignId: "campaign-1",
      strategy: "direct",
      attemptedStageCount: 1,
    });
    const { result } = renderHook(
      () =>
        useActionPlanCard({
          campaignId: "campaign-1",
          initialPlan: INITIAL_PLAN,
        }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.refine("remove stage"));
    await waitFor(() => {
      expect(result.current.refineResult?.kind).toBe("bounds_violation");
    });

    const newPlan: ActionPlan = {
      ...INITIAL_PLAN,
      pipelines: [
        { ...INITIAL_PLAN.pipelines[0], name: "External Replacement" },
      ],
    };
    act(() => result.current.applyExternalPlan(newPlan));
    expect(result.current.plan.pipelines[0].name).toBe("External Replacement");
    expect(result.current.refineResult).toBeNull();
    expect(result.current.commitResult).toBeNull();
  });
});
