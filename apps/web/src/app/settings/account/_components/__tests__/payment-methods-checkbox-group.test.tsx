/**
 * KAN-859 — PaymentMethodsCheckboxGroup unit tests.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { PaymentMethodsCheckboxGroup } from "../payment-methods-checkbox-group";

describe("PaymentMethodsCheckboxGroup — KAN-859", () => {
  it("renders all six options with their spec labels", () => {
    render(<PaymentMethodsCheckboxGroup value={[]} onChange={vi.fn()} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getByText("Card")).toBeInTheDocument();
    expect(screen.getByText("ACH")).toBeInTheDocument();
    expect(screen.getByText("Wire")).toBeInTheDocument();
    expect(screen.getByText("Check")).toBeInTheDocument();
    expect(screen.getByText("Stripe")).toBeInTheDocument();
    expect(screen.getByText("PayPal")).toBeInTheDocument();
  });

  it("renders the selected values as checked, others unchecked", () => {
    render(
      <PaymentMethodsCheckboxGroup value={["card", "stripe"]} onChange={vi.fn()} />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const checked = boxes.filter((b) => b.checked).length;
    expect(checked).toBe(2);
  });

  it("clicking an unchecked option fires onChange with the value appended", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<PaymentMethodsCheckboxGroup value={["card"]} onChange={onChange} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const ach = boxes.find((b) => b.id === "payment-method-ach")!;
    await user.click(ach);
    expect(onChange).toHaveBeenCalledWith(["card", "ach"]);
  });

  it("clicking a checked option fires onChange with the value removed", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <PaymentMethodsCheckboxGroup
        value={["card", "stripe"]}
        onChange={onChange}
      />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const card = boxes.find((b) => b.id === "payment-method-card")!;
    await user.click(card);
    expect(onChange).toHaveBeenCalledWith(["stripe"]);
  });

  it("when disabled, all checkboxes are disabled and onChange is not called", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <PaymentMethodsCheckboxGroup value={[]} onChange={onChange} disabled />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((b) => b.disabled)).toBe(true);
    await user.click(boxes[0]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
