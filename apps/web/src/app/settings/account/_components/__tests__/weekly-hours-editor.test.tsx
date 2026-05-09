/**
 * KAN-857 — WeeklyHoursEditor unit tests.
 *
 * Covers the three nuanced behaviors Fred locked in pre-flight:
 *
 *   6. Initial state — empty {} or missing day keys → all 7 days
 *      render as Closed (Switch ON, TimePickers hidden, "Closed" label)
 *
 *   7. "Apply same hours to all" — disabled when all days closed;
 *      copies the first non-closed day's open/close to other non-closed
 *      days; preserves closed days (does NOT override Saturday=closed)
 *
 *   A. Closed-day hours preservation — toggling open→closed→open
 *      restores the previously-set open/close (state retained
 *      internally even though payload omits open/close for closed days)
 *
 *   Plus: serialization shape — closed days emit { closed: true } only
 *   (no open/close), open days emit { closed: false, open, close }
 *   (matches the discriminated-union HoursUpdateSchema in shared)
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { WeeklyHoursEditor } from "../weekly-hours-editor";

// ─────────────────────────────────────────────
// Decision 6 — initial state on empty input
// ─────────────────────────────────────────────

describe("WeeklyHoursEditor — Decision 6 (initial state)", () => {
  it("renders all 7 days as Closed when value is empty {}", () => {
    render(<WeeklyHoursEditor value={{}} onChange={vi.fn()} />);
    // 7 day rows, each with the muted "Closed" label visible
    const closedLabels = screen.getAllByText("Closed", { selector: "span" });
    expect(closedLabels.length).toBeGreaterThanOrEqual(7);
    // No TimePickers rendered for any day
    expect(screen.queryAllByLabelText(/open time$/)).toHaveLength(0);
    expect(screen.queryAllByLabelText(/close time$/)).toHaveLength(0);
  });

  it("renders missing day keys as Closed even when other days are set", () => {
    render(
      <WeeklyHoursEditor
        value={{ monday: { closed: false, open: "09:00", close: "17:00" } }}
        onChange={vi.fn()}
      />,
    );
    // Monday should have time pickers visible
    expect(screen.getByLabelText("Monday open time")).toBeInTheDocument();
    expect(screen.getByLabelText("Monday close time")).toBeInTheDocument();
    // Other 6 days should be closed (no TimePicker visible)
    expect(screen.queryByLabelText("Tuesday open time")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sunday open time")).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────
// Decision 7 — Apply same hours to all
// ─────────────────────────────────────────────

describe("WeeklyHoursEditor — Decision 7 (Apply same hours to all)", () => {
  it("button is DISABLED when every day is closed", () => {
    render(<WeeklyHoursEditor value={{}} onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Apply same hours to all open days" }),
    ).toBeDisabled();
  });

  it("button is enabled with at least one open day", () => {
    render(
      <WeeklyHoursEditor
        value={{ monday: { closed: false, open: "09:00", close: "17:00" } }}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Apply same hours to all open days" }),
    ).not.toBeDisabled();
  });

  it("preserves closed days when applied — Saturday stays Closed", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <WeeklyHoursEditor
        value={{
          monday: { closed: false, open: "09:00", close: "17:00" },
          tuesday: { closed: false, open: "10:00", close: "18:00" },
          // Wed-Fri implicit closed (missing keys)
          saturday: { closed: true },
          sunday: { closed: true },
        }}
        onChange={onChange}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Apply same hours to all open days" }),
    );
    expect(onChange).toHaveBeenCalled();
    const lastCallArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    // Monday + Tuesday updated to Monday's open/close (Mon was first non-closed)
    expect(lastCallArg.monday).toEqual({ closed: false, open: "09:00", close: "17:00" });
    expect(lastCallArg.tuesday).toEqual({ closed: false, open: "09:00", close: "17:00" });
    // Wed-Sun stay closed (Wed/Thu/Fri were missing; Sat/Sun explicitly)
    expect(lastCallArg.wednesday).toEqual({ closed: true });
    expect(lastCallArg.thursday).toEqual({ closed: true });
    expect(lastCallArg.friday).toEqual({ closed: true });
    expect(lastCallArg.saturday).toEqual({ closed: true });
    expect(lastCallArg.sunday).toEqual({ closed: true });
  });
});

// ─────────────────────────────────────────────
// Decision A — Closed-day hours preservation on toggle
// ─────────────────────────────────────────────

describe("WeeklyHoursEditor — Decision A (closed-day hours preservation)", () => {
  it("toggling Monday open→closed→open restores the previous open/close", async () => {
    const onChange = vi.fn();
    render(
      <WeeklyHoursEditor
        value={{ monday: { closed: false, open: "08:30", close: "17:30" } }}
        onChange={onChange}
      />,
    );
    // Initial render — Monday TimePickers visible with the values
    expect(screen.getByLabelText("Monday open time")).toHaveValue("08:30");
    expect(screen.getByLabelText("Monday close time")).toHaveValue("17:30");

    // Toggle Monday closed
    const mondaySwitch = screen.getByLabelText(
      /Monday closed toggle\. Toggle off to open this day\./,
    );
    fireEvent.click(mondaySwitch);
    expect(screen.queryByLabelText("Monday open time")).not.toBeInTheDocument();

    // Last onChange call should serialize Monday as { closed: true } only
    const closedSerialization = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(closedSerialization.monday).toEqual({ closed: true });
    expect(closedSerialization.monday.open).toBeUndefined();
    expect(closedSerialization.monday.close).toBeUndefined();

    // Toggle Monday open again — TimePickers reappear with the SAME values
    fireEvent.click(mondaySwitch);
    expect(screen.getByLabelText("Monday open time")).toHaveValue("08:30");
    expect(screen.getByLabelText("Monday close time")).toHaveValue("17:30");

    // Final onChange should serialize Monday with the original open/close
    const reopenedSerialization = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(reopenedSerialization.monday).toEqual({
      closed: false,
      open: "08:30",
      close: "17:30",
    });
  });
});

// ─────────────────────────────────────────────
// Serialization shape — discriminated-union compliance
// ─────────────────────────────────────────────

describe("WeeklyHoursEditor — payload serialization", () => {
  it("emits { closed: true } only for closed days (no open/close)", () => {
    const onChange = vi.fn();
    render(<WeeklyHoursEditor value={{}} onChange={onChange} />);
    // Trigger any state change to fire onChange — toggle Sunday from
    // closed (default) to open.
    const sundaySwitch = screen.getByLabelText(
      /Sunday closed toggle\. Toggle off to open this day\./,
    );
    fireEvent.click(sundaySwitch);
    const serialized = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    // All other 6 days are closed — emit { closed: true } only
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]) {
      expect(serialized[day]).toEqual({ closed: true });
      expect(Object.keys(serialized[day])).toEqual(["closed"]);
    }
    // Sunday is now open — emits { closed: false, open, close }
    expect(serialized.sunday).toEqual({
      closed: false,
      open: "09:00",
      close: "17:00",
    });
  });
});
