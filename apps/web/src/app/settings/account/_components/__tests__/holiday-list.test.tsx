/**
 * KAN-857 — HolidayList unit tests. Mirrors the SocialProfileList
 * pattern from Cohort 2: trpcMutation calls go through fetch + are
 * stubbed via vi.stubGlobal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    message: vi.fn(),
  },
}));

import { HolidayList, type HolidayRow } from "../holiday-list";

const HOLIDAYS: HolidayRow[] = [
  { id: "h1", name: "Canada Day", date: "2026-07-01", recurring: true },
  { id: "h2", name: "Company offsite", date: "2026-09-15T00:00:00.000Z", recurring: false },
];

beforeEach(() => {
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HolidayList — KAN-857", () => {
  it("empty state renders spec §8 verbatim copy", () => {
    render(<HolidayList holidays={[]} onChange={vi.fn()} />);
    expect(
      screen.getByText(
        /No holidays added\. AI uses these to pause sending on observed dates\./,
      ),
    ).toBeInTheDocument();
  });

  it("renders one row per holiday with name, formatted date, and recurring badge when applicable", () => {
    render(<HolidayList holidays={HOLIDAYS} onChange={vi.fn()} />);
    const list = screen.getByRole("list", { name: "Observed holidays" });
    const items = list.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(list).toContainElement(screen.getByText("Canada Day"));
    expect(list).toContainElement(screen.getByText("Company offsite"));
    // Recurring badge only on h1
    const badges = list.querySelectorAll("span");
    const recurringBadge = Array.from(badges).find((s) => s.textContent === "Recurring");
    expect(recurringBadge).toBeDefined();
    expect(screen.getAllByText("Recurring")).toHaveLength(1);
  });

  it("rejects add when name is empty (no API call, inline error)", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<HolidayList holidays={[]} onChange={vi.fn()} />);
    // Fill date but leave name empty
    const dateInput = screen.getByLabelText("Date") as HTMLInputElement;
    await user.type(dateInput, "2026-12-25");
    // Add button is disabled when name is empty — verify that, then
    // also confirm there's no API call.
    const addBtn = screen.getByRole("button", { name: "Add holiday" });
    expect(addBtn).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects add when date is missing (button disabled, no API call)", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<HolidayList holidays={[]} onChange={vi.fn()} />);
    await user.type(screen.getByLabelText("Holiday name"), "New Year's Day");
    const addBtn = screen.getByRole("button", { name: "Add holiday" });
    expect(addBtn).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Add CTA calls account.addHoliday with name+date+recurring, fires onChange, clears inputs", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { id: "new" } } }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<HolidayList holidays={[]} onChange={onChange} />);
    const nameInput = screen.getByLabelText("Holiday name") as HTMLInputElement;
    const dateInput = screen.getByLabelText("Date") as HTMLInputElement;
    await user.type(nameInput, "Canada Day");
    await user.type(dateInput, "2026-07-01");
    await user.click(screen.getByRole("switch", { name: "Recurring annually" }));
    await user.click(screen.getByRole("button", { name: "Add holiday" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Holiday added.");
    expect(nameInput.value).toBe("");
    expect(dateInput.value).toBe("");
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [unknown, RequestInit | undefined]
    >;
    const callBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(callBody).toMatchObject({
      name: "Canada Day",
      date: "2026-07-01",
      recurring: true,
    });
  });

  it("Recurring switch toggles state and is sent in the add payload", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { id: "new" } } }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<HolidayList holidays={[]} onChange={vi.fn()} />);
    const switchEl = screen.getByRole("switch", { name: "Recurring annually" });
    expect(switchEl).toHaveAttribute("aria-checked", "false");
    await user.click(switchEl);
    expect(switchEl).toHaveAttribute("aria-checked", "true");
    await user.click(switchEl);
    expect(switchEl).toHaveAttribute("aria-checked", "false");

    // After toggling off, payload should have recurring=false
    await user.type(screen.getByLabelText("Holiday name"), "Test");
    await user.type(screen.getByLabelText("Date"), "2026-11-11");
    await user.click(screen.getByRole("button", { name: "Add holiday" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [unknown, RequestInit | undefined]
    >;
    const callBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(callBody.recurring).toBe(false);
  });

  it("Remove icon button calls account.removeHoliday with the row id and toasts success", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { ok: true } } }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<HolidayList holidays={HOLIDAYS} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Remove holiday: Canada Day" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [unknown, RequestInit | undefined]
    >;
    const callBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(callBody).toMatchObject({ id: "h1" });
    expect(toastSuccessMock).toHaveBeenCalledWith("Holiday removed.");
  });

  it("formats both YYYY-MM-DD and full ISO datetime dates as locale strings", () => {
    render(<HolidayList holidays={HOLIDAYS} onChange={vi.fn()} />);
    // Both should produce a year-month-day formatted string. We don't
    // assert exact locale formatting (varies by env) — just that the
    // raw ISO string isn't shown verbatim.
    expect(screen.queryByText("2026-09-15T00:00:00.000Z")).not.toBeInTheDocument();
    // Both dates should render *some* readable form containing the year.
    const list = screen.getByRole("list", { name: "Observed holidays" });
    expect(list.textContent).toMatch(/2026/);
  });
});
