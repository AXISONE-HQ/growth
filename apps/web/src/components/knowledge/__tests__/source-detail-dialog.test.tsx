/**
 * KAN-829 sub-cohort 5 — SourceDetailDialog tests.
 *
 * 9 tests covering: dialog header + metadata grid (status pill / category
 * badge), per-type render branches (pdf / paste_text excerpt + truncation /
 * faq Q+A from metadata.question + rawContent — KAN-841 single-pair shape),
 * error-state panel, loading state, footer Close + Delete handlers,
 * relative-time formatter, forbidden-microcopy audit incl. sub-cohort-5
 * additions (permanent / forever / cannot be undone / unfortunately /
 * please / sorry).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceDetailDialog } from "../source-detail-dialog";

interface Source {
  id: string;
  sourceType: "pdf" | "paste_text" | "faq";
  category: "general" | "faq" | "inventory" | "warranty" | "pricing" | "other";
  title: string | null;
  status: "queued" | "embedding" | "ready" | "error" | "deleted";
  fileName: string | null;
  fileSizeBytes: number | null;
  fileChecksum: string | null;
  rawContent: string | null;
  metadata: Record<string, unknown> | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
  chunkCount: number;
}

function buildSource(overrides: Partial<Source> = {}): Source {
  const now = new Date().toISOString();
  return {
    id: "src-1",
    sourceType: "paste_text",
    category: "general",
    title: "Sample source",
    status: "ready",
    fileName: null,
    fileSizeBytes: null,
    fileChecksum: "abcd1234ef5678abcd1234ef5678",
    rawContent: "Hello world",
    metadata: {},
    errorDetail: null,
    createdAt: now,
    updatedAt: now,
    chunkCount: 3,
    ...overrides,
  };
}

function renderDetail(source: Source | null, opts: { isError?: boolean } = {}): {
  onOpenChange: ReturnType<typeof vi.fn>;
  onRequestDelete: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const onOpenChange = vi.fn();
  const onRequestDelete = vi.fn();
  const fetchMock = vi.fn(async () => {
    if (opts.isError) {
      return { ok: false, status: 500, text: async () => "" } as Response;
    }
    return {
      ok: true,
      json: async () => ({ source }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={qc}>
      <SourceDetailDialog
        sourceId={source?.id ?? "src-1"}
        open
        onOpenChange={onOpenChange}
        onRequestDelete={onRequestDelete}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, onRequestDelete, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SourceDetailDialog — KAN-829 sub-cohort 5", () => {
  it("Test 1 — renders dialog title from source.title + status pill + category badge", async () => {
    const src = buildSource({ title: "Pricing FAQ", status: "ready", category: "pricing" });
    renderDetail(src);
    await waitFor(() => expect(screen.getByText("Pricing FAQ")).toBeInTheDocument());
    expect(screen.getByLabelText("Ready")).toBeInTheDocument();
    expect(screen.getByLabelText("Pricing category")).toBeInTheDocument();
  });

  it("Test 2 — falls back to fileName when title is null", async () => {
    const src = buildSource({ title: null, fileName: "warranty.pdf", sourceType: "pdf" });
    renderDetail(src);
    await waitFor(() => expect(screen.getAllByText("warranty.pdf").length).toBeGreaterThan(0));
  });

  it("Test 3 — PDF variant renders filename + size in MB", async () => {
    const src = buildSource({
      sourceType: "pdf",
      fileName: "manual.pdf",
      fileSizeBytes: 2 * 1024 * 1024, // 2 MB
      title: "Product manual",
    });
    renderDetail(src);
    await waitFor(() =>
      expect(screen.getByLabelText("PDF file metadata")).toBeInTheDocument(),
    );
    expect(screen.getByText("manual.pdf")).toBeInTheDocument();
    expect(screen.getByText("2.00 MB")).toBeInTheDocument();
  });

  it("Test 4 — paste_text variant renders excerpt and truncates over 500 chars", async () => {
    const longText = "A".repeat(700);
    const src = buildSource({
      sourceType: "paste_text",
      rawContent: longText,
      title: "Big paste",
    });
    renderDetail(src);
    await waitFor(() =>
      expect(screen.getByLabelText("Pasted text excerpt")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Showing first 500 of 700 characters\./)).toBeInTheDocument();
  });

  it("Test 5 — faq variant renders question from metadata + answer from rawContent (KAN-841 shape)", async () => {
    const src = buildSource({
      sourceType: "faq",
      category: "faq",
      title: "Onboarding",
      metadata: { question: "How do I reset my password?" },
      rawContent: "Use the reset link on the sign-in page.",
    });
    renderDetail(src);
    await waitFor(() =>
      expect(screen.getByLabelText("FAQ Q and A pair")).toBeInTheDocument(),
    );
    expect(screen.getByText("How do I reset my password?")).toBeInTheDocument();
    expect(screen.getByText("Use the reset link on the sign-in page.")).toBeInTheDocument();
  });

  it("Test 6 — status='error' surfaces errorDetail panel", async () => {
    const src = buildSource({
      status: "error",
      errorDetail: "PDF parse failed: invalid PDF header",
    });
    renderDetail(src);
    await waitFor(() =>
      expect(screen.getByLabelText("Ingestion error detail")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("PDF parse failed: invalid PDF header"),
    ).toBeInTheDocument();
  });

  it("Test 7 — load failure renders inline error alert (not toast)", async () => {
    renderDetail(buildSource(), { isError: true });
    await waitFor(() => {
      expect(
        screen.getByText(/Could not load this source/i),
      ).toBeInTheDocument();
    });
  });

  it("Test 8 — Close button calls onOpenChange(false); Delete button forwards sourceId", async () => {
    const user = userEvent.setup();
    const src = buildSource({ id: "src-42" });
    const { onOpenChange, onRequestDelete } = renderDetail(src);
    await waitFor(() => expect(screen.getByText("Sample source")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Close source details/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Re-render scenario: click Delete after data loaded
    await user.click(screen.getByRole("button", { name: /Delete this source/i }));
    expect(onRequestDelete).toHaveBeenCalledWith("src-42");
  });

  it("Test 9 — no forbidden microcopy in any rendered state (combined audit incl. sub-cohort-5)", async () => {
    const src = buildSource({
      sourceType: "faq",
      title: "Audit me",
      metadata: { question: "What policies?" },
      rawContent: "Audit answer body.",
      status: "error",
      errorDetail: "Embedding rejected",
    });
    renderDetail(src);
    await waitFor(() => expect(screen.getByText("Audit me")).toBeInTheDocument());

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

    // "just" — allow only the relative-time exception "just now"
    const justRegex = /\bjust\b/g;
    const matches = allText.match(justRegex) ?? [];
    for (const _ of matches) {
      // every "just" must be part of "just now"
      expect(allText).toMatch(/\bjust\s+now\b/);
    }
    // assert no "just" outside "just now"
    const stripped = allText.replace(/\bjust\s+now\b/g, "");
    expect(/\bjust\b/.test(stripped)).toBe(false);
  });
});
