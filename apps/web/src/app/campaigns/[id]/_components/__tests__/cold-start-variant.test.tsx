/**
 * KAN-1166 PR 3-tests — Cold-start variant coverage.
 *
 * Scope (Q-ADD T2 — doctrine area: cold-start render + acquisition CTA
 * dataType mappings):
 *   - ColdStartCounselCard renders message + missingDataTypes chip strip
 *   - AcquisitionCTA mapping per RequiredDataType (Q-ADD I3 lock):
 *       sales_history     → Upload CSV / Connect Shopify
 *       customer_base     → Sync CRM / Upload CSV
 *       lead_history      → Connect Meta / Upload leads
 *       engagement_history → Connect provider / Activate Campaign (swap applied)
 *   - expectedUnlock italic copy from analyzer renders
 *
 * Engagement_history swap verification is doctrine-critical: the Phase 1
 * engagement_history empirical fix landed primary "Connect email/SMS
 * provider" and secondary "Activate an existing Campaign" — this test
 * guards against future regression to the recursive new-Campaign loop.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ColdStartCounselCard } from "../ColdStartCounselCard";
import { AcquisitionCTA } from "../AcquisitionCTA";
import { coldStartCounselFixture } from "./fixtures";

describe("KAN-1166 PR 3-tests — cold-start variant", () => {
  it("ColdStartCounselCard renders message paragraph", () => {
    render(<ColdStartCounselCard counsel={coldStartCounselFixture()} />);
    expect(
      screen.getByText(/We need data to give you confident feasibility counsel/i),
    ).toBeInTheDocument();
  });

  it("ColdStartCounselCard renders missing-data chip strip for each missing type", () => {
    render(<ColdStartCounselCard counsel={coldStartCounselFixture()} />);
    expect(screen.getByText("Sales history")).toBeInTheDocument();
    expect(screen.getByText("Customer base")).toBeInTheDocument();
    expect(screen.getByText("Lead history")).toBeInTheDocument();
    expect(screen.getByText("Engagement history")).toBeInTheDocument();
  });

  it("AcquisitionCTA sales_history — primary upload + secondary integrations", () => {
    render(
      <AcquisitionCTA
        recommendation={{
          dataType: "sales_history",
          operatorActions: [],
          expectedUnlock: "Unlocks revenue counsel.",
        }}
      />,
    );
    expect(screen.getByText("Add your sales history")).toBeInTheDocument();
    const primary = screen.getByRole("link", {
      name: /Upload past 12 mo orders/i,
    });
    expect(primary).toHaveAttribute("href", "/imports?type=orders");
    const secondary = screen.getByRole("link", {
      name: /Connect Shopify \/ Stripe/i,
    });
    expect(secondary).toHaveAttribute("href", "/settings/integrations");
    expect(screen.getByText("Unlocks revenue counsel.")).toBeInTheDocument();
  });

  it("AcquisitionCTA customer_base — primary CRM sync + secondary CSV upload", () => {
    render(
      <AcquisitionCTA
        recommendation={{
          dataType: "customer_base",
          operatorActions: [],
          expectedUnlock: "Unlocks upsell counsel.",
        }}
      />,
    );
    expect(screen.getByText("Sync your customer list")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Sync HubSpot \/ Pipedrive/i }),
    ).toHaveAttribute("href", "/settings/integrations");
    expect(
      screen.getByRole("link", { name: /Upload customer CSV/i }),
    ).toHaveAttribute("href", "/imports?type=contacts&lifecycle=customer");
  });

  it("AcquisitionCTA lead_history — primary Meta Lead Ads + secondary CSV", () => {
    render(
      <AcquisitionCTA
        recommendation={{
          dataType: "lead_history",
          operatorActions: [],
          expectedUnlock: "Unlocks conversion projection counsel.",
        }}
      />,
    );
    expect(screen.getByText("Connect lead-gen sources")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Connect Meta Lead Ads/i }),
    ).toHaveAttribute("href", "/settings/integrations");
    expect(
      screen.getByRole("link", { name: /Upload historical leads/i }),
    ).toHaveAttribute("href", "/imports?type=contacts&lifecycle=lead");
  });

  it("AcquisitionCTA engagement_history — primary email/SMS + secondary existing Campaign (recursive-loop swap)", () => {
    render(
      <AcquisitionCTA
        recommendation={{
          dataType: "engagement_history",
          operatorActions: [],
          expectedUnlock: "Unlocks re-engagement counsel.",
        }}
      />,
    );
    expect(screen.getByText("Capture engagement")).toBeInTheDocument();

    // Primary CTA: the empirical swap from "Ship your first Campaign" to
    // "Connect email/SMS provider" — guards against recursive-loop regression.
    const primary = screen.getByRole("link", {
      name: /Connect email\/SMS provider/i,
    });
    expect(primary).toHaveAttribute("href", "/settings/integrations");

    // Secondary CTA: "Activate an existing Campaign" — avoids the
    // new-Campaign-from-Campaign-context UX trap.
    const secondary = screen.getByRole("link", {
      name: /Activate an existing Campaign/i,
    });
    expect(secondary).toHaveAttribute("href", "/campaigns");

    // Negative guard against recursive-loop regression:
    expect(
      screen.queryByText(/Ship your first Campaign/i),
    ).not.toBeInTheDocument();
  });
});
