/**
 * KAN-1191 — PipelineCard (new/_components) RTL coverage.
 *
 * Memos cited:
 *   - surface_completeness_doctrine (KAN-1188 G1 — per-Pipeline sub-card)
 *
 * Scope:
 *   (a) Collapsed by default; stages + first-actions not visible
 *   (b) Click header → expand; stages + first-actions visible
 *   (c) Click again → collapse (toggle pattern)
 *   (d) Strategy badge label per ActionPlanPipeline strategy enum
 *   (e) Per-pipeline summary: name + segment + audienceCount
 *   (f) Stages count + each stage name in order
 *   (g) First-actions count + Day/channel/intent surfaced
 *   (h) aria-expanded reflects state for accessibility
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PipelineCard } from "../PipelineCard";
import type { ActionPlanPipeline } from "@growth/shared";

function pipelineFixture(
  overrides: Partial<ActionPlanPipeline> = {},
): ActionPlanPipeline {
  return {
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
    ...overrides,
  };
}

describe("PipelineCard (KAN-1191)", () => {
  it("collapsed by default: stages + first-actions hidden", () => {
    render(
      <PipelineCard pipeline={pipelineFixture()} index={0} goalType="units" />,
    );
    expect(screen.queryByText(/Day-0 personalized intro/)).toBeNull();
    expect(screen.queryByText(/Day-0 outbound/)).toBeNull();
  });

  it("aria-expanded='false' when collapsed", () => {
    render(
      <PipelineCard pipeline={pipelineFixture()} index={0} goalType="units" />,
    );
    const article = screen.getByRole("article");
    const toggle = within(article).getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("click header → expand: stages + first-actions visible", async () => {
    render(
      <PipelineCard pipeline={pipelineFixture()} index={0} goalType="units" />,
    );
    const article = screen.getByRole("article");
    await userEvent.click(within(article).getByRole("button"));
    expect(within(article).getByText(/Day-0 outbound/)).toBeInTheDocument();
    expect(
      within(article).getByText(/Day-0 personalized intro/),
    ).toBeInTheDocument();
    expect(within(article).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("click twice → toggle back to collapsed", async () => {
    render(
      <PipelineCard pipeline={pipelineFixture()} index={0} goalType="units" />,
    );
    const article = screen.getByRole("article");
    const toggle = within(article).getByRole("button");
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    expect(within(article).queryByText(/Day-0 outbound/)).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("renders strategy badge label per enum value", async () => {
    const { rerender } = render(
      <PipelineCard pipeline={pipelineFixture()} index={0} goalType="units" />,
    );
    expect(screen.getByText(/Direct Conversion/i)).toBeInTheDocument();
    rerender(
      <PipelineCard
        pipeline={pipelineFixture({ strategy: "trust_build" })}
        index={0}
        goalType="units"
      />,
    );
    expect(screen.getByText(/Trust Building/i)).toBeInTheDocument();
    rerender(
      <PipelineCard
        pipeline={pipelineFixture({ strategy: "guided" })}
        index={0}
        goalType="units"
      />,
    );
    expect(screen.getByText(/Guided Assistance/i)).toBeInTheDocument();
  });

  it("renders summary: name + segment + audienceCount + projectedContribution", () => {
    render(
      <PipelineCard pipeline={pipelineFixture()} index={0} goalType="units" />,
    );
    expect(screen.getByText("Inbound Lead Pipeline")).toBeInTheDocument();
    expect(screen.getByText(/new leads/)).toBeInTheDocument();
    expect(screen.getByText(/300 contacts/)).toBeInTheDocument();
    expect(screen.getByText(/15 units/)).toBeInTheDocument();
  });

  it("expanded: Stages count + each stage in order", async () => {
    render(
      <PipelineCard pipeline={pipelineFixture()} index={0} goalType="units" />,
    );
    const article = screen.getByRole("article");
    await userEvent.click(within(article).getByRole("button"));
    expect(within(article).getByText(/Stages \(3\)/)).toBeInTheDocument();
    expect(within(article).getByText(/1\. Outreach/)).toBeInTheDocument();
    expect(within(article).getByText(/2\. Qualify/)).toBeInTheDocument();
    expect(within(article).getByText(/3\. Close/)).toBeInTheDocument();
  });

  it("expanded: First actions count + Day/channel/intent surfaced", async () => {
    render(
      <PipelineCard pipeline={pipelineFixture()} index={0} goalType="units" />,
    );
    const article = screen.getByRole("article");
    await userEvent.click(within(article).getByRole("button"));
    expect(within(article).getByText(/First actions \(1\)/)).toBeInTheDocument();
    expect(
      within(article).getByText(/Day 0 · email · outreach/),
    ).toBeInTheDocument();
  });
});
