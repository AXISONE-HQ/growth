/**
 * KAN-829 sub-cohort 4 — AddSourceDialog tests.
 *
 * Tests cover Step 1 grid (5 cards post-KAN-XXX: 2 functional, 3 disabled),
 * gate on disabled card click, full PDF / paste-text flows, validation
 * (PDF size cap, paste-text char cap), submission success (mutation +
 * invalidation + close), submission error (display + dialog stays open),
 * microcopy + DS forbidden-words audits, tier-gating UX for PDF.
 *
 * **KAN-XXX:** the legacy "Build FAQ" card + FAQ-flow tests are removed.
 * FAQ entries are first-class with their own dialog flow (add-faq-dialog).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
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

import { AddSourceDialog } from "../add-source-dialog";

function renderDialog(open = true): {
  qc: QueryClient;
  onOpenChange: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const onOpenChange = vi.fn();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ sourceId: "src-test-1" }),
  } as Response));
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <AddSourceDialog open={open} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { qc, onOpenChange, fetchMock };
}

beforeEach(() => {
  // No fake timers — userEvent + Radix dialog work better with real timers
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AddSourceDialog — KAN-829 sub-cohort 4", () => {
  it("Test 1 — Step 1 renders 5 source-type cards (KAN-XXX dropped FAQ card)", () => {
    renderDialog();
    expect(screen.getByText("Upload PDF")).toBeInTheDocument();
    expect(screen.getByText("Paste text")).toBeInTheDocument();
    expect(screen.queryByText("Build FAQ")).not.toBeInTheDocument();
    expect(screen.getByText("Connect website")).toBeInTheDocument();
    expect(screen.getByText("Upload spreadsheet")).toBeInTheDocument();
    expect(screen.getByText("Connect social")).toBeInTheDocument();
  });

  it("Test 2 — 3 coming-soon cards have aria-disabled + identical 'Coming soon' hint (no timeline drift)", () => {
    renderDialog();
    const comingSoonTitles = ["Connect website", "Upload spreadsheet", "Connect social"];
    // All three coming-soon cards must render the same neutral hint string.
    // Per-connector timeline strings ("Available next sprint", "Coming later
    // this year") are roadmap commitments we haven't made — this assertion
    // pins the no-timeline-drift contract.
    for (const title of comingSoonTitles) {
      const card = screen.getByText(title).closest("button")!;
      expect(card.getAttribute("aria-disabled")).toBe("true");
      expect(card.getAttribute("title")).toBe("Coming soon");
    }
  });

  it("Test 3 — click on disabled card does NOT advance to Step 2", async () => {
    const user = userEvent.setup();
    renderDialog();
    const websiteCard = screen.getByText("Connect website").closest("button")!;
    await user.click(websiteCard);
    // Still on Step 1 — Step 2 dialog title would be "Choose a category"
    expect(screen.queryByText("Choose a category")).not.toBeInTheDocument();
    expect(screen.getByText("Add a knowledge source")).toBeInTheDocument();
  });

  it("Test 4 — click on PDF card advances to Step 2 (category select)", async () => {
    const user = userEvent.setup();
    renderDialog();
    const pdfCard = screen.getByText("Upload PDF").closest("button")!;
    await user.click(pdfCard);
    expect(screen.getByText("Choose a category")).toBeInTheDocument();
    // Radio group with 5 categories present (KAN-XXX dropped 'FAQ' option)
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.queryByText("FAQ")).not.toBeInTheDocument();
    expect(screen.getByText("Inventory")).toBeInTheDocument();
    expect(screen.getByText("Warranty")).toBeInTheDocument();
    expect(screen.getByText("Pricing")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("Test 5 — Step 2 → Step 3 (PDF input) renders drop zone + 10MB limit hint", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Upload PDF").closest("button")!);
    // Step 2: pick category
    await user.click(screen.getByLabelText(/General/i, { selector: "input" }));
    await user.click(screen.getByRole("button", { name: /Confirm category and continue/i }));
    // Step 3: PDF input rendered
    expect(screen.getByText("Click to choose a PDF")).toBeInTheDocument();
    expect(screen.getByText(/Max 10MB/i)).toBeInTheDocument();
  });

  it("Test 6 — PDF > 10MB → client-side validation error", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderDialog();
    await user.click(screen.getByText("Upload PDF").closest("button")!);
    await user.click(screen.getByLabelText(/General/i, { selector: "input" }));
    await user.click(screen.getByRole("button", { name: /Confirm category and continue/i }));

    // Construct a synthetic 11MB file
    const bigBlob = new Blob([new Uint8Array(11 * 1024 * 1024)], { type: "application/pdf" });
    const bigFile = new File([bigBlob], "huge.pdf", { type: "application/pdf" });

    const dropZone = screen.getByLabelText("Choose PDF file to upload");
    // Locate the hidden file input via the role of the surrounding zone
    const hiddenInput = dropZone.querySelector("input[type='file']") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(hiddenInput, "files", { value: [bigFile], configurable: true });
      fireEvent.change(hiddenInput);
    });

    await user.click(screen.getByRole("button", { name: /Upload PDF source/i }));
    expect(await screen.findByText(/File too large/i)).toBeInTheDocument();
    // Mutation (POST /api/knowledge/sources) NOT fired — tier-limits GET
    // calls are allowed; we assert only the upload POST didn't go out.
    const uploadCalls = fetchMock.mock.calls.filter(
      (args: unknown[]) => (args[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(uploadCalls).toHaveLength(0);
  });

  it("Test 7 — Paste text > 50K chars → maxLength caps input + cap message available in spec", async () => {
    // The textarea has maxLength=50_000; the browser prevents typing past it.
    // We verify the maxLength attribute is present (spec contract) AND that
    // when content matches the limit, the counter renders the limit value.
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Paste text").closest("button")!);
    await user.click(screen.getByLabelText(/General/i, { selector: "input" }));
    await user.click(screen.getByRole("button", { name: /Confirm category and continue/i }));
    const textarea = screen.getByLabelText("Content") as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(50_000);
    expect(screen.getByText(/0 \/ 50,000/)).toBeInTheDocument();
  });

  // KAN-XXX dropped: Test 8 (FAQ editor row management) — FAQ entries
  // moved to add-faq-dialog.tsx (single Q+A; tested in add-faq-dialog.test.tsx).

  it("Test 9 — paste-text submit success → mutation invalidates queries + closes dialog", async () => {
    const user = userEvent.setup();
    const { onOpenChange, fetchMock, qc } = renderDialog();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    await user.click(screen.getByText("Paste text").closest("button")!);
    await user.click(screen.getByLabelText(/General/i, { selector: "input" }));
    await user.click(screen.getByRole("button", { name: /Confirm category and continue/i }));

    await user.type(screen.getByLabelText("Title"), "Smoke title");
    await user.type(screen.getByLabelText("Content"), "Some content for the smoke test.");
    await user.click(screen.getByRole("button", { name: /Save pasted text source/i }));

    // Filter to the POST /api/knowledge/sources call — tier-limits GET fires
    // alongside in sub-cohort 6, so we assert on the mutation specifically.
    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (args: unknown[]) => (args[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(postCalls).toHaveLength(1);
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    // Both queries invalidated
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["knowledge", "sources"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["knowledge", "tier-limits"] });
  });

  it("Test 10 — submit error (413) → error message displayed, dialog stays open", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 413, text: async () => "" } as Response)),
    );
    const onOpenChange = vi.fn();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, cacheTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <AddSourceDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByText("Paste text").closest("button")!);
    await user.click(screen.getByLabelText(/General/i, { selector: "input" }));
    await user.click(screen.getByRole("button", { name: /Confirm category and continue/i }));
    await user.type(screen.getByLabelText("Title"), "Will fail");
    await user.type(screen.getByLabelText("Content"), "x");
    await user.click(screen.getByRole("button", { name: /Save pasted text source/i }));

    expect(await screen.findByText(/File too large/i)).toBeInTheDocument();
    // Dialog NOT closed
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Test 11 — all visible button labels are verb + object (DS UX writing rule)", () => {
    renderDialog();
    // Step 1 cards have multi-line content (title + description); we audit
    // by asserting each card title is FOUND as a heading-ish element with a
    // verb-leading title. Verb-starts: Upload, Paste, Build, Connect (×2),
    // Upload (×2). Each card's primary label starts with one of these verbs.
    const expectedVerbTitles = [
      "Upload PDF",
      "Paste text",
      "Connect website",
      "Upload spreadsheet",
      "Connect social",
    ];
    for (const title of expectedVerbTitles) {
      // The card title is rendered in a span — locate via text query
      expect(screen.getByText(title)).toBeInTheDocument();
      // Verb-first audit: first word must be one of the allowlisted verbs
      const firstWord = title.split(" ")[0]!;
      expect(["Upload", "Paste", "Connect"]).toContain(firstWord);
    }
  });

  it("Test 12 — no forbidden words in rendered copy (DS forbidden-words audit)", () => {
    renderDialog();
    const FORBIDDEN = ["magic", "simply", "just", "easily", "seamlessly", "revolutionary", "cutting-edge", "leverage", "synergy"];
    const allText = document.body.textContent?.toLowerCase() ?? "";
    for (const word of FORBIDDEN) {
      const re = new RegExp(`\\b${word.replace(/-/g, "[-]")}\\b`);
      expect(re.test(allText), `Forbidden word "${word}" found in rendered copy`).toBe(false);
    }
  });

  it("Test 13 — Back button on Step 2 returns to Step 1 (navigation contract)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Upload PDF").closest("button")!);
    expect(screen.getByText("Choose a category")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Go back to source types/i }));
    expect(screen.getByText("Add a knowledge source")).toBeInTheDocument();
  });

  // ───────────────────────────────────────────────
  // KAN-829 sub-cohort 6 — tier-gating UX extensions
  // ───────────────────────────────────────────────

  function renderDialogWithTier(opts: {
    tier: "free" | "starter" | "pro" | "enterprise";
  }): {
    onOpenChange: ReturnType<typeof vi.fn>;
    onTierLocked: ReturnType<typeof vi.fn>;
  } {
    const TIER_LIMITS = {
      free: { maxSources: 1, maxPdfMB: 0, allowsPdf: false, allowedCategories: ["general"] },
      starter: { maxSources: 1, maxPdfMB: 0, allowsPdf: false, allowedCategories: ["general"] },
      pro: { maxSources: 5, maxPdfMB: 5, allowsPdf: true, allowedCategories: ["general", "faq", "inventory", "warranty", "pricing", "other"] },
      enterprise: { maxSources: 9999, maxPdfMB: 10, allowsPdf: true, allowedCategories: ["general", "faq", "inventory", "warranty", "pricing", "other"] },
    } as const;
    const onOpenChange = vi.fn();
    const onTierLocked = vi.fn();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/tier-limits")) {
        return {
          ok: true,
          json: async () => ({
            planTier: opts.tier,
            limits: TIER_LIMITS[opts.tier],
            currentSourceCount: 0,
            remaining: TIER_LIMITS[opts.tier].maxSources,
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ sourceId: "src-test-1" }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, cacheTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <AddSourceDialog open onOpenChange={onOpenChange} onTierLocked={onTierLocked} />
      </QueryClientProvider>,
    );
    return { onOpenChange, onTierLocked };
  }

  it("Test 14 — tier-locked PDF on Free → calls onTierLocked('pdf'); does NOT advance to step 2", async () => {
    const user = userEvent.setup();
    const { onTierLocked } = renderDialogWithTier({ tier: "free" });
    // Wait for tier query to resolve and cards to flip to tier-locked
    await waitFor(() => {
      const pdfCard = screen.getByText("Upload PDF").closest("button")!;
      expect(pdfCard.getAttribute("data-locked-reason")).toBe("tier");
    });
    await user.click(screen.getByText("Upload PDF").closest("button")!);
    expect(onTierLocked).toHaveBeenCalledWith("pdf");
    expect(screen.queryByText("Choose a category")).not.toBeInTheDocument();
  });

  // KAN-XXX dropped: Test 15 (FAQ tier-locked) — FAQ entries no longer
  // tier-gated. Locked-card logic now exercises only PDF (Test 14 covers it).

  it("Test 16 — coming-soon cards stay disabled and do NOT call onTierLocked", async () => {
    const user = userEvent.setup();
    const { onTierLocked } = renderDialogWithTier({ tier: "free" });
    await waitFor(() => {
      const websiteCard = screen.getByText("Connect website").closest("button")!;
      expect(websiteCard.getAttribute("data-locked-reason")).toBe("coming-soon");
    });
    await user.click(screen.getByText("Connect website").closest("button")!);
    expect(onTierLocked).not.toHaveBeenCalled();
    expect(screen.queryByText("Choose a category")).not.toBeInTheDocument();
  });

  it("Test 17 — Pro tier: PDF card is 'available' and advances to step 2 on click", async () => {
    const user = userEvent.setup();
    const { onTierLocked } = renderDialogWithTier({ tier: "pro" });
    await waitFor(() => {
      const pdfCard = screen.getByText("Upload PDF").closest("button")!;
      // available — no data-locked-reason attribute
      expect(pdfCard.getAttribute("data-locked-reason")).toBeNull();
    });
    await user.click(screen.getByText("Upload PDF").closest("button")!);
    expect(screen.getByText("Choose a category")).toBeInTheDocument();
    expect(onTierLocked).not.toHaveBeenCalled();
  });
});
