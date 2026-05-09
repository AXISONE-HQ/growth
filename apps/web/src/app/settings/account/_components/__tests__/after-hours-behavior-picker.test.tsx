/**
 * KAN-857 — AfterHoursBehaviorPicker unit tests. Minimal RadioGroup
 * selection + onChange wiring.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { AfterHoursBehaviorPicker } from "../after-hours-behavior-picker";

describe("AfterHoursBehaviorPicker — KAN-857", () => {
  it("renders 3 radio options with their spec §7.4 labels and sub-captions", () => {
    render(<AfterHoursBehaviorPicker value="pause" onChange={vi.fn()} />);
    const group = screen.getByRole("radiogroup", { name: "After-hours behavior" });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByText("Pause sending until next business hour")).toBeInTheDocument();
    expect(
      screen.getByText("Send anyway — let AI decide based on contact urgency"),
    ).toBeInTheDocument();
    expect(screen.getByText("Send only for high-confidence (>85%) decisions")).toBeInTheDocument();
    // Sub-captions
    expect(
      screen.getByText("AI queues outbound messages and sends when business reopens."),
    ).toBeInTheDocument();
  });

  it("renders the selected value as checked, others unchecked", () => {
    render(<AfterHoursBehaviorPicker value="send_anyway" onChange={vi.fn()} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    const byValue = Object.fromEntries(radios.map((r) => [r.value, r]));
    expect(byValue.pause.checked).toBe(false);
    expect(byValue.send_anyway.checked).toBe(true);
    expect(byValue.high_confidence_only.checked).toBe(false);
  });

  it("clicking an option fires onChange with that option's value", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AfterHoursBehaviorPicker value="pause" onChange={onChange} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    const target = radios.find((r) => r.value === "high_confidence_only")!;
    await user.click(target);
    expect(onChange).toHaveBeenCalledWith("high_confidence_only");
  });

  it("when disabled, all radios are disabled and onChange is not called on click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AfterHoursBehaviorPicker value="pause" onChange={onChange} disabled />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.every((r) => r.disabled)).toBe(true);
    const pauseRadio = radios.find((r) => r.value === "pause")!;
    await user.click(pauseRadio);
    expect(onChange).not.toHaveBeenCalled();
  });
});
