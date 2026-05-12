/**
 * KAN-884 — StatusBadge tests.
 *
 * Coverage:
 *   - Each kind renders the correct human label from enum-labels.ts
 *   - Tone class (color) is applied per kind+value
 *   - Unknown values fall back to grey tone + raw label
 *   - null value renders em-dash + grey tone
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../status-badge";

describe("KAN-884 — StatusBadge label resolution", () => {
  it("order-status — paid → 'Paid'", () => {
    render(<StatusBadge kind="order-status" value="paid" />);
    expect(screen.getByText("Paid")).toBeInTheDocument();
  });

  it("order-status — partially_refunded → 'Partial refund' (not the raw enum)", () => {
    render(<StatusBadge kind="order-status" value="partially_refunded" />);
    expect(screen.getByText("Partial refund")).toBeInTheDocument();
  });

  it("deal-status — won → 'Won'", () => {
    render(<StatusBadge kind="deal-status" value="won" />);
    expect(screen.getByText("Won")).toBeInTheDocument();
  });

  it("company-lifecycle — prospect → 'Prospect'", () => {
    render(<StatusBadge kind="company-lifecycle" value="prospect" />);
    expect(screen.getByText("Prospect")).toBeInTheDocument();
  });

  it("contact-lifecycle — mql → 'MQL'", () => {
    render(<StatusBadge kind="contact-lifecycle" value="mql" />);
    expect(screen.getByText("MQL")).toBeInTheDocument();
  });
});

describe("KAN-884 — StatusBadge tone classes", () => {
  it("paid → green tone (emerald-50 background)", () => {
    const { container } = render(<StatusBadge kind="order-status" value="paid" />);
    expect(container.firstChild).toHaveClass("bg-emerald-50");
  });

  it("failed → red tone (red-50 background)", () => {
    const { container } = render(<StatusBadge kind="order-status" value="failed" />);
    expect(container.firstChild).toHaveClass("bg-red-50");
  });

  it("pending → blue tone (blue-50 background)", () => {
    const { container } = render(<StatusBadge kind="order-status" value="pending" />);
    expect(container.firstChild).toHaveClass("bg-blue-50");
  });

  it("partially_refunded → amber tone (not green or red — needs operator attention)", () => {
    const { container } = render(
      <StatusBadge kind="order-status" value="partially_refunded" />,
    );
    expect(container.firstChild).toHaveClass("bg-amber-50");
  });

  it("won → distinct emerald-100 (deeper than open's emerald-50)", () => {
    const { container } = render(<StatusBadge kind="deal-status" value="won" />);
    expect(container.firstChild).toHaveClass("bg-emerald-100");
  });
});

describe("KAN-884 — StatusBadge unknown + null handling", () => {
  it("unknown value falls back to raw string + grey tone", () => {
    const { container } = render(
      <StatusBadge kind="order-status" value="not_a_real_status" />,
    );
    expect(screen.getByText("not_a_real_status")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("bg-gray-100");
  });

  it("null value renders em-dash + grey tone (no crash)", () => {
    const { container } = render(<StatusBadge kind="order-status" value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("bg-gray-100");
  });
});
