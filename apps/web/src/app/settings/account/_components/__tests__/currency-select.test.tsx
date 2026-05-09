/**
 * KAN-859 — CurrencySelect unit tests.
 *
 * Native `<select>` + `<optgroup>` per Fred Decision 4. Display label
 * format `"USD — US Dollar ($)"`.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { CurrencySelect } from "../currency-select";

describe("CurrencySelect — KAN-859", () => {
  it("renders a native select with the current value", () => {
    render(
      <CurrencySelect id="default-currency" value="USD" onChange={() => undefined} />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("USD");
  });

  it("renders 4 optgroups (Americas / Europe / Asia-Pacific / Middle East & Africa)", () => {
    render(
      <CurrencySelect id="default-currency" value="USD" onChange={() => undefined} />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const groups = select.querySelectorAll("optgroup");
    expect(groups.length).toBe(4);
    const labels = Array.from(groups).map((g) => g.getAttribute("label"));
    expect(labels).toEqual([
      "Americas",
      "Europe",
      "Asia-Pacific",
      "Middle East & Africa",
    ]);
  });

  it("includes major currencies in the option list", () => {
    render(
      <CurrencySelect id="default-currency" value="USD" onChange={() => undefined} />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const optionValues = Array.from(select.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    for (const code of ["USD", "EUR", "GBP", "CAD", "JPY", "AUD"]) {
      expect(optionValues).toContain(code);
    }
  });

  it("uses the spec'd label format `\"USD — US Dollar ($)\"`", () => {
    render(
      <CurrencySelect id="default-currency" value="USD" onChange={() => undefined} />,
    );
    expect(screen.getByText("USD — US Dollar ($)")).toBeInTheDocument();
  });

  it("propagates user change via onChange", () => {
    const onChange = vi.fn();
    render(
      <CurrencySelect id="default-currency" value="USD" onChange={onChange} />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "EUR" } });
    expect(onChange).toHaveBeenCalledWith("EUR");
  });
});
