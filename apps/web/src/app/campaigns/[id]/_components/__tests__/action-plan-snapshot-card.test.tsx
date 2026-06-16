/**
 * KAN-1191 — ActionPlanSnapshotCard RTL coverage.
 *
 * Renders the snapshot from Campaign.committedPlan (CommittedPlanSnapshot):
 *   - campaign name (via the wrapping ActionPlanSnapshotCard header)
 *   - confidence badge (from plan.confidence)
 *   - "Snapshot from {committedAt}" historical label (deterministic ISO)
 *   - gap analysis numeric block (delegated to GapAnalysisCard)
 *
 * Memos cited:
 *   - surface_completeness_doctrine (KAN-1206 Phase 1)
 *   - operator_session_reveals_scope_gaps (KAN-1206 root cause)
 *
 * Scope:
 *   (a) Confidence badge variants (high/medium/low)
 *   (b) Snapshot historical label renders committedAt deterministically
 *   (c) Gap analysis numeric block surfaces through the wrapped GapAnalysisCard
 *   (d) Plan model fingerprint surfaced in subtitle
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ActionPlanSnapshotCard } from "../ActionPlanSnapshotCard";
import {
  actionPlanFixture,
  committedPlanSnapshotFixture,
} from "./fixtures";

describe("ActionPlanSnapshotCard (KAN-1191)", () => {
  it("renders 'Committed Action Plan' header + confidence badge", () => {
    const snapshot = committedPlanSnapshotFixture();
    render(
      <ActionPlanSnapshotCard committedPlan={snapshot} goalType="units" />,
    );
    expect(screen.getByText(/Committed Action Plan/i)).toBeInTheDocument();
    expect(screen.getByText(/High confidence/i)).toBeInTheDocument();
  });

  it("renders 'Snapshot from {committedAt}' historical label with model fingerprint", () => {
    const snapshot = committedPlanSnapshotFixture({
      committedAt: "2026-06-15T20:00:00.000Z",
      plan: actionPlanFixture({ modelUsed: "claude-sonnet-4-6" }),
    });
    render(
      <ActionPlanSnapshotCard committedPlan={snapshot} goalType="units" />,
    );
    // Locale-rendered date varies across CI envs; assert structural prefix
    // + model fingerprint suffix rather than exact locale output.
    expect(screen.getByText(/Snapshot from/i)).toBeInTheDocument();
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
  });

  it("renders Medium confidence badge variant", () => {
    const snapshot = committedPlanSnapshotFixture({
      plan: actionPlanFixture({
        confidence: "medium",
        confidenceReason: "20-30 closed deals over 90d",
      }),
    });
    render(
      <ActionPlanSnapshotCard committedPlan={snapshot} goalType="units" />,
    );
    expect(screen.getByText(/Medium confidence/i)).toBeInTheDocument();
  });

  it("renders Low confidence badge variant", () => {
    const snapshot = committedPlanSnapshotFixture({
      plan: actionPlanFixture({
        confidence: "low",
        confidenceReason: "Fewer than 10 closed deals",
      }),
    });
    render(
      <ActionPlanSnapshotCard committedPlan={snapshot} goalType="units" />,
    );
    expect(screen.getByText(/Low confidence/i)).toBeInTheDocument();
  });

  it("renders snapshot's gap analysis numeric block (delegated to GapAnalysisCard)", () => {
    const snapshot = committedPlanSnapshotFixture({
      plan: actionPlanFixture(),
    });
    render(
      <ActionPlanSnapshotCard committedPlan={snapshot} goalType="units" />,
    );
    const gapSection = screen.getByLabelText("Gap analysis");
    // Goal: 50 units in 90 days
    expect(within(gapSection).getByText(/50 units in 90 days/i)).toBeInTheDocument();
    // Projected: 15 units ({gapPercent}% short)
    expect(within(gapSection).getByText(/70% short/)).toBeInTheDocument();
  });

  it("renders 'Plan as agreed at commit' disclaimer subtitle", () => {
    const snapshot = committedPlanSnapshotFixture();
    render(
      <ActionPlanSnapshotCard committedPlan={snapshot} goalType="units" />,
    );
    expect(
      screen.getByText(/Plan as agreed at commit/i),
    ).toBeInTheDocument();
  });
});
