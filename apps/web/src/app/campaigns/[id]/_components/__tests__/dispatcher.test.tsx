/**
 * KAN-1166 PR 3-tests — Variant dispatcher coverage.
 *
 * Scope (Q-ADD T8): three sub-tests prove FeasibilityCounselCard routes
 * correctly per `counsel.kind`. The dispatcher is pure switch logic — no
 * stateful behavior across kinds — so 3 render assertions cover its full
 * contract.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FeasibilityCounselCard } from "../FeasibilityCounselCard";
import {
  counselResultColdStart,
  counselResultFeasibility,
  counselResultUnavailable,
} from "./fixtures";

describe("KAN-1166 PR 3-tests — FeasibilityCounselCard dispatcher", () => {
  it("kind='cold_start_counsel' → renders ColdStartCounselCard", () => {
    render(
      <FeasibilityCounselCard
        counsel={counselResultColdStart()}
        goalTarget={50}
        campaignId="camp-1"
        onRetry={() => {}}
        onReAnalyze={() => {}}
      />,
    );
    // ColdStart-specific text from the fixture
    expect(
      screen.getByText(/We need data to give you confident feasibility counsel/i),
    ).toBeInTheDocument();
    // Detail-card-specific surfaces should NOT be present
    expect(screen.queryByText("stretch")).not.toBeInTheDocument();
    expect(screen.queryByText("Organic projection")).not.toBeInTheDocument();
  });

  it("kind='feasibility_counsel' → renders FeasibilityCounselDetailCard", () => {
    render(
      <FeasibilityCounselCard
        counsel={counselResultFeasibility()}
        goalTarget={50}
        campaignId="camp-1"
        onRetry={() => {}}
        onReAnalyze={() => {}}
      />,
    );
    expect(screen.getByText("stretch")).toBeInTheDocument();
    expect(screen.getByText("Organic projection")).toBeInTheDocument();
    expect(screen.getByText("Increase Lead Volume")).toBeInTheDocument();
    // ColdStart-specific text should NOT be present
    expect(
      screen.queryByText(/We need data to give you confident/i),
    ).not.toBeInTheDocument();
  });

  it("kind='analyzer_unavailable' → renders AnalyzerUnavailableCard with retry", () => {
    render(
      <FeasibilityCounselCard
        counsel={counselResultUnavailable("LLM transient post-retry-exhaustion")}
        goalTarget={50}
        campaignId="camp-1"
        onRetry={() => {}}
        onReAnalyze={() => {}}
      />,
    );
    expect(
      screen.getByText("LLM transient post-retry-exhaustion"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });
});
