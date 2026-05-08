/**
 * KAN-XXX — EditFaqDialog tests.
 *
 * 4 tests:
 *  1. Pre-fills form with current question + answer
 *  2. Successful PUT closes dialog
 *  3. No-op short-circuit (no field changed) closes without server call
 *  4. 404 error surfaces inline
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

import { EditFaqDialog } from "../edit-faq-dialog";

const FAQ = {
  id: "f1",
  question: "What's the warranty period?",
  answer: "Five years parts and labor.",
};

function setupFetchMock(opts: {
  putResponse?: { ok: boolean; status?: number; body?: unknown };
} = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const r = opts.putResponse ?? {
        ok: true,
        body: {
          faq: { id: "f1", question: "Q", answer: "A2", status: "ready", errorDetail: null },
        },
      };
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 400),
        text: async () => "",
        json: async () => r.body,
      } as Response;
    }
    return { ok: true, json: async () => ({ faqs: [] }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog(faq = FAQ) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <EditFaqDialog faq={faq} open={true} onOpenChange={onOpenChange} />
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

describe("EditFaqDialog — KAN-XXX", () => {
  it("Test 1 — pre-fills form with current question + answer", () => {
    setupFetchMock();
    renderDialog();
    expect(screen.getByLabelText("Question")).toHaveValue("What's the warranty period?");
    expect(screen.getByLabelText("Answer")).toHaveValue("Five years parts and labor.");
  });

  it("Test 2 — successful PUT closes dialog + fires success toast", async () => {
    const fetchMock = setupFetchMock();
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    const answer = screen.getByLabelText("Answer") as HTMLTextAreaElement;
    await user.clear(answer);
    await user.type(answer, "Updated answer text.");
    await user.click(screen.getByRole("button", { name: "Save FAQ entry" }));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("FAQ entry saved.");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Body should contain only the changed field (answer)
    const putCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toHaveProperty("answer");
    expect(body).not.toHaveProperty("question");
  });

  it("Test 3 — no-op (unchanged fields) closes without server call", async () => {
    const fetchMock = setupFetchMock();
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Save FAQ entry" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT")).toBeUndefined();
  });

  it("Test 4 — 404 error surfaces inline", async () => {
    setupFetchMock({ putResponse: { ok: false, status: 404, body: { error: "missing" } } });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    const answer = screen.getByLabelText("Answer") as HTMLTextAreaElement;
    await user.clear(answer);
    await user.type(answer, "new answer");
    await user.click(screen.getByRole("button", { name: "Save FAQ entry" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
