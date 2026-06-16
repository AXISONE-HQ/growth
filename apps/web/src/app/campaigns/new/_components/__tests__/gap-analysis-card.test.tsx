/**
 * KAN-1191 — GapAnalysisCard RTL coverage.
 *
 * Honest counsel doctrine — the data speaks for itself via numbers; no
 * prose synthesis. This test asserts numeric faithfulness across the
 * positive-gap (short of goal) and surplus (at/above goal) branches.
 *
 * Memos cited:
 *   - surface_completeness_doctrine (KAN-1188 G7 — numeric block)
 *   - operator_session_reveals_scope_gaps (KAN-1206 parent doctrine)
 *
 * Scope:
 *   (a) goalTarget + goalType + goalWindowDays line
 *   (b) projectedOrganic with gapPercent
 *   (c) Per-pipeline breakdown (name + audienceCount + projectedContribution + shareOfGoal)
 *   (d) Surplus path: "at or above goal" + "+N surplus"
 *   (e) Empty pipelines: per-pipeline section hidden
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { GapAnalysisCard } from "../GapAnalysisCard";
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

describe("GapAnalysisCard (KAN-1191)", () => {
  it("renders Goal line: '{goalTarget} {goalType} in {goalWindowDays} days'", () => {
    render(<GapAnalysisCard plan={BASE_PLAN} goalType="units" />);
    const section = screen.getByLabelText("Gap analysis");
    expect(within(section).getByText(/50 units in 90 days/i)).toBeInTheDocument();
  });

  it("renders Projected line with gapPercent indicator", () => {
    render(<GapAnalysisCard plan={BASE_PLAN} goalType="units" />);
    const section = screen.getByLabelText("Gap analysis");
    // `15 units` appears in both the Projected `<dd>` and the per-pipeline
    // breakdown `<span>` — getAllByText to disambiguate, then assert >=1
    expect(within(section).getAllByText(/15 units/).length).toBeGreaterThanOrEqual(1);
    expect(within(section).getByText(/70% short/)).toBeInTheDocument();
  });

  it("renders Gap line: '{gapAbsolute} {goalType} short'", () => {
    render(<GapAnalysisCard plan={BASE_PLAN} goalType="units" />);
    const section = screen.getByLabelText("Gap analysis");
    expect(within(section).getByText(/35 units short/)).toBeInTheDocument();
  });

  it("renders per-pipeline breakdown (name + contacts + projected + shareOfGoal)", () => {
    render(<GapAnalysisCard plan={BASE_PLAN} goalType="units" />);
    const section = screen.getByLabelText("Gap analysis");
    expect(within(section).getByText(/Inbound Lead Pipeline/)).toBeInTheDocument();
    expect(within(section).getByText(/300 contacts/)).toBeInTheDocument();
    // `15 units` appears in both Projected row + per-pipeline row — multi-match OK
    expect(within(section).getAllByText(/15 units/).length).toBeGreaterThanOrEqual(1);
    expect(within(section).getByText(/30% of goal/)).toBeInTheDocument();
  });

  it("surplus path: 'at or above goal' + '+N surplus' rendering when gapAbsolute <= 0", () => {
    const surplusPlan: ActionPlan = {
      ...BASE_PLAN,
      gapAnalysis: {
        goalTarget: 50,
        projectedOrganic: 60,
        gapAbsolute: -10,
        gapPercent: 0,
        goalWindowDays: 90,
      },
    };
    render(<GapAnalysisCard plan={surplusPlan} goalType="units" />);
    const section = screen.getByLabelText("Gap analysis");
    expect(within(section).getByText(/at or above goal/i)).toBeInTheDocument();
    expect(within(section).getByText(/\+10 units surplus/)).toBeInTheDocument();
  });

  it("empty pipelines: per-pipeline breakdown section hidden", () => {
    const noPipelinesPlan: ActionPlan = { ...BASE_PLAN, pipelines: [] };
    render(<GapAnalysisCard plan={noPipelinesPlan} goalType="units" />);
    const section = screen.getByLabelText("Gap analysis");
    expect(
      within(section).queryByText(/Per-pipeline contribution/i),
    ).toBeNull();
  });

  it("multi-pipeline: renders each pipeline's contribution row distinctly", () => {
    const multiPlan: ActionPlan = {
      ...BASE_PLAN,
      pipelines: [
        BASE_PLAN.pipelines[0],
        {
          ...BASE_PLAN.pipelines[0],
          name: "Re-engagement Pipeline",
          strategy: "re_engage",
          proposedStages: [
            { name: "Re-open", order: 0, description: "Open" },
            { name: "Pain check", order: 1, description: "Check" },
            { name: "Close", order: 2, description: "Close" },
          ],
          audienceCount: 150,
          projectedContribution: 10,
          shareOfGoal: 20,
        },
      ],
    };
    render(<GapAnalysisCard plan={multiPlan} goalType="units" />);
    const section = screen.getByLabelText("Gap analysis");
    expect(within(section).getByText(/Inbound Lead Pipeline/)).toBeInTheDocument();
    expect(within(section).getByText(/Re-engagement Pipeline/)).toBeInTheDocument();
    expect(within(section).getByText(/150 contacts/)).toBeInTheDocument();
    expect(within(section).getByText(/20% of goal/)).toBeInTheDocument();
  });
});
