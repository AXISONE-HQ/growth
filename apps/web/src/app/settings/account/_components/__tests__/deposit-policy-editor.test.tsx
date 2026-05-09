/**
 * KAN-859 — DepositPolicyEditor unit tests.
 *
 * Covers conditional sub-input rendering per type + Decision 3
 * client-side validation:
 *   - Percentage: integer 1-100
 *   - Fixed: positive decimal ≤999999
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { DepositPolicyEditor } from "../deposit-policy-editor";

const NOOP_PROPS = {
  defaultCurrencyCode: "USD",
  onChange: () => undefined,
};

describe("DepositPolicyEditor — conditional sub-inputs", () => {
  it("No deposit → renders 3 radios, no sub-input", () => {
    render(
      <DepositPolicyEditor
        required={false}
        type={null}
        amount={null}
        {...NOOP_PROPS}
      />,
    );
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByLabelText("Percent of total")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Amount in/)).not.toBeInTheDocument();
  });

  it("Percentage → renders Percent of total Input", () => {
    render(
      <DepositPolicyEditor
        required={true}
        type="percentage"
        amount={25}
        {...NOOP_PROPS}
      />,
    );
    expect(screen.getByLabelText("Percent of total")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Amount in/)).not.toBeInTheDocument();
  });

  it("Fixed → renders Amount in {currency} Input with currency label from default", () => {
    render(
      <DepositPolicyEditor
        required={true}
        type="fixed"
        amount={500}
        {...NOOP_PROPS}
        defaultCurrencyCode="EUR"
      />,
    );
    expect(screen.getByLabelText("Amount in EUR")).toBeInTheDocument();
    expect(screen.queryByLabelText("Percent of total")).not.toBeInTheDocument();
  });
});

describe("DepositPolicyEditor — Decision 3 validation", () => {
  it("Percentage: rejects 0 with inline error", () => {
    const onChange = vi.fn();
    render(
      <DepositPolicyEditor
        required={true}
        type="percentage"
        amount={null}
        defaultCurrencyCode="USD"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Percent of total"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/between 1 and 100/);
  });

  it("Percentage: rejects 101 with inline error", () => {
    render(
      <DepositPolicyEditor
        required={true}
        type="percentage"
        amount={null}
        defaultCurrencyCode="USD"
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Percent of total"), {
      target: { value: "101" },
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("Percentage: rejects non-integer 25.5 with inline error", () => {
    render(
      <DepositPolicyEditor
        required={true}
        type="percentage"
        amount={null}
        defaultCurrencyCode="USD"
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Percent of total"), {
      target: { value: "25.5" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/whole number/);
  });

  it("Percentage: accepts 25 and fires onChange with required=true, type=percentage, amount=25", () => {
    const onChange = vi.fn();
    render(
      <DepositPolicyEditor
        required={true}
        type="percentage"
        amount={null}
        defaultCurrencyCode="USD"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Percent of total"), {
      target: { value: "25" },
    });
    expect(onChange).toHaveBeenCalledWith({
      required: true,
      type: "percentage",
      amount: 25,
    });
  });

  it("Fixed: rejects negative -50 with inline error", () => {
    render(
      <DepositPolicyEditor
        required={true}
        type="fixed"
        amount={null}
        defaultCurrencyCode="USD"
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Amount in USD"), {
      target: { value: "-50" },
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("Fixed: rejects 1000000 with inline error", () => {
    render(
      <DepositPolicyEditor
        required={true}
        type="fixed"
        amount={null}
        defaultCurrencyCode="USD"
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Amount in USD"), {
      target: { value: "1000000" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/0 and 999,999/);
  });

  it("Fixed: accepts 500.50 (decimals allowed)", () => {
    const onChange = vi.fn();
    render(
      <DepositPolicyEditor
        required={true}
        type="fixed"
        amount={null}
        defaultCurrencyCode="USD"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Amount in USD"), {
      target: { value: "500.50" },
    });
    expect(onChange).toHaveBeenCalledWith({
      required: true,
      type: "fixed",
      amount: 500.5,
    });
  });
});

describe("DepositPolicyEditor — radio mode switching", () => {
  it("clicking 'No deposit required' fires onChange with required=false, type=null, amount=null", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DepositPolicyEditor
        required={true}
        type="percentage"
        amount={25}
        defaultCurrencyCode="USD"
        onChange={onChange}
      />,
    );
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    const none = radios.find((r) => r.value === "none")!;
    await user.click(none);
    expect(onChange).toHaveBeenCalledWith({
      required: false,
      type: null,
      amount: null,
    });
  });
});
