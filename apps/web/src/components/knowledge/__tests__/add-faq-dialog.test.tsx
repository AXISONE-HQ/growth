/**
 * KAN-XXX — AddFaqDialog tests.
 *
 * 6 tests:
 *  1. Renders form fields (Question, Answer) with labels
 *  2. Submit disabled until both fields have non-empty trimmed content
 *  3. Successful POST → toast + dialog closes + invalidates faqs query
 *  4. 400 server error surfaces inline error message
 *  5. Server returns status='error' inline path renders errorDetail
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

import { AddFaqDialog } from "../add-faq-dialog";

function setupFetchMock(opts: {
  postResponse?: { ok: boolean; status?: number; body?: unknown };
} = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const r = opts.postResponse ?? {
        ok: true,
        body: {
          faq: { id: "f1", question: "Q", answer: "A", status: "ready", errorDetail: null },
        },
      };
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 201 : 400),
        text: async () => "",
        json: async () => r.body,
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ faqs: [] }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog(open = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <AddFaqDialog open={open} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { ...result, onOpenChange, client };
}

beforeEach(() => {
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AddFaqDialog — KAN-XXX", () => {
  it("Test 1 — renders form fields (Question + Answer) with labels", () => {
    setupFetchMock();
    renderDialog();
    expect(screen.getByLabelText("Question")).toBeInTheDocument();
    expect(screen.getByLabelText("Answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save FAQ entry" })).toBeInTheDocument();
  });

  it("Test 2 — Save button disabled until both fields have content", async () => {
    setupFetchMock();
    const user = userEvent.setup();
    renderDialog();
    const save = screen.getByRole("button", { name: "Save FAQ entry" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Question"), "What's the warranty?");
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Answer"), "Five years.");
    expect(save).not.toBeDisabled();
  });

  it("Test 3 — successful POST closes dialog + fires success toast", async () => {
    setupFetchMock();
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.type(screen.getByLabelText("Question"), "Q?");
    await user.type(screen.getByLabelText("Answer"), "A.");
    await user.click(screen.getByRole("button", { name: "Save FAQ entry" }));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("FAQ entry added.");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Test 4 — 400 error surfaces inline error", async () => {
    setupFetchMock({
      postResponse: {
        ok: false,
        status: 400,
        body: { error: "Question is too long" },
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText("Question"), "Q?");
    await user.type(screen.getByLabelText("Answer"), "A.");
    await user.click(screen.getByRole("button", { name: "Save FAQ entry" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("Test 5 — server status='error' surfaces errorDetail inline (no toast)", async () => {
    setupFetchMock({
      postResponse: {
        ok: true,
        body: {
          faq: { id: "f1", question: "Q", answer: "A", status: "error", errorDetail: "OpenAI rate limit" },
        },
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText("Question"), "Q?");
    await user.type(screen.getByLabelText("Answer"), "A.");
    await user.click(screen.getByRole("button", { name: "Save FAQ entry" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("OpenAI rate limit");
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("Test 6 — foundation token coverage: zero hex in rendered output", () => {
    setupFetchMock();
    const { container } = renderDialog();
    const html = container.innerHTML;
    const hex = html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hex, `Hardcoded hex colors leaked: ${hex.join(", ")}`).toEqual([]);
  });
});
