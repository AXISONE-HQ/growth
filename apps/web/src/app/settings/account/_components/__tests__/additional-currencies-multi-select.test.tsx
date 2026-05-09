/**
 * KAN-859 — AdditionalCurrenciesMultiSelect unit tests.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { AdditionalCurrenciesMultiSelect } from "../additional-currencies-multi-select";

describe("AdditionalCurrenciesMultiSelect — KAN-859", () => {
  it("auto-excludes the excludedCode (default currency) from the picker", () => {
    render(
      <AdditionalCurrenciesMultiSelect
        value={[]}
        excludedCode="USD"
        onChange={vi.fn()}
      />,
    );
    const usdCheckbox = document.getElementById("additional-currency-USD");
    expect(usdCheckbox).toBeNull();
    // EUR/GBP still visible
    expect(document.getElementById("additional-currency-EUR")).not.toBeNull();
  });

  it("renders the empty state placeholder when no additional currencies are selected", () => {
    render(
      <AdditionalCurrenciesMultiSelect
        value={[]}
        excludedCode="USD"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Add currencies you also accept.")).toBeInTheDocument();
  });

  it("hides the empty state placeholder when additional currencies are selected", () => {
    render(
      <AdditionalCurrenciesMultiSelect
        value={["EUR"]}
        excludedCode="USD"
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByText("Add currencies you also accept."),
    ).not.toBeInTheDocument();
  });

  it("clicking an unchecked currency fires onChange with the code appended", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AdditionalCurrenciesMultiSelect
        value={[]}
        excludedCode="USD"
        onChange={onChange}
      />,
    );
    const eur = document.getElementById("additional-currency-EUR")!;
    await user.click(eur);
    expect(onChange).toHaveBeenCalledWith(["EUR"]);
  });

  it("clicking a checked currency fires onChange with the code removed", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AdditionalCurrenciesMultiSelect
        value={["EUR", "GBP"]}
        excludedCode="USD"
        onChange={onChange}
      />,
    );
    const eur = document.getElementById("additional-currency-EUR")!;
    await user.click(eur);
    expect(onChange).toHaveBeenCalledWith(["GBP"]);
  });

  it("renders a fieldset per region group (4 fieldsets when no exclusion drops a region)", () => {
    render(
      <AdditionalCurrenciesMultiSelect
        value={[]}
        excludedCode={null}
        onChange={vi.fn()}
      />,
    );
    const fieldsets = document.querySelectorAll("fieldset");
    expect(fieldsets.length).toBe(4);
  });
});
