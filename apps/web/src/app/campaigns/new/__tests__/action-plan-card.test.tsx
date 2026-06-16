/**
 * KAN-1188 — ActionPlanCard RTL coverage.
 *
 * 14 scenarios across 5 groups:
 *   (a) Header + GapAnalysis numeric rendering (4)
 *   (b) PipelineCard expand/collapse (Y2) (2)
 *   (c) ChatRefinementInput + 4-family chips (G3) (3)
 *   (d) Refiner result variants (G4/G5/G6) (3)
 *   (e) Undo flow (G9) (2)
 *
 * Mock seams:
 *   - campaignsApi.refineActionPlan + revertLastActionPlanRefinement via vi.mock
 *   - React Query client wrapper per test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActionPlan } from "@/lib/api";

const refineMock = vi.fn();
const revertMock = vi.fn();
const commitMock = vi.fn();
const pushMock = vi.fn();

vi.mock("@/lib/api", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    campaignsApi: {
      ...(actual as { campaignsApi?: Record<string, unknown> }).campaignsApi,
      refineActionPlan: (input: unknown) => refineMock(input),
      revertLastActionPlanRefinement: (input: unknown) => revertMock(input),
      // KAN-1190 — commitActionPlan added to ActionPlanCard via useActionPlanCard
      // hook. Mock prevents real tRPC dispatch when hook initializes its mutation.
      commitActionPlan: (input: unknown) => commitMock(input),
    },
  };
});

// KAN-1190 — useRouter is consumed by ActionPlanCard for the J10 success-state
// "Open Campaign" navigation. Tests run outside the Next app-router provider,
// so we stub useRouter() to a deterministic mock — pushMock asserts navigation
// targets are correct in future J10-coverage tests (deferred to KAN-1191).
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import { ActionPlanCard } from "../_components/ActionPlanCard";

const PLAN: ActionPlan = {
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

function renderCard(plan: ActionPlan = PLAN) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ActionPlanCard
        campaignId="campaign-1"
        initialPlan={plan}
        campaignName="Q3 Push"
        goalType="units"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  refineMock.mockReset();
  revertMock.mockReset();
  commitMock.mockReset();
  pushMock.mockReset();
});

// ─────────────────────────────────────────────
// (a) Header + GapAnalysis numeric rendering
// ─────────────────────────────────────────────

describe("Header + GapAnalysis (G7 honest counsel — structural numbers)", () => {
  it("renders campaign name + confidence badge", () => {
    renderCard();
    expect(screen.getByText("Q3 Push")).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
  });

  it("renders goal target with units + goalWindowDays", () => {
    renderCard();
    expect(screen.getByText(/50 units in 90 days/i)).toBeInTheDocument();
  });

  it("renders projected organic with gap percent", () => {
    renderCard();
    expect(screen.getAllByText(/15 units/).length).toBeGreaterThanOrEqual(1);
    // `70% short` appears in header summary + gap analysis
    expect(screen.getAllByText(/70% short/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders per-pipeline contribution breakdown", () => {
    renderCard();
    // Scope to the Gap Analysis section to disambiguate from PipelineCard chip
    const gapSection = screen.getByLabelText("Gap analysis");
    expect(within(gapSection).getByText(/Inbound Lead Pipeline/)).toBeInTheDocument();
    expect(within(gapSection).getByText(/300 contacts/)).toBeInTheDocument();
    expect(within(gapSection).getByText(/30% of goal/)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────
// (b) PipelineCard expand/collapse (Y2)
// ─────────────────────────────────────────────

describe("PipelineCard expansion (Y2 — useState at parent)", () => {
  it("renders collapsed by default; stages not visible", () => {
    renderCard();
    expect(screen.queryByText(/Day-0 personalized intro/i)).toBeNull();
  });

  it("expands on header click; stages + first-actions become visible", async () => {
    renderCard();
    // Scope to the PipelineCard via aria-label, then click its button
    const card = screen.getByRole("article", {
      name: /Pipeline 1: Inbound Lead Pipeline/i,
    });
    const toggle = within(card).getByRole("button");
    await userEvent.click(toggle);
    expect(within(card).getByText(/Day-0 outbound/)).toBeInTheDocument();
    expect(within(card).getByText(/Day-0 personalized intro/)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────
// (c) ChatRefinementInput + 4-family chips (G3)
// ─────────────────────────────────────────────

describe("ChatRefinementInput (G3 4-family chips + send)", () => {
  it("renders all 4 axis chips", () => {
    renderCard();
    expect(screen.getByRole("button", { name: /^Stages$/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^First Actions$/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Audience$/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Dimension$/ }),
    ).toBeInTheDocument();
  });

  it("clicking a chip pre-fills the input with the family starter", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: /^Stages$/ }));
    const input = screen.getByLabelText(/Refine the Action Plan/i);
    expect((input as HTMLInputElement).value).toBe("Rename stage 1 to ");
  });

  // KAN-1205 — refineMutation no longer passes expectedUpdatedAt. plan.generatedAt
  // (LLM generation timestamp T1) never matches Campaign.updatedAt (Prisma
  // @updatedAt T2 — set on persist), so the server-side J11 check always
  // false-positived as concurrent_edit_conflict on operator-driven refine.
  // Server-side J11 stays operational for direct API consumers (admin tools,
  // third-party integrations); UI relies on J8 idempotency for double-click
  // protection. See j11_j8_redundancy_doctrine memo.
  it("Send dispatches refineMock with refinementMessage (no expectedUpdatedAt per KAN-1205)", async () => {
    refineMock.mockResolvedValueOnce({
      kind: "action_plan_refined",
      plan: PLAN,
      campaignId: "campaign-1",
      editAxis: "stage",
    });
    renderCard();
    const input = screen.getByLabelText(/Refine the Action Plan/i);
    await userEvent.type(input, "Rename stage 1 to Discovery");
    await userEvent.click(screen.getByRole("button", { name: /Send refinement/i }));
    await waitFor(() => {
      expect(refineMock).toHaveBeenCalledWith({
        campaignId: "campaign-1",
        refinementMessage: "Rename stage 1 to Discovery",
      });
    });
  });
});

// ─────────────────────────────────────────────
// (d) Refiner result variants
// ─────────────────────────────────────────────

describe("Refiner result variants (G4/G5/G6)", () => {
  it("renders bounds_violation banner with strategy badge", async () => {
    refineMock.mockResolvedValueOnce({
      kind: "bounds_violation",
      message:
        "Stage edit rejected — direct strategy requires 2-4 stages; attempted 1.",
      campaignId: "campaign-1",
      strategy: "direct",
      attemptedStageCount: 1,
    });
    renderCard();
    await userEvent.type(
      screen.getByLabelText(/Refine the Action Plan/i),
      "remove stage 1",
    );
    await userEvent.click(screen.getByRole("button", { name: /Send refinement/i }));
    expect(
      await screen.findByText(/Stage edit rejected/i),
    ).toBeInTheDocument();
  });

  it("renders concurrent_edit_conflict banner with Reload affordance", async () => {
    const conflictPlan = { ...PLAN, generatedAt: "2026-06-15T20:00:00.000Z" };
    refineMock.mockResolvedValueOnce({
      kind: "concurrent_edit_conflict",
      message:
        "Another edit landed while you were refining. Review the current plan + re-apply.",
      campaignId: "campaign-1",
      currentPlan: conflictPlan,
    });
    renderCard();
    await userEvent.type(
      screen.getByLabelText(/Refine the Action Plan/i),
      "rename stage",
    );
    await userEvent.click(screen.getByRole("button", { name: /Send refinement/i }));
    expect(
      await screen.findByRole("button", { name: /Reload to current/i }),
    ).toBeInTheDocument();
  });

  it("renders no_plan_to_refine alert", async () => {
    refineMock.mockResolvedValueOnce({
      kind: "no_plan_to_refine",
      message: "The Action Plan was cleared. Generate a new one to refine.",
      campaignId: "campaign-1",
    });
    renderCard();
    await userEvent.type(
      screen.getByLabelText(/Refine the Action Plan/i),
      "rename",
    );
    await userEvent.click(screen.getByRole("button", { name: /Send refinement/i }));
    expect(
      await screen.findByText(/Action Plan was cleared/i),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────
// (e) Undo flow (G9)
// ─────────────────────────────────────────────

describe("Undo flow (G9 — revertLastRefinement)", () => {
  it("Undo button is rendered + clickable", () => {
    renderCard();
    expect(
      screen.getByRole("button", { name: /Undo last edit/i }),
    ).toBeEnabled();
  });

  it("Undo dispatches revertMock and applies reverted plan on success", async () => {
    const priorPlan: ActionPlan = {
      ...PLAN,
      pipelines: [{ ...PLAN.pipelines[0], name: "Pre-revert Pipeline" }],
      generatedAt: "2026-06-15T18:00:00.000Z",
    };
    revertMock.mockResolvedValueOnce({
      kind: "action_plan_reverted",
      plan: priorPlan,
      campaignId: "campaign-1",
    });
    renderCard();
    await userEvent.click(
      screen.getByRole("button", { name: /Undo last edit/i }),
    );
    await waitFor(() => {
      expect(revertMock).toHaveBeenCalledWith({ campaignId: "campaign-1" });
    });
    // Wait for plan state to apply + re-render — name appears in both the
    // PipelineCard chip and the GapAnalysis breakdown, so use getAllByText.
    await waitFor(
      () => {
        expect(screen.getAllByText(/Pre-revert Pipeline/).length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 },
    );
  });
});
