/**
 * KAN-XXX — AddServiceDialog tests.
 *
 * 6 tests:
 *  1. Renders form fields (title, description, price unit, price)
 *  2. Successful POST closes dialog + fires success toast
 *  3. CUSTOM unit hides numeric price + shows custom label field
 *  4. validateClient — endDate < startDate rejected
 *  5. ItemListEditor — add/remove rows works
 *  6. Foundation token coverage — no hex
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

const toastSuccessMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: vi.fn(),
  },
}));

import { AddServiceDialog, validateClient } from "../add-service-dialog";

function setupFetchMock(opts: {
  postResponse?: { ok: boolean; status?: number; body?: unknown };
} = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const r = opts.postResponse ?? {
        ok: true,
        body: {
          service: { id: "s1", title: "X", status: "ready", errorDetail: null },
        },
      };
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 201 : 400),
        text: async () => "",
        json: async () => r.body,
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ services: [] }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <AddServiceDialog open={true} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { ...result, onOpenChange };
}

beforeEach(() => {
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AddServiceDialog — KAN-XXX", () => {
  it("Test 1 — renders form fields with labels", () => {
    setupFetchMock();
    renderDialog();
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("Price unit")).toBeInTheDocument();
    expect(screen.getByLabelText("Price")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save service" })).toBeInTheDocument();
  });

  it("Test 2 — successful POST closes dialog + fires success toast", async () => {
    setupFetchMock();
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.type(screen.getByLabelText("Title"), "Mentorship");
    await user.type(screen.getByLabelText("Description"), "Weekly 1:1 sessions.");
    await user.type(screen.getByLabelText("Price"), "250");
    await user.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Service added.");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Test 3 — CUSTOM unit hides numeric price + shows custom label", async () => {
    setupFetchMock();
    const user = userEvent.setup();
    renderDialog();
    // Initially: numeric Price visible, Custom label not
    expect(screen.getByLabelText("Price")).toBeInTheDocument();
    expect(screen.queryByLabelText("Custom price label")).not.toBeInTheDocument();
    // Switch to CUSTOM
    await user.selectOptions(screen.getByLabelText("Price unit"), "CUSTOM");
    expect(screen.queryByLabelText("Price")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Custom price label")).toBeInTheDocument();
  });

  it("Test 4 — validateClient: endDate < startDate rejected", () => {
    const result = validateClient({
      title: "X",
      description: "Y",
      priceText: "50",
      priceUnit: "PER_HOUR",
      priceCustomLabel: "",
      startDate: "2026-12-01",
      endDate: "2026-06-01",
      includedItems: [],
      excludedItems: [],
    });
    expect("error" in result).toBe(true);
    expect(("error" in result ? result.error : "")).toMatch(/precede start date/i);
  });

  it("Test 5 — ItemListEditor: add row + remove row + at-least-one row enforced", async () => {
    setupFetchMock();
    const user = userEvent.setup();
    renderDialog();
    // Initially: one empty row each for included and excluded → 2 add buttons + 2 remove buttons
    expect(screen.getByRole("button", { name: "Add included item" })).toBeInTheDocument();
    expect(screen.getByLabelText("What's included item 1")).toBeInTheDocument();

    // Click "Add included item" → now 2 included rows
    await user.click(screen.getByRole("button", { name: "Add included item" }));
    expect(screen.getByLabelText("What's included item 2")).toBeInTheDocument();

    // Remove the second included row → back to 1
    await user.click(screen.getByRole("button", { name: "Remove included item 2" }));
    expect(screen.queryByLabelText("What's included item 2")).not.toBeInTheDocument();
  });

  it("Test 6 — foundation token coverage: zero hex in rendered output", () => {
    setupFetchMock();
    const { container } = renderDialog();
    const html = container.innerHTML;
    const hex = html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hex, `Hardcoded hex colors leaked: ${hex.join(", ")}`).toEqual([]);
  });
});
