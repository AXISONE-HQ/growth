/**
 * KAN-1191 — CommittedPipelineCard RTL coverage.
 *
 * Renders the LIVE Pipeline + Stages list per Pipeline. The deep-link to
 * /settings/pipelines/{id} (N6 lock) is the load-bearing affordance — the
 * card defers ALL Pipeline editing to the existing canonical detail view
 * (KAN-708 + KAN-1169) rather than duplicating the form.
 *
 * Memos cited:
 *   - surface_completeness_doctrine (KAN-1206 Phase 1)
 *   - operator_session_reveals_scope_gaps (KAN-1206 root cause)
 *
 * Scope:
 *   (a) Pipeline name + stages count + each stage in order
 *   (b) N6 lock: <a href="/settings/pipelines/{id}"> deep-link per Pipeline
 *   (c) Strategy badge per Pipeline (from snapshot slice)
 *   (d) Audience-count + projectedContribution summary (from snapshot)
 *   (e) Initial / Terminal stage badges surface
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CommittedPipelineCard } from "../CommittedPipelineCard";
import type { PipelineWithStages } from "@/lib/api";
import { actionPlanFixture } from "./fixtures";

function pipelineFixture(
  overrides: Partial<PipelineWithStages> = {},
): PipelineWithStages {
  return {
    id: "pipeline-1",
    name: "Inbound Lead Pipeline",
    description: null,
    objectiveId: "obj-1",
    stages: [
      {
        id: "stage-1",
        name: "Outreach",
        order: 0,
        isInitial: true,
        isTerminal: false,
        outcomeType: "open",
      },
      {
        id: "stage-2",
        name: "Qualify",
        order: 1,
        isInitial: false,
        isTerminal: false,
        outcomeType: "open",
      },
      {
        id: "stage-3",
        name: "Close",
        order: 2,
        isInitial: false,
        isTerminal: true,
        outcomeType: "terminal_won",
      },
    ],
    ...overrides,
  };
}

describe("CommittedPipelineCard (KAN-1191)", () => {
  it("renders Pipeline name and stages count", () => {
    const pipeline = pipelineFixture();
    const snapshot = actionPlanFixture().pipelines[0];
    render(
      <CommittedPipelineCard
        pipeline={pipeline}
        snapshot={snapshot}
        index={0}
        goalType="units"
      />,
    );
    const article = screen.getByRole("article", {
      name: /Pipeline 1: Inbound Lead Pipeline/i,
    });
    expect(
      within(article).getByText(/Inbound Lead Pipeline/),
    ).toBeInTheDocument();
    expect(within(article).getByText(/Stages \(3\)/)).toBeInTheDocument();
  });

  it("renders each stage name in stage order", () => {
    const pipeline = pipelineFixture();
    const snapshot = actionPlanFixture().pipelines[0];
    render(
      <CommittedPipelineCard
        pipeline={pipeline}
        snapshot={snapshot}
        index={0}
        goalType="units"
      />,
    );
    const article = screen.getByRole("article", {
      name: /Pipeline 1: Inbound Lead Pipeline/i,
    });
    expect(within(article).getByText("Outreach")).toBeInTheDocument();
    expect(within(article).getByText("Qualify")).toBeInTheDocument();
    expect(within(article).getByText("Close")).toBeInTheDocument();
  });

  // N6 lock — load-bearing deep-link affordance. CommittedPipelineCard
  // intentionally has NO in-page editing; operators are routed to the
  // canonical /settings/pipelines/[id] detail view via this Link.
  it("renders deep-link to /settings/pipelines/{id} with aria-label", () => {
    const pipeline = pipelineFixture({
      id: "pipeline-abc-123",
      name: "Re-engagement Pipeline",
    });
    const snapshot = actionPlanFixture().pipelines[0];
    render(
      <CommittedPipelineCard
        pipeline={pipeline}
        snapshot={snapshot}
        index={0}
        goalType="units"
      />,
    );
    const link = screen.getByRole("link", {
      name: /Edit pipeline Re-engagement Pipeline/i,
    });
    expect(link).toHaveAttribute("href", "/settings/pipelines/pipeline-abc-123");
  });

  it("renders strategy badge from snapshot slice", () => {
    const pipeline = pipelineFixture();
    const snapshot = actionPlanFixture({
      pipelines: [
        {
          ...actionPlanFixture().pipelines[0],
          strategy: "trust_build",
        },
      ],
    }).pipelines[0];
    render(
      <CommittedPipelineCard
        pipeline={pipeline}
        snapshot={snapshot}
        index={0}
        goalType="units"
      />,
    );
    expect(screen.getByText(/Trust Building/i)).toBeInTheDocument();
  });

  it("renders audience-count + projectedContribution summary from snapshot", () => {
    const pipeline = pipelineFixture();
    const snapshot = actionPlanFixture().pipelines[0]; // 300 contacts, 15 projected
    render(
      <CommittedPipelineCard
        pipeline={pipeline}
        snapshot={snapshot}
        index={0}
        goalType="units"
      />,
    );
    expect(screen.getByText(/300 contacts/)).toBeInTheDocument();
    expect(screen.getByText(/15 units projected/)).toBeInTheDocument();
  });

  it("surfaces Initial badge on first stage and Terminal badge on terminal stage", () => {
    const pipeline = pipelineFixture();
    const snapshot = actionPlanFixture().pipelines[0];
    render(
      <CommittedPipelineCard
        pipeline={pipeline}
        snapshot={snapshot}
        index={0}
        goalType="units"
      />,
    );
    expect(screen.getByText(/^Initial$/)).toBeInTheDocument();
    expect(screen.getByText(/^Terminal$/)).toBeInTheDocument();
  });

  it("snapshot=undefined: omits strategy badge + summary; still renders link + stages", () => {
    const pipeline = pipelineFixture();
    render(
      <CommittedPipelineCard
        pipeline={pipeline}
        snapshot={undefined}
        index={0}
        goalType="units"
      />,
    );
    expect(screen.queryByText(/Direct Conversion/i)).toBeNull();
    expect(
      screen.getByRole("link", { name: /Edit pipeline Inbound Lead Pipeline/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Outreach")).toBeInTheDocument();
  });
});
