/**
 * KAN-859 — RefundWindowInput unit tests. Decision 3 client-side
 * validation: integer 0-365.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { RefundWindowInput } from "../refund-window-input";

describe("RefundWindowInput — KAN-859", () => {
  it("renders the helper caption from spec", () => {
    render(<RefundWindowInput value={14} onChange={vi.fn()} />);
    expect(
      screen.getByText("Days from purchase the customer can request a refund."),
    ).toBeInTheDocument();
  });

  it("rejects negative values with inline error", () => {
    const onChange = vi.fn();
    render(<RefundWindowInput value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Refund window (days)"), {
      target: { value: "-1" },
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("rejects > 365 with inline error", () => {
    render(<RefundWindowInput value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Refund window (days)"), {
      target: { value: "366" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/0 and 365/);
  });

  it("rejects non-integer with inline error", () => {
    render(<RefundWindowInput value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Refund window (days)"), {
      target: { value: "14.5" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/whole number/);
  });

  it("accepts a valid value and calls onChange with the integer", () => {
    const onChange = vi.fn();
    render(<RefundWindowInput value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Refund window (days)"), {
      target: { value: "14" },
    });
    expect(onChange).toHaveBeenCalledWith(14);
  });

  it("clearing the input passes null upstream", () => {
    const onChange = vi.fn();
    render(<RefundWindowInput value={14} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Refund window (days)"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("accepts 0 (same-day refunds disabled)", () => {
    const onChange = vi.fn();
    render(<RefundWindowInput value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Refund window (days)"), {
      target: { value: "0" },
    });
    expect(onChange).toHaveBeenCalledWith(0);
  });
});
