/**
 * KAN-884 — MoneyDisplay tests.
 *
 * Coverage:
 *   - Accepts Decimal-as-JSON-string (Prisma's default) AND raw number
 *   - Formats with Intl.NumberFormat using the row's currency code
 *   - Falls back to USD when currency is null/missing
 *   - Renders em-dash for null/unparseable input (no NaN leak)
 *   - showCurrency=false renders just the number with 2dp
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MoneyDisplay } from "../money-display";

describe("KAN-884 — MoneyDisplay", () => {
  it("renders Decimal-as-JSON-string with USD formatting by default", () => {
    const { container } = render(<MoneyDisplay value="1234.56" />);
    expect(container).toHaveTextContent("$1,234.56");
  });

  it("renders raw number with the row's currency", () => {
    const { container } = render(<MoneyDisplay value={99.5} currency="CAD" />);
    // en-US locale renders CAD as "CA$" or "CAD" depending on browser/Node;
    // assert on the formatted amount instead of the symbol exact form.
    expect(container.textContent).toMatch(/99\.50/);
    expect(container.textContent).toMatch(/CA?\$?|CAD/);
  });

  it("falls back to USD when currency is null", () => {
    const { container } = render(<MoneyDisplay value="100" currency={null} />);
    expect(container).toHaveTextContent("$100.00");
  });

  it("renders em-dash for null value (no NaN leak)", () => {
    const { container } = render(<MoneyDisplay value={null} />);
    expect(container).toHaveTextContent("—");
  });

  it("renders em-dash for undefined value", () => {
    const { container } = render(<MoneyDisplay value={undefined} />);
    expect(container).toHaveTextContent("—");
  });

  it("renders em-dash for unparseable string", () => {
    const { container } = render(<MoneyDisplay value="not-a-number" />);
    expect(container).toHaveTextContent("—");
  });

  it("showCurrency=false renders just the number with 2dp", () => {
    const { container } = render(
      <MoneyDisplay value="1234.5" showCurrency={false} />,
    );
    // No $ sign; just "1,234.50"
    expect(container.textContent).not.toContain("$");
    expect(container).toHaveTextContent("1,234.50");
  });

  it("always renders 2 decimal places (Decimal(12,2) convention)", () => {
    const { container: c1 } = render(<MoneyDisplay value="100" />);
    expect(c1).toHaveTextContent("$100.00");

    const { container: c2 } = render(<MoneyDisplay value="0.1" />);
    expect(c2).toHaveTextContent("$0.10");
  });
});
