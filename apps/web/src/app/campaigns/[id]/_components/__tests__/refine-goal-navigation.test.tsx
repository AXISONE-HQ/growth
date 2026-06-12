/**
 * KAN-1166 PR 3-tests — Refine-goal URL param encoding coverage.
 *
 * Scope (Q-ADD T6 lock): DOM-based assertion on the rendered <a> href.
 * No `next/navigation` mock — the brief locks the URL shape, not the
 * navigation event. Decoded round-trip equality proves encoding correctness.
 *
 * Per Q-ADD I2 + Decision 4 refinement: the URL param shape is
 * `?refineGoalHint=<encoded "label: requiredAction">` — single param, all
 * payload in one encoded string.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PathCard } from "../PathCard";
import type { AchievablePath } from "@growth/shared";

function pathFixture(overrides: Partial<AchievablePath> = {}): AchievablePath {
  return {
    label: "Increase Lead Volume",
    description: "Bring more qualified leads.",
    requiredAction: "Increase weekly acquisition from 5 to 12 leads.",
    estimatedImpact: "Closes 60% of the gap.",
    ...overrides,
  };
}

function getRefineGoalHint(href: string | null): string | null {
  if (!href) return null;
  return new URL(href, "http://test").searchParams.get("refineGoalHint");
}

describe("KAN-1166 PR 3-tests — Refine-goal URL param encoding", () => {
  it("PathCard Refine-goal href targets /campaigns/<id>?refineGoalHint=...", () => {
    render(<PathCard path={pathFixture()} campaignId="camp-abc-123" />);
    const link = screen.getByRole("link", { name: /refine goal/i });
    const href = link.getAttribute("href");
    expect(href).toMatch(/^\/campaigns\/camp-abc-123\?refineGoalHint=/);
  });

  it("decoded round-trip equals '<label>: <requiredAction>'", () => {
    const path = pathFixture();
    render(<PathCard path={path} campaignId="camp-1" />);
    const link = screen.getByRole("link", { name: /refine goal/i });
    const decoded = getRefineGoalHint(link.getAttribute("href"));
    expect(decoded).toBe(`${path.label}: ${path.requiredAction}`);
  });

  it("special characters in label encode + round-trip cleanly (%, &, space)", () => {
    const path = pathFixture({
      label: "Cut Cycle 50% & Boost Margins",
      requiredAction: "Reduce time-to-close from 30 to 22 days.",
    });
    render(<PathCard path={path} campaignId="camp-1" />);
    const link = screen.getByRole("link", { name: /refine goal/i });
    const href = link.getAttribute("href");
    expect(href).toContain("%25"); // % encoded
    expect(href).toContain("%26"); // & encoded
    const decoded = getRefineGoalHint(href);
    expect(decoded).toBe(`${path.label}: ${path.requiredAction}`);
  });

  it("single-param shape: no other query params besides refineGoalHint", () => {
    render(<PathCard path={pathFixture()} campaignId="camp-1" />);
    const link = screen.getByRole("link", { name: /refine goal/i });
    const href = link.getAttribute("href")!;
    const params = new URL(href, "http://test").searchParams;
    expect(Array.from(params.keys())).toEqual(["refineGoalHint"]);
  });
});
