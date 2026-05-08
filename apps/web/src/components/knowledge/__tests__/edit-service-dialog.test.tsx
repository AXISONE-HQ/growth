/**
 * KAN-XXX — EditServiceDialog tests.
 *
 * 4 tests:
 *  1. Pre-fills form with current service fields
 *  2. Successful PUT closes dialog + fires success toast
 *  3. 404 error surfaces inline
 *  4. Switching priceUnit to CUSTOM hides Price + shows Custom price label
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

import { EditServiceDialog } from "../edit-service-dialog";

const SERVICE = {
  id: "s1",
  title: "Senior Mentorship",
  description: "Weekly 1:1.",
  price: 250,
  priceUnit: "PER_HOUR" as const,
  priceCustomLabel: null,
  startDate: null,
  endDate: null,
  includedItems: ["Slack support"],
  excludedItems: [],
};

function setupFetchMock(opts: {
  putResponse?: { ok: boolean; status?: number; body?: unknown };
} = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const r = opts.putResponse ?? {
        ok: true,
        body: {
          service: { id: "s1", title: "X", status: "ready", errorDetail: null },
        },
      };
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 400),
        text: async () => "",
        json: async () => r.body,
      } as Response;
    }
    return { ok: true, json: async () => ({ services: [] }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog(service = SERVICE) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <EditServiceDialog service={service} open={true} onOpenChange={onOpenChange} />
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

describe("EditServiceDialog — KAN-XXX", () => {
  it("Test 1 — pre-fills form with current service fields", () => {
    setupFetchMock();
    renderDialog();
    expect(screen.getByLabelText("Title")).toHaveValue("Senior Mentorship");
    expect(screen.getByLabelText("Description")).toHaveValue("Weekly 1:1.");
    expect(screen.getByLabelText("Price")).toHaveValue(250);
    // Pre-filled included item
    expect(screen.getByLabelText("What's included item 1")).toHaveValue("Slack support");
  });

  it("Test 2 — successful PUT closes dialog + fires success toast", async () => {
    setupFetchMock();
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await user.clear(title);
    await user.type(title, "Updated title");
    await user.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Service saved.");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Test 3 — 404 error surfaces inline; dialog stays open", async () => {
    setupFetchMock({ putResponse: { ok: false, status: 404, body: { error: "missing" } } });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await user.clear(title);
    await user.type(title, "anything");
    await user.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Test 4 — switching unit to CUSTOM hides Price + shows Custom price label", async () => {
    setupFetchMock();
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByLabelText("Price")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Price unit"), "CUSTOM");
    expect(screen.queryByLabelText("Price")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Custom price label")).toBeInTheDocument();
  });
});
