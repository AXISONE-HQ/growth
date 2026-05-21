/**
 * KAN-968 — DealCard render tests.
 *
 * Coverage:
 *   - Contact + company + value all surface as text
 *   - AI line renders when latestDecision is present (action + confidence%)
 *   - AI line is OMITTED entirely when latestDecision is null (no fabrication)
 *   - Confidence-badge data-confidence-level attribute reflects the bucket
 *   - Stage age renders "in {stageName} · {age}"
 *   - Card is a Link to /opportunities/[id]
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DealCard } from "../deal-card";
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

function makeDeal(overrides: Partial<BoardDealCard> = {}): BoardDealCard {
  return {
    id: "deal_a",
    name: "Acme deal",
    value: "1234.56",
    currency: "USD",
    currentStageId: "stg_new",
    enteredStageAt: "2026-05-21T16:00:00Z", // 2h before NOW
    contact: { firstName: "Dana", lastName: "RoutingFlip" },
    company: { name: "RoutingFlip Demo Co" },
    status: "open",
    probability: null,
    latestDecision: { actionType: "send_follow_up", confidence: 0.82 },
    ...overrides,
  };
}

describe("KAN-968 — DealCard with full decision context", () => {
  it("renders contact + company + value + AI line + confidence + age", () => {
    render(<DealCard deal={makeDeal()} stageName="New" now={NOW} />);
    expect(screen.getByText("Dana RoutingFlip")).toBeInTheDocument();
    expect(screen.getByText("RoutingFlip Demo Co")).toBeInTheDocument();
    expect(screen.getByText(/\$1,234\.56/)).toBeInTheDocument();
    expect(screen.getByText(/AI: Sending follow-up/i)).toBeInTheDocument();
    expect(screen.getByText("82%")).toBeInTheDocument();
    expect(screen.getByText(/in New · 2h/)).toBeInTheDocument();
  });

  it("confidence badge carries data-confidence-level for visual-system test hooks", () => {
    render(<DealCard deal={makeDeal()} stageName="New" now={NOW} />);
    const badge = screen.getByTestId("confidence-badge");
    expect(badge).toHaveAttribute("data-confidence-level", "good");
  });

  it("card is a link to /opportunities/[id]", () => {
    render(<DealCard deal={makeDeal()} stageName="New" now={NOW} />);
    const link = screen.getByRole("article");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/opportunities/deal_a");
  });
});

describe("KAN-968 — DealCard omits AI line when latestDecision is null", () => {
  it("no 'AI:' prefix renders when decision absent (no fabrication)", () => {
    render(
      <DealCard
        deal={makeDeal({ latestDecision: null })}
        stageName="New"
        now={NOW}
      />,
    );
    expect(screen.queryByText(/^AI:/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("confidence-badge")).not.toBeInTheDocument();
    // Contact + value + age still render
    expect(screen.getByText("Dana RoutingFlip")).toBeInTheDocument();
    expect(screen.getByText(/in New · 2h/)).toBeInTheDocument();
  });
});

describe("KAN-968 — DealCard handles missing company gracefully", () => {
  it("omits company line when company is null", () => {
    render(
      <DealCard
        deal={makeDeal({ company: null })}
        stageName="New"
        now={NOW}
      />,
    );
    expect(screen.queryByText("RoutingFlip Demo Co")).not.toBeInTheDocument();
    // Contact still primary
    expect(screen.getByText("Dana RoutingFlip")).toBeInTheDocument();
  });
});

describe("KAN-968 — DealCard confidence-level coverage (4 buckets)", () => {
  it("high tier renders when confidence ≥ 0.85", () => {
    render(
      <DealCard
        deal={makeDeal({
          latestDecision: { actionType: "no_action", confidence: 0.92 },
        })}
        stageName="New"
        now={NOW}
      />,
    );
    expect(screen.getByTestId("confidence-badge")).toHaveAttribute(
      "data-confidence-level",
      "high",
    );
    expect(screen.getByText("92%")).toBeInTheDocument();
  });
  it("uncertain tier renders for 0.40–0.64", () => {
    render(
      <DealCard
        deal={makeDeal({
          latestDecision: { actionType: "wait_for_response", confidence: 0.5 },
        })}
        stageName="New"
        now={NOW}
      />,
    );
    expect(screen.getByTestId("confidence-badge")).toHaveAttribute(
      "data-confidence-level",
      "uncertain",
    );
  });
  it("low tier renders below 0.40", () => {
    render(
      <DealCard
        deal={makeDeal({
          latestDecision: { actionType: "no_action", confidence: 0.2 },
        })}
        stageName="New"
        now={NOW}
      />,
    );
    expect(screen.getByTestId("confidence-badge")).toHaveAttribute(
      "data-confidence-level",
      "low",
    );
  });
});
