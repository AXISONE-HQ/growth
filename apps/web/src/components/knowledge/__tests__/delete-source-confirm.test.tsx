/**
 * KAN-829 sub-cohort 5 — DeleteSourceConfirm tests.
 *
 * 7 tests covering: dialog header rendering with source title, Cancel
 * triggers onOpenChange(false), confirm fires DELETE mutation + invalidates
 * queries + closes dialog + emits sonner toast.success, server 404 surfaces
 * inline error panel (NOT toast) and dialog stays open, server 401/403
 * surfaces sign-in expired message, generic 500 surfaces fallback message,
 * forbidden-microcopy audit (combined + sub-cohort-5 list).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// KAN-829 sub-cohort 7 — mock firebase so buildHeaders() can attach a
// Bearer token without spinning up the real Firebase Auth SDK in jsdom.
vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: {
    currentUser: { getIdToken: vi.fn(async () => "test-id-token") },
  },
  googleProvider: {},
}));

import { DeleteSourceConfirm } from "../delete-source-confirm";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

function renderConfirm(opts: {
  status?: number;
  sourceId?: string | null;
  sourceTitle?: string | null;
} = {}): {
  qc: QueryClient;
  onOpenChange: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const status = opts.status ?? 200;
  const onOpenChange = vi.fn();
  const fetchMock = vi.fn(async () => {
    if (status >= 400) {
      return { ok: false, status, text: async () => "" } as Response;
    }
    return {
      ok: true,
      status,
      json: async () => ({ id: opts.sourceId ?? "src-1", status: "deleted" }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={qc}>
      <DeleteSourceConfirm
        sourceId={opts.sourceId ?? "src-1"}
        sourceTitle={opts.sourceTitle ?? "Sample source"}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  return { qc, onOpenChange, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("DeleteSourceConfirm — KAN-829 sub-cohort 5", () => {
  it("Test 1 — renders header + source title in description + danger Confirm button", () => {
    renderConfirm({ sourceTitle: "Pricing FAQ" });
    expect(screen.getByText("Delete source?")).toBeInTheDocument();
    expect(screen.getByText(/Confirm removal of Pricing FAQ/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm delete source/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel delete/i })).toBeInTheDocument();
  });

  it("Test 2 — Cancel calls onOpenChange(false); no fetch fired", async () => {
    const user = userEvent.setup();
    const { onOpenChange, fetchMock } = renderConfirm();
    await user.click(screen.getByRole("button", { name: /Cancel delete/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Test 3 — confirm success: DELETE fired, queries invalidated, toast.success, dialog closes", async () => {
    const user = userEvent.setup();
    const { qc, onOpenChange, fetchMock } = renderConfirm({ sourceId: "src-42" });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: /Confirm delete source/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    // Sub-cohort 7 wire-up — URL prefixed with API_BASE; auth headers
    // (Authorization Bearer + x-tenant-id) attached via buildHeaders;
    // credentials:"include" no longer used (apps/api ignores cookies).
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(typeof calledUrl).toBe("string");
    expect(calledUrl as string).toMatch(/\/api\/knowledge\/sources\/src-42$/);
    expect(calledInit as RequestInit).toMatchObject({ method: "DELETE" });
    const headers = (calledInit as RequestInit).headers as Record<string, string>;
    expect(headers).toMatchObject({
      Authorization: "Bearer test-id-token",
      "x-tenant-id": expect.any(String),
    });
    expect((calledInit as RequestInit & { credentials?: string }).credentials).toBeUndefined();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Source deleted."));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["knowledge", "sources"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["knowledge", "tier-limits"] });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("Test 4 — server 404 surfaces inline error panel (not toast); dialog stays open", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderConfirm({ status: 404 });
    await user.click(screen.getByRole("button", { name: /Confirm delete source/i }));

    expect(await screen.findByLabelText("Delete error")).toBeInTheDocument();
    expect(screen.getByText(/no longer exists/i)).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Test 5 — server 401 surfaces sign-in expired message inline", async () => {
    const user = userEvent.setup();
    renderConfirm({ status: 401 });
    await user.click(screen.getByRole("button", { name: /Confirm delete source/i }));
    expect(await screen.findByText(/Sign in expired/i)).toBeInTheDocument();
  });

  it("Test 6 — server 500 surfaces fallback message inline", async () => {
    const user = userEvent.setup();
    renderConfirm({ status: 500 });
    await user.click(screen.getByRole("button", { name: /Confirm delete source/i }));
    expect(
      await screen.findByText(/Could not delete this source/i),
    ).toBeInTheDocument();
  });

  it("Test 7 — no forbidden microcopy in any rendered state (combined audit incl. sub-cohort-5)", async () => {
    const user = userEvent.setup();
    renderConfirm({ status: 500, sourceTitle: "Audit me" });
    // Trigger error state so the inline error panel is also audited
    await user.click(screen.getByRole("button", { name: /Confirm delete source/i }));
    await waitFor(() =>
      expect(screen.getByLabelText("Delete error")).toBeInTheDocument(),
    );

    const FORBIDDEN = [
      "magic",
      "simply",
      "easily",
      "seamlessly",
      "revolutionary",
      "cutting-edge",
      "leverage",
      "synergy",
      "permanent",
      "forever",
      "cannot be undone",
      "unfortunately",
      "please",
      "sorry",
    ];
    const allText = document.body.textContent?.toLowerCase() ?? "";
    for (const word of FORBIDDEN) {
      const re = new RegExp(`\\b${word.replace(/[-]/g, "[-]").replace(/ /g, "\\s+")}\\b`);
      expect(re.test(allText), `Forbidden phrase "${word}" found in rendered copy`).toBe(false);
    }

    // "just" — only allowed as part of "just now" (relative-time formatter exception)
    const stripped = allText.replace(/\bjust\s+now\b/g, "");
    expect(/\bjust\b/.test(stripped)).toBe(false);
  });
});
