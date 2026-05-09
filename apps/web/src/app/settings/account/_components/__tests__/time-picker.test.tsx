/**
 * KAN-857 — TimePicker (native input type=time wrapped in Input shell).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { TimePicker } from "../time-picker";

describe("TimePicker", () => {
  it("renders a native time input with HH:mm value", () => {
    render(
      <TimePicker
        id="t1"
        value="09:30"
        onChange={() => undefined}
        ariaLabel="Test open time"
      />,
    );
    const input = screen.getByLabelText("Test open time") as HTMLInputElement;
    expect(input.type).toBe("time");
    expect(input.value).toBe("09:30");
  });

  it("step=900 (15 min) — keyboard arrow keys adjust by 15-min increments per spec §9", () => {
    render(
      <TimePicker
        id="t2"
        value="09:00"
        onChange={() => undefined}
        ariaLabel="Test open time"
      />,
    );
    const input = screen.getByLabelText("Test open time") as HTMLInputElement;
    expect(input.step).toBe("900");
  });

  it("propagates user input via onChange", () => {
    const onChange = vi.fn();
    render(
      <TimePicker
        id="t3"
        value="09:00"
        onChange={onChange}
        ariaLabel="Test open time"
      />,
    );
    const input = screen.getByLabelText("Test open time") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10:30" } });
    expect(onChange).toHaveBeenCalledWith("10:30");
  });
});
