/**
 * KAN-968 — StageColumn render tests.
 *
 * Coverage:
 *   - Stage header (name + total count combining cards + truncated)
 *   - Empty column shows muted "No deals in this stage." copy
 *   - Truncated overflow row renders when truncatedCount > 0
 *   - Terminal-stage accent applies for won/lost outcome types
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageColumn } from "../stage-column";
import type { BoardDealCard } from "@/lib/api";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const NOW = new Date("2026-05-21T18:00:00Z");

function makeDeal(id: string, overrides: Partial<BoardDealCard> = {}): BoardDealCard {
  return {
    id,
    name: `Deal ${id}`,
    value: "0",
    currency: "USD",
    currentStageId: "stg_new",
    enteredStageAt: "2026-05-21T17:00:00Z",
    contact: { firstName: "Test", lastName: id },
    company: null,
    status: "open",
    probability: null,
    latestDecision: null,
    ...overrides,
  };
}

const STAGE = {
  id: "stg_new",
  name: "New",
  isInitial: true,
  isTerminal: false,
};

describe("KAN-968 — StageColumn header + count", () => {
  it("renders the stage name", () => {
    render(
      <StageColumn
        stage={STAGE}
        outcomeType="open"
        deals={[makeDeal("a")]}
        truncatedCount={0}
        now={NOW}
      />,
    );
    expect(screen.getByRole("heading", { name: "New" })).toBeInTheDocument();
  });

  it("count badge sums visible cards + truncatedCount (section aria-label is contextualized with stage name)", () => {
    render(
      <StageColumn
        stage={STAGE}
        outcomeType="open"
        deals={[makeDeal("a"), makeDeal("b")]}
        truncatedCount={48}
        now={NOW}
      />,
    );
    // Section label includes stage name so it's unambiguous; the inline
    // count span carries the same number for sighted users.
    expect(screen.getByRole("region", { name: /New — 50 deals/ })).toBeInTheDocument();
  });

  it("uses singular 'deal' in the section label when total === 1", () => {
    render(
      <StageColumn
        stage={STAGE}
        outcomeType="open"
        deals={[makeDeal("a")]}
        truncatedCount={0}
        now={NOW}
      />,
    );
    expect(screen.getByRole("region", { name: /New — 1 deal$/ })).toBeInTheDocument();
  });
});

describe("KAN-968 — StageColumn empty-column state", () => {
  it("renders 'No deals in this stage.' when zero cards + no overflow", () => {
    render(
      <StageColumn
        stage={STAGE}
        outcomeType="open"
        deals={[]}
        truncatedCount={0}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("empty-stage-message")).toHaveTextContent(
      "No deals in this stage.",
    );
  });
});

describe("KAN-968 — StageColumn truncatedCount overflow", () => {
  it("renders '+25 more in this stage' when 50 cards shown + 25 truncated", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => makeDeal(`d${i}`));
    render(
      <StageColumn
        stage={STAGE}
        outcomeType="open"
        deals={fifty}
        truncatedCount={25}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("truncated-count-row")).toHaveTextContent(
      "+25 more in this stage",
    );
  });

  it("does NOT render the overflow row when truncatedCount === 0", () => {
    render(
      <StageColumn
        stage={STAGE}
        outcomeType="open"
        deals={[makeDeal("a")]}
        truncatedCount={0}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId("truncated-count-row")).not.toBeInTheDocument();
  });
});

describe("KAN-968 — terminal-stage accent treatment (KAN-987 Phase C.3b)", () => {
  // C.3b — tests now assert on the header's data-accent attribute (won /
  // lost / open) rather than the underlying class string. The class
  // migrated dark→light (border-emerald-500/50 → border-[var(--ds-emerald-500)])
  // but the semantic is the same. Data-attribute is the contract;
  // class is the rendering of that contract.
  it("terminal_won → header carries data-accent='won' with emerald left-border", () => {
    const { container } = render(
      <StageColumn
        stage={{ id: "stg_won", name: "Demo Held", isInitial: false, isTerminal: true }}
        outcomeType="terminal_won"
        deals={[]}
        truncatedCount={0}
        now={NOW}
      />,
    );
    const header = container.querySelector('[data-accent="won"]');
    expect(header).toBeInTheDocument();
    expect(header?.className).toMatch(/ds-emerald-500/);
  });

  it("terminal_lost → header carries data-accent='lost' with danger left-border", () => {
    const { container } = render(
      <StageColumn
        stage={{ id: "stg_lost", name: "No-show", isInitial: false, isTerminal: true }}
        outcomeType="terminal_lost"
        deals={[]}
        truncatedCount={0}
        now={NOW}
      />,
    );
    const header = container.querySelector('[data-accent="lost"]');
    expect(header).toBeInTheDocument();
    expect(header?.className).toMatch(/ds-danger/);
  });

  it("open → header carries data-accent='open' with no accent class (no semantic noise on regular stages)", () => {
    const { container } = render(
      <StageColumn
        stage={STAGE}
        outcomeType="open"
        deals={[]}
        truncatedCount={0}
        now={NOW}
      />,
    );
    const header = container.querySelector('[data-accent="open"]');
    expect(header).toBeInTheDocument();
    expect(header?.className).not.toMatch(/ds-emerald-500/);
    expect(header?.className).not.toMatch(/ds-danger/);
  });
});
