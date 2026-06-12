/**
 * KAN-1166 PR 3-tests — Shell component coverage.
 *
 * Scope (Q-ADD T2 — doctrine area: inherited shells from PR 3-core-shell):
 *   - ChatThread renders OperatorMessage + AIMessage in order
 *   - LoadingState renders when isAnalyzing && !feasibility (Q-ADD T7)
 *   - AnalyzerUnavailableCard renders verbatim message + Retry CTA
 *   - Retry click fires onRetry (user-event interaction)
 *   - EmptyState renders "Set the goal" CTA
 *
 * Prop-level fixtures only (Q-ADD T3 lock); no useCampaignChat mocks.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatThread } from "../ChatThread";
import { EmptyState } from "../EmptyState";
import { AnalyzerUnavailableCard } from "../AnalyzerUnavailableCard";
import { counselResultFeasibility } from "./fixtures";

describe("KAN-1166 PR 3-tests — shell components", () => {
  it("ChatThread renders OperatorMessage + AIMessage when feasibility is present", () => {
    render(
      <ChatThread
        goalDescription="Sell 50 of ABC by March 31"
        goalTarget={50}
        campaignId="camp-1"
        feasibility={counselResultFeasibility()}
        isAnalyzing={false}
        analyzeError={null}
        onRetry={() => {}}
      />,
    );
    expect(
      screen.getByText("Sell 50 of ABC by March 31"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Based on your 8% conversion rate/i),
    ).toBeInTheDocument();
  });

  it("ChatThread shows LoadingState when isAnalyzing && !feasibility", () => {
    render(
      <ChatThread
        goalDescription="Sell 50 of ABC by March 31"
        goalTarget={50}
        campaignId="camp-1"
        feasibility={null}
        isAnalyzing={true}
        analyzeError={null}
        onRetry={() => {}}
      />,
    );
    expect(
      screen.getByText("Reading your historical signal…"),
    ).toBeInTheDocument();
  });

  it("ChatThread shows AnalyzerUnavailableCard when analyzeError && !feasibility", () => {
    render(
      <ChatThread
        goalDescription="Sell 50 of ABC by March 31"
        goalTarget={50}
        campaignId="camp-1"
        feasibility={null}
        isAnalyzing={false}
        analyzeError={new Error("network timeout")}
        onRetry={() => {}}
      />,
    );
    expect(
      screen.getByText(/Couldn't reach the analyzer.*network timeout/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("AnalyzerUnavailableCard fires onRetry when Retry button is clicked", async () => {
    const onRetry = vi.fn();
    render(
      <AnalyzerUnavailableCard message="LLM transient" onRetry={onRetry} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("EmptyState renders 'Set the goal' CTA linking to the goal flow", () => {
    render(<EmptyState campaignId="camp-1" />);
    expect(screen.getByText(/Tell us your goal/i)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /set the goal/i });
    expect(cta).toHaveAttribute("href", "/campaigns/camp-1/goal");
  });
});
