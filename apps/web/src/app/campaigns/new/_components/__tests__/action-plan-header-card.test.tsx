/**
 * KAN-1191 — ActionPlanHeaderCard RTL coverage.
 *
 * Memos cited:
 *   - surface_completeness_doctrine (KAN-1188 G1 — header layout)
 *   - operator_session_reveals_scope_gaps (KAN-1206 parent doctrine)
 *
 * Scope:
 *   (a) Campaign name + confidence badge (high / medium / low)
 *   (b) generatedAt + modelUsed subtitle
 *   (c) Commit button rendered + onCommit dispatched on click
 *   (d) Undo button rendered + onRevert dispatched on click
 *   (e) commitHidden=true hides Commit button (post-commit state)
 *   (f) Disabled state during isCommitting + isReverting
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionPlanHeaderCard } from "../ActionPlanHeaderCard";
import type { ActionPlan } from "@/lib/api";

const BASE_PLAN: ActionPlan = {
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
        { day: 0, channel: "email", intent: "outreach", description: "Day-0" },
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

function renderHeader(
  overrides: Partial<Parameters<typeof ActionPlanHeaderCard>[0]> = {},
) {
  return render(
    <ActionPlanHeaderCard
      plan={BASE_PLAN}
      campaignName="Q3 Push"
      onRevert={vi.fn()}
      isReverting={false}
      revertDisabled={false}
      onCommit={vi.fn()}
      isCommitting={false}
      {...overrides}
    />,
  );
}

describe("ActionPlanHeaderCard (KAN-1191)", () => {
  it("renders campaignName + High confidence badge", () => {
    renderHeader();
    expect(screen.getByText("Q3 Push")).toBeInTheDocument();
    expect(screen.getByText(/High confidence/i)).toBeInTheDocument();
  });

  it("renders Medium / Low confidence variants", () => {
    const { rerender } = renderHeader({
      plan: { ...BASE_PLAN, confidence: "medium" },
    });
    expect(screen.getByText(/Medium confidence/i)).toBeInTheDocument();
    rerender(
      <ActionPlanHeaderCard
        plan={{ ...BASE_PLAN, confidence: "low" }}
        campaignName="Q3 Push"
        onRevert={vi.fn()}
        isReverting={false}
        revertDisabled={false}
        onCommit={vi.fn()}
        isCommitting={false}
      />,
    );
    expect(screen.getByText(/Low confidence/i)).toBeInTheDocument();
  });

  it("renders modelUsed in the subtitle", () => {
    renderHeader();
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
  });

  it("Commit button click dispatches onCommit", async () => {
    const onCommit = vi.fn();
    renderHeader({ onCommit });
    await userEvent.click(
      screen.getByRole("button", { name: /Commit plan/i }),
    );
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("Undo button click dispatches onRevert", async () => {
    const onRevert = vi.fn();
    renderHeader({ onRevert });
    await userEvent.click(
      screen.getByRole("button", { name: /Undo last edit/i }),
    );
    expect(onRevert).toHaveBeenCalledTimes(1);
  });

  it("commitHidden=true hides the Commit button", () => {
    renderHeader({ commitHidden: true });
    expect(screen.queryByRole("button", { name: /Commit plan/i })).toBeNull();
    // Undo still rendered
    expect(
      screen.getByRole("button", { name: /Undo last edit/i }),
    ).toBeInTheDocument();
  });

  it("isCommitting=true: Commit button shows 'Committing…' + is disabled", () => {
    renderHeader({ isCommitting: true });
    const commitBtn = screen.getByRole("button", { name: /Committing…/i });
    expect(commitBtn).toBeDisabled();
    // Undo also disabled while committing per shared revertDisabled signal
    expect(
      screen.getByRole("button", { name: /Undo last edit/i }),
    ).toBeDisabled();
  });

  it("isReverting=true: Undo button shows 'Reverting…' + is disabled", () => {
    renderHeader({ isReverting: true });
    expect(
      screen.getByRole("button", { name: /Reverting…/i }),
    ).toBeDisabled();
  });

  it("revertDisabled=true: Undo button is disabled regardless of pending state", () => {
    renderHeader({ revertDisabled: true, revertDisabledReason: "No edits yet" });
    expect(
      screen.getByRole("button", { name: /Undo last edit/i }),
    ).toBeDisabled();
  });
});
