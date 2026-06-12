/**
 * KAN-1166 PR 3-tests — Doctrine assertion coverage.
 *
 * The two non-negotiable doctrine locks from the brief, made test-enforced
 * here so future drift is CI-visible:
 *
 *   D1 — HONEST VISIBILITY ABOVE-THE-FOLD
 *        Achievability + Confidence + MathCard render BEFORE honestAssessment
 *        and BEFORE the achievable-paths grid within FeasibilityCounselDetailCard.
 *        Asserted via the data-doctrine-anchor="counsel-detail-fold" attribute
 *        (Q-ADD T4 refinement) — single structural hook, no scattered testids.
 *
 *   V1 — NO-EUPHEMISM ACHIEVABILITY LABELS
 *        feasible / stretch / unrealistic render verbatim — no softening
 *        substitutions like "Challenging" or "Aspirational" that would
 *        contradict the AI honest counsel doctrine. Positive assertions PLUS
 *        defensive negative assertions against the two highest-risk drift
 *        candidates (Q-ADD T5).
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AchievabilityBadge } from "../AchievabilityBadge";
import { FeasibilityCounselDetailCard } from "../FeasibilityCounselDetailCard";
import { ALL_VERDICTS, feasibilityCounselFixture } from "./fixtures";

describe("KAN-1166 PR 3-tests — D1 above-the-fold doctrine", () => {
  it("FeasibilityCounselDetailCard exposes data-doctrine-anchor='counsel-detail-fold'", () => {
    const { container } = render(
      <FeasibilityCounselDetailCard
        counsel={feasibilityCounselFixture()}
        goalTarget={50}
        campaignId="camp-1"
        onReAnalyze={() => {}}
      />,
    );
    const anchor = container.querySelector(
      '[data-doctrine-anchor="counsel-detail-fold"]',
    );
    expect(anchor).not.toBeNull();
  });

  it("DOM order: badge cluster → MathCard <dl> → honestAssessment <p> → PathCards", () => {
    const { container } = render(
      <FeasibilityCounselDetailCard
        counsel={feasibilityCounselFixture()}
        goalTarget={50}
        campaignId="camp-1"
        onReAnalyze={() => {}}
      />,
    );
    const anchor = container.querySelector(
      '[data-doctrine-anchor="counsel-detail-fold"]',
    );
    expect(anchor).not.toBeNull();
    const children = Array.from(anchor!.children) as HTMLElement[];

    // children[0] = badge cluster (a div wrapping Achievability + Confidence badges)
    expect(children[0].textContent).toMatch(/stretch/i);
    expect(children[0].textContent).toMatch(/Medium confidence/i);

    // children[1] = MathCard rendered as <dl>
    expect(children[1].tagName).toBe("DL");

    // children[2] = honestAssessment paragraph
    expect(children[2].tagName).toBe("P");
    expect(children[2].textContent).toMatch(/Based on your 8% conversion rate/i);

    // children[3] = PathCards container (paths render BELOW the fold per V4)
    expect(children[3].textContent).toMatch(/Increase Lead Volume/i);

    // children[4] = ReAnalyzeCTA wrapper (bottom-right of card per I1)
    expect(children[4].textContent).toMatch(/Re-analyze/i);
  });
});

describe("KAN-1166 PR 3-tests — V1 no-euphemism doctrine", () => {
  for (const verdict of ALL_VERDICTS) {
    it(`AchievabilityBadge renders "${verdict}" verbatim (no euphemism replacement)`, () => {
      render(<AchievabilityBadge verdict={verdict} />);
      expect(screen.getByText(verdict)).toBeInTheDocument();
    });
  }

  it("negative guard — 'Challenging' substitution would surface here if drift introduced", () => {
    render(<AchievabilityBadge verdict="unrealistic" />);
    expect(screen.queryByText(/challenging/i)).not.toBeInTheDocument();
  });

  it("negative guard — 'Aspirational' substitution would surface here if drift introduced", () => {
    render(<AchievabilityBadge verdict="unrealistic" />);
    expect(screen.queryByText(/aspirational/i)).not.toBeInTheDocument();
  });

  it("negative guard — 'Ambitious' substitution would surface here if drift introduced", () => {
    render(<AchievabilityBadge verdict="stretch" />);
    expect(screen.queryByText(/ambitious/i)).not.toBeInTheDocument();
  });
});
