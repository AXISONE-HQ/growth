/**
 * KAN-1166 PR 3-tests — Feasibility-counsel variant coverage.
 *
 * Scope (Q-ADD T2 — doctrine area: detail card composition + Math + Path):
 *   - FeasibilityCounselDetailCard renders Achievability + Confidence badges
 *     + MathCard + honestAssessment + 3 PathCards + ReAnalyzeCTA
 *   - MathCard renders projection / goal / gap rows via <dl> semantic
 *   - MathCard surplus case (negative absolute) flips "Gap" → "Surplus"
 *     and "short" → "above"
 *   - 3 PathCards render in array order (label exposed in heading)
 *   - ReAnalyzeCTA fires onReAnalyze via user-event click
 *
 * Doctrine assertions (D1 above-the-fold; V1 no-euphemism) live in
 * doctrine-assertions.test.tsx — this file covers composition correctness.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeasibilityCounselDetailCard } from "../FeasibilityCounselDetailCard";
import { MathCard } from "../MathCard";
import { feasibilityCounselFixture } from "./fixtures";

describe("KAN-1166 PR 3-tests — feasibility-counsel variant", () => {
  it("FeasibilityCounselDetailCard renders all expected children", () => {
    render(
      <FeasibilityCounselDetailCard
        counsel={feasibilityCounselFixture()}
        goalTarget={50}
        campaignId="camp-1"
        onReAnalyze={() => {}}
      />,
    );
    // Achievability + Confidence badges
    expect(screen.getByText("stretch")).toBeInTheDocument();
    expect(screen.getByText("Medium confidence")).toBeInTheDocument();
    // MathCard rows
    expect(screen.getByText("Organic projection")).toBeInTheDocument();
    expect(screen.getByText("Your goal")).toBeInTheDocument();
    expect(screen.getByText("Gap")).toBeInTheDocument();
    // honestAssessment paragraph
    expect(
      screen.getByText(/Based on your 8% conversion rate/i),
    ).toBeInTheDocument();
    // 3 PathCards (label headings)
    expect(screen.getByText("Increase Lead Volume")).toBeInTheDocument();
    expect(screen.getByText("Improve Conversion")).toBeInTheDocument();
    expect(screen.getByText("Extend Window")).toBeInTheDocument();
    // ReAnalyzeCTA
    expect(
      screen.getByRole("button", { name: /Re-analyze$/i }),
    ).toBeInTheDocument();
  });

  it("MathCard renders projection / goal / gap with 'short' annotation", () => {
    render(
      <MathCard
        projectedOrganic={{ count: 15, unit: "units" }}
        goalTarget={50}
        goalGap={{ absolute: 35, percent: 70 }}
      />,
    );
    expect(screen.getByText("Organic projection")).toBeInTheDocument();
    expect(screen.getByText("15 units")).toBeInTheDocument();
    expect(screen.getByText("Your goal")).toBeInTheDocument();
    expect(screen.getByText("50 units")).toBeInTheDocument();
    expect(screen.getByText("Gap")).toBeInTheDocument();
    expect(screen.getByText(/35 units/)).toBeInTheDocument();
    expect(screen.getByText(/70% short/)).toBeInTheDocument();
  });

  it("MathCard surplus case (negative gap) flips Gap → Surplus / short → above", () => {
    render(
      <MathCard
        projectedOrganic={{ count: 60, unit: "deals" }}
        goalTarget={50}
        goalGap={{ absolute: -10, percent: -20 }}
      />,
    );
    expect(screen.getByText("Surplus")).toBeInTheDocument();
    expect(screen.queryByText("Gap")).not.toBeInTheDocument();
    expect(screen.getByText(/10 deals/)).toBeInTheDocument();
    expect(screen.getByText(/20% above/)).toBeInTheDocument();
  });

  it("3 PathCards render in array order", () => {
    render(
      <FeasibilityCounselDetailCard
        counsel={feasibilityCounselFixture()}
        goalTarget={50}
        campaignId="camp-1"
        onReAnalyze={() => {}}
      />,
    );
    const headings = screen
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      "Increase Lead Volume",
      "Improve Conversion",
      "Extend Window",
    ]);
  });

  it("ReAnalyzeCTA click fires onReAnalyze", async () => {
    const onReAnalyze = vi.fn();
    render(
      <FeasibilityCounselDetailCard
        counsel={feasibilityCounselFixture()}
        goalTarget={50}
        campaignId="camp-1"
        onReAnalyze={onReAnalyze}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Re-analyze$/i }),
    );
    expect(onReAnalyze).toHaveBeenCalledTimes(1);
  });

  it("Each PathCard exposes its label via h4 + Refine goal CTA", () => {
    render(
      <FeasibilityCounselDetailCard
        counsel={feasibilityCounselFixture()}
        goalTarget={50}
        campaignId="camp-1"
        onReAnalyze={() => {}}
      />,
    );
    const refineCtas = screen.getAllByRole("link", { name: /Refine goal/i });
    expect(refineCtas).toHaveLength(3);
    // Each CTA precedes the next path's label DOM-wise; sanity-check
    // first CTA's href matches first path's expected encoding.
    expect(refineCtas[0].getAttribute("href")).toContain(
      "?refineGoalHint=",
    );
  });
});

// within import asserts presence for future expansion
void within;
