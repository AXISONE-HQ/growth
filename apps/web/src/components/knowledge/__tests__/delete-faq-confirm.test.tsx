/**
 * KAN-XXX — DeleteFaqConfirm tests.
 *
 * 4 tests:
 *  1. Renders confirmation prompt with truncated question preview
 *  2. Successful DELETE closes dialog + fires success toast
 *  3. 404 error surfaces inline (system-error panel)
 *  4. Cancel button closes without server call
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

import { DeleteFaqConfirm } from "../delete-faq-confirm";

function setupFetchMock(opts: {
  deleteResponse?: { ok: boolean; status?: number; body?: unknown };
} = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      const r = opts.deleteResponse ?? {
        ok: true,
        body: { id: "f1", status: "deleted" },
      };
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 400),
        text: async () => "",
        json: async () => r.body,
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog(opts: { id?: string | null; question?: string | null } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <DeleteFaqConfirm
        faqId={opts.id ?? "f1"}
        question={opts.question ?? "What's the warranty?"}
        open={true}
        onOpenChange={onOpenChange}
      />
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

describe("DeleteFaqConfirm — KAN-XXX", () => {
  it("Test 1 — renders confirmation prompt with question preview", () => {
    setupFetchMock();
    renderDialog({ question: "What's the warranty?" });
    expect(screen.getByRole("heading", { name: "Delete FAQ entry?" })).toBeInTheDocument();
    expect(screen.getByText(/What's the warranty\?/)).toBeInTheDocument();
  });

  it("Test 2 — successful DELETE closes dialog + fires success toast", async () => {
    setupFetchMock();
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Confirm delete FAQ entry" }));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("FAQ entry deleted.");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Test 3 — 404 error surfaces inline; dialog stays open", async () => {
    setupFetchMock({ deleteResponse: { ok: false, status: 404, body: { error: "gone" } } });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Confirm delete FAQ entry" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Delete error")).toBeInTheDocument();
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Test 4 — Cancel closes without server call", async () => {
    const fetchMock = setupFetchMock();
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel delete" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBeUndefined();
  });
});
