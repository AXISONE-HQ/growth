// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge Sources page (KAN-829), future Sprint 12+ extension surfaces

/**
 * AddSourceDialog — multi-step Add Source flow for the Knowledge Sources
 * admin UI. Step 1 (choose type) → Step 2 (choose category) → Step 3
 * (per-type input). Submit fires a TanStack Query mutation that POSTs to
 * `/api/knowledge/sources`, then invalidates the sources + tier-limits
 * queries on success.
 *
 * **DS v1 compliance:**
 *  - All colors via `--ds-*` tokens (audited in test 11)
 *  - Composes shadcn primitives (Dialog, Button, Input, Textarea, Label,
 *    Progress) + new components from sub-cohorts 2/3 + this cohort
 *  - Sentence case + verb+object button labels
 *  - Forbidden-words audit (test 12) — "magic / simply / just / easily /
 *    seamlessly / revolutionary / cutting-edge / leverage / synergy" — none
 *  - Disabled cards aria-disabled + title attribute
 *  - Color paired with text label on every status (no color-only signals)
 *
 * **Validation (per architect spec + KAN-827 endpoint contract):**
 *  - PDF: required, ≤10MB, .pdf extension, application/pdf MIME
 *  - Paste-text title: 1-200 chars; rawContent: 1-50,000 chars
 *  - FAQ title: 1-200 chars; entries: ≥1; per-entry Q 1-2k, A 1-10k
 *  - Category: required; one of 6 canonical values
 *
 * Client-side validation prevents submit; server is source-of-truth and
 * re-validates on POST.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { FileText, Upload, MessageSquare, Globe, Table as TableIcon, Share2 } from "lucide-react";
import { SourceTypeCard } from "./source-type-card";
import { FAQEditor, type FAQEntry } from "./faq-editor";
import { API_BASE, buildHeaders } from "@/lib/api";

interface TierLimitsResponse {
  planTier: string;
  limits: {
    maxSources: number;
    maxPdfMB: number;
    allowsPdf: boolean;
    allowsFaq: boolean;
    allowedCategories: string[];
  };
  currentSourceCount: number;
  remaining: number;
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type SourceType = "pdf" | "paste_text" | "faq" | "website" | "spreadsheet" | "social";
type Category = "general" | "faq" | "inventory" | "warranty" | "pricing" | "other";
type Step = "choose-type" | "choose-category" | "pdf-input" | "paste-text-input" | "faq-input";

interface AddSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired when the operator clicks a tier-locked card (PDF or FAQ on a tier
   * that doesn't include them). The parent should close this dialog and open
   * the UpgradePromptDialog. Optional — when omitted (e.g., legacy callers
   * pre-cohort-6), tier-locked cards still render the lock treatment but
   * clicking is a no-op.
   */
  onTierLocked?: (feature: "pdf" | "faq") => void;
}

// ─────────────────────────────────────────────
// Constants — limits per architect spec + UX writing
// ─────────────────────────────────────────────

const PDF_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const PASTE_TEXT_MAX = 50_000;
const TITLE_MAX = 200;

const CATEGORY_OPTIONS: Array<{ value: Category; label: string; hint: string }> = [
  { value: "general", label: "General", hint: "Company description, mission, anything broad" },
  { value: "faq", label: "FAQ", hint: "Common questions and how the AI should answer them" },
  { value: "inventory", label: "Inventory", hint: "Product catalog, stock levels, SKU details" },
  { value: "warranty", label: "Warranty", hint: "Policy text, claim instructions, coverage windows" },
  { value: "pricing", label: "Pricing", hint: "Pricing sheets, discounts, tier definitions" },
  { value: "other", label: "Other", hint: "Anything that doesn't fit the categories above" },
];

// ─────────────────────────────────────────────
// Top-level dialog
// ─────────────────────────────────────────────

export function AddSourceDialog({
  open,
  onOpenChange,
  onTierLocked,
}: AddSourceDialogProps): React.ReactElement {
  const [step, setStep] = React.useState<Step>("choose-type");
  const [selectedType, setSelectedType] = React.useState<SourceType | null>(null);
  const [selectedCategory, setSelectedCategory] = React.useState<Category | null>(null);

  // Tier-limits query — same key as source-list.tsx so TanStack Query
  // dedupes the cache entry. Loading state falls through to "available"
  // for all cards (server enforces 403 on disallowed feature attempts).
  const tierQuery = useQuery<TierLimitsResponse>({
    queryKey: ["knowledge", "tier-limits"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/knowledge/tier-limits`, {
        headers: await buildHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as TierLimitsResponse;
    },
    enabled: open, // only fetch when dialog opens
  });
  const tierLimits = tierQuery.data?.limits ?? null;

  // Per-type form state
  const [pdfFile, setPdfFile] = React.useState<File | null>(null);
  const [pdfTitle, setPdfTitle] = React.useState("");
  const [pasteTitle, setPasteTitle] = React.useState("");
  const [pasteContent, setPasteContent] = React.useState("");
  const [faqTitle, setFaqTitle] = React.useState("");
  const [faqEntries, setFaqEntries] = React.useState<FAQEntry[]>([{ question: "", answer: "" }]);

  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const queryClient = useQueryClient();

  const resetState = React.useCallback(() => {
    setStep("choose-type");
    setSelectedType(null);
    setSelectedCategory(null);
    setPdfFile(null);
    setPdfTitle("");
    setPasteTitle("");
    setPasteContent("");
    setFaqTitle("");
    setFaqEntries([{ question: "", answer: "" }]);
    setErrorMessage(null);
  }, []);

  const handleClose = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) resetState();
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetState],
  );

  // Mutation — accepts FormData (PDF) or JSON body (paste / faq)
  const mutation = useMutation({
    mutationFn: async (input:
      | { kind: "pdf"; body: FormData }
      | { kind: "json"; body: Record<string, unknown> }
    ): Promise<{ sourceId: string }> => {
      // FormData: omit Content-Type so the browser sets the multipart
      // boundary itself. JSON: buildHeaders sets application/json by default.
      const headers = await buildHeaders(
        input.kind === "pdf" ? { omitContentType: true } : undefined,
      );
      const init: RequestInit = {
        method: "POST",
        headers,
        body: input.kind === "pdf" ? input.body : JSON.stringify(input.body),
      };
      const res = await fetch(`${API_BASE}/api/knowledge/sources`, init);
      if (!res.ok) {
        // Map server status → user-friendly message
        const fallback = (await res.text()) || `HTTP ${res.status}`;
        let userMessage: string;
        switch (res.status) {
          case 413:
            userMessage = "File too large. Max 10MB per PDF.";
            break;
          case 415:
            userMessage = "Unsupported file type. PDF only.";
            break;
          case 400:
            userMessage = `Invalid request: ${fallback}`;
            break;
          case 401:
          case 403:
            userMessage = "Sign in expired. Please refresh and try again.";
            break;
          default:
            userMessage = "Something went wrong. Please try again.";
        }
        throw new Error(userMessage);
      }
      return (await res.json()) as { sourceId: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "sources"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "tier-limits"] });
      handleClose(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  // ─────────────────────────────────────────────
  // Step 1 — choose type
  // ─────────────────────────────────────────────

  const handleTypeSelect = (type: SourceType) => {
    setSelectedType(type);
    setStep("choose-category");
  };

  // ─────────────────────────────────────────────
  // Step 2 → Step 3 transition
  // ─────────────────────────────────────────────

  const handleCategoryConfirm = () => {
    if (!selectedCategory || !selectedType) return;
    if (selectedType === "pdf") setStep("pdf-input");
    else if (selectedType === "paste_text") setStep("paste-text-input");
    else if (selectedType === "faq") setStep("faq-input");
  };

  // ─────────────────────────────────────────────
  // Step 3 — submit handlers per source type
  // ─────────────────────────────────────────────

  const submitPdf = () => {
    setErrorMessage(null);
    if (!pdfFile) {
      setErrorMessage("Please choose a PDF file.");
      return;
    }
    if (pdfFile.size > PDF_MAX_BYTES) {
      setErrorMessage("File too large. Max 10MB per PDF.");
      return;
    }
    if (!pdfFile.name.toLowerCase().endsWith(".pdf")) {
      setErrorMessage("Unsupported file type. PDF only.");
      return;
    }
    if (!selectedCategory) return;
    const fd = new FormData();
    fd.append("file", pdfFile);
    fd.append("category", selectedCategory);
    if (pdfTitle.trim()) fd.append("title", pdfTitle.trim());
    mutation.mutate({ kind: "pdf", body: fd });
  };

  const submitPasteText = () => {
    setErrorMessage(null);
    if (!pasteTitle.trim()) {
      setErrorMessage("Title is required.");
      return;
    }
    if (pasteTitle.length > TITLE_MAX) {
      setErrorMessage(`Title is too long (max ${TITLE_MAX} chars).`);
      return;
    }
    if (!pasteContent.trim()) {
      setErrorMessage("Content is required.");
      return;
    }
    if (pasteContent.length > PASTE_TEXT_MAX) {
      setErrorMessage(`Content exceeds ${PASTE_TEXT_MAX.toLocaleString()} characters.`);
      return;
    }
    if (!selectedCategory) return;
    mutation.mutate({
      kind: "json",
      body: {
        sourceType: "paste_text",
        category: selectedCategory,
        title: pasteTitle.trim(),
        rawContent: pasteContent,
      },
    });
  };

  const submitFaq = () => {
    setErrorMessage(null);
    if (!faqTitle.trim()) {
      setErrorMessage("Title is required.");
      return;
    }
    if (faqEntries.length === 0) {
      setErrorMessage("Add at least one Q+A entry.");
      return;
    }
    for (const [i, e] of faqEntries.entries()) {
      if (!e.question.trim()) {
        setErrorMessage(`Entry ${i + 1}: question is required.`);
        return;
      }
      if (!e.answer.trim()) {
        setErrorMessage(`Entry ${i + 1}: answer is required.`);
        return;
      }
    }
    if (!selectedCategory) return;
    mutation.mutate({
      kind: "json",
      body: {
        sourceType: "faq",
        category: selectedCategory,
        title: faqTitle.trim(),
        faqEntries,
      },
    });
  };

  // ─────────────────────────────────────────────
  // Render — dispatches by step
  // ─────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{stepTitle(step)}</DialogTitle>
          <DialogDescription>{stepDescription(step)}</DialogDescription>
        </DialogHeader>

        {step === "choose-type" ? (
          <Step1ChooseType
            onSelect={handleTypeSelect}
            tierLimits={tierLimits}
            onTierLocked={onTierLocked}
          />
        ) : null}

        {step === "choose-category" ? (
          <Step2ChooseCategory
            selected={selectedCategory}
            onSelect={setSelectedCategory}
            onBack={() => setStep("choose-type")}
            onConfirm={handleCategoryConfirm}
          />
        ) : null}

        {step === "pdf-input" ? (
          <Step3PdfInput
            file={pdfFile}
            onFileChange={setPdfFile}
            title={pdfTitle}
            onTitleChange={setPdfTitle}
            error={errorMessage}
            uploading={mutation.isPending}
            onBack={() => setStep("choose-category")}
            onSubmit={submitPdf}
          />
        ) : null}

        {step === "paste-text-input" ? (
          <Step3PasteText
            title={pasteTitle}
            onTitleChange={setPasteTitle}
            content={pasteContent}
            onContentChange={setPasteContent}
            error={errorMessage}
            submitting={mutation.isPending}
            onBack={() => setStep("choose-category")}
            onSubmit={submitPasteText}
          />
        ) : null}

        {step === "faq-input" ? (
          <Step3FaqInput
            title={faqTitle}
            onTitleChange={setFaqTitle}
            entries={faqEntries}
            onEntriesChange={setFaqEntries}
            error={errorMessage}
            submitting={mutation.isPending}
            onBack={() => setStep("choose-category")}
            onSubmit={submitFaq}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────
// Step copy helpers
// ─────────────────────────────────────────────

function stepTitle(step: Step): string {
  switch (step) {
    case "choose-type":
      return "Add a knowledge source";
    case "choose-category":
      return "Choose a category";
    case "pdf-input":
      return "Upload PDF";
    case "paste-text-input":
      return "Paste text";
    case "faq-input":
      return "Build your FAQ";
  }
}

function stepDescription(step: Step): string {
  switch (step) {
    case "choose-type":
      return "Pick how you want to bring knowledge into the AI.";
    case "choose-category":
      return "Categories help the AI rank which content is most relevant per question.";
    case "pdf-input":
      return "Drop a PDF up to 10MB. The AI will chunk and embed it within seconds.";
    case "paste-text-input":
      return "Paste up to 50,000 characters. Use this for company descriptions or internal notes.";
    case "faq-input":
      return "Add Q+A pairs the AI can cite directly. Each pair becomes one retrievable chunk.";
  }
}

// ─────────────────────────────────────────────
// Step 1 — 6-card grid (3 functional, 3 disabled)
// ─────────────────────────────────────────────

// Card config — drives state derivation per current tier limits. `feature`
// links a card to the tier-flag it depends on; `notImplemented` flags cards
// whose backend doesn't exist yet (web/spreadsheet/social).
interface CardConfig {
  type: SourceType;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** Tier feature this card requires; undefined = always available when implemented. */
  feature?: "pdf" | "faq";
  notImplemented?: boolean;
  comingSoonHint?: string;
}

const CARD_CONFIGS: CardConfig[] = [
  {
    type: "pdf",
    title: "Upload PDF",
    description: "Product overviews, pricing sheets, warranty docs, manuals",
    icon: FileText,
    feature: "pdf",
  },
  {
    type: "paste_text",
    title: "Paste text",
    description: "Company description, internal notes, FAQ content",
    icon: Upload,
  },
  {
    type: "faq",
    title: "Build FAQ",
    description: "Question + answer pairs the AI can cite directly",
    icon: MessageSquare,
    feature: "faq",
  },
  {
    type: "website",
    title: "Connect website",
    description: "Crawl your marketing site or product pages",
    icon: Globe,
    notImplemented: true,
    comingSoonHint: "Coming soon",
  },
  {
    type: "spreadsheet",
    title: "Upload spreadsheet",
    description: "Products and pricing from XLSX or CSV",
    icon: TableIcon,
    notImplemented: true,
    comingSoonHint: "Coming soon",
  },
  {
    type: "social",
    title: "Connect social",
    description: "LinkedIn, X, Facebook (one platform at a time)",
    icon: Share2,
    notImplemented: true,
    comingSoonHint: "Coming soon",
  },
];

type CardState = "available" | "tier-locked" | "coming-soon";

function deriveCardState(
  card: CardConfig,
  limits: { allowsPdf: boolean; allowsFaq: boolean } | null,
): CardState {
  if (card.notImplemented) return "coming-soon";
  // Loading state (limits === null) falls through to "available" — server
  // enforces 403 if the operator pushes through; better than a flicker of
  // tier-locked treatment that clears once the query resolves.
  if (!limits) return "available";
  if (card.feature === "pdf" && !limits.allowsPdf) return "tier-locked";
  if (card.feature === "faq" && !limits.allowsFaq) return "tier-locked";
  return "available";
}

function Step1ChooseType({
  onSelect,
  tierLimits,
  onTierLocked,
}: {
  onSelect: (t: SourceType) => void;
  tierLimits: { allowsPdf: boolean; allowsFaq: boolean } | null;
  onTierLocked?: (feature: "pdf" | "faq") => void;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3 py-2">
      {CARD_CONFIGS.map((card) => {
        const state = deriveCardState(card, tierLimits);
        const lockedReason = state === "available" ? undefined : state === "tier-locked" ? "tier" : "coming-soon";
        const handleClick = () => {
          if (state === "available") {
            // SourceType narrowing — the available branch only fires for
            // implemented types (pdf / paste_text / faq).
            onSelect(card.type);
          } else if (state === "tier-locked" && card.feature) {
            onTierLocked?.(card.feature);
          }
          // coming-soon: no-op
        };
        return (
          <SourceTypeCard
            key={card.type}
            title={card.title}
            description={card.description}
            icon={card.icon}
            lockedReason={lockedReason}
            comingSoonHint={card.comingSoonHint}
            onClick={handleClick}
          />
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Step 2 — category radio group
// ─────────────────────────────────────────────

function Step2ChooseCategory({
  selected,
  onSelect,
  onBack,
  onConfirm,
}: {
  selected: Category | null;
  onSelect: (c: Category) => void;
  onBack: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  return (
    <>
      <div role="radiogroup" aria-label="Source category" className="flex flex-col gap-2 py-2">
        {CATEGORY_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
            style={{
              backgroundColor:
                selected === opt.value ? "var(--ds-violet-100)" : "var(--ds-surface-base)",
              borderColor:
                selected === opt.value
                  ? "color-mix(in srgb, var(--ds-violet-500) 30%, transparent)"
                  : "var(--ds-border-subtle)",
            }}
          >
            <input
              type="radio"
              name="category"
              value={opt.value}
              checked={selected === opt.value}
              onChange={() => onSelect(opt.value)}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div
                className="text-sm font-medium"
                style={{ color: "var(--ds-ink-secondary)" }}
              >
                {opt.label}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--ds-ink-tertiary)" }}>
                {opt.hint}
              </div>
            </div>
          </label>
        ))}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} aria-label="Go back to source types">
          Back
        </Button>
        <Button
          onClick={onConfirm}
          disabled={!selected}
          aria-label="Confirm category and continue"
        >
          Continue
        </Button>
      </DialogFooter>
    </>
  );
}

// ─────────────────────────────────────────────
// Step 3 — PDF input
// ─────────────────────────────────────────────

function Step3PdfInput({
  file,
  onFileChange,
  title,
  onTitleChange,
  error,
  uploading,
  onBack,
  onSubmit,
}: {
  file: File | null;
  onFileChange: (f: File | null) => void;
  title: string;
  onTitleChange: (t: string) => void;
  error: string | null;
  uploading: boolean;
  onBack: () => void;
  onSubmit: () => void;
}): React.ReactElement {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  return (
    <>
      <div className="flex flex-col gap-3 py-2">
        <div
          className="flex flex-col items-center text-center py-8 px-6 rounded-lg border-2 border-dashed cursor-pointer"
          style={{
            backgroundColor: "var(--ds-surface-sunken)",
            borderColor: "var(--ds-border-default)",
          }}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
          }}
          role="button"
          tabIndex={0}
          aria-label="Choose PDF file to upload"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <>
              <p className="text-sm font-medium" style={{ color: "var(--ds-ink-secondary)" }}>
                {file.name}
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--ds-ink-tertiary)" }}>
                {(file.size / 1024 / 1024).toFixed(2)} MB
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFileChange(null);
                }}
                className="text-xs mt-2 underline"
                style={{ color: "var(--ds-ink-secondary)" }}
                aria-label="Remove selected file"
              >
                Remove file
              </button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium" style={{ color: "var(--ds-ink-secondary)" }}>
                Click to choose a PDF
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--ds-ink-tertiary)" }}>
                Max 10MB. PDF only.
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="pdf-title">Title (optional)</Label>
          <Input
            id="pdf-title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Defaults to the filename"
            maxLength={TITLE_MAX}
          />
        </div>

        {uploading ? <Progress value={50} aria-label="Uploading" /> : null}
        {error ? (
          <p
            role="alert"
            className="text-xs"
            style={{ color: "var(--ds-danger-text)" }}
          >
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} aria-label="Go back to category">
          Back
        </Button>
        <Button
          onClick={onSubmit}
          disabled={!file || uploading}
          aria-label="Upload PDF source"
        >
          {uploading ? "Uploading…" : "Upload PDF"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ─────────────────────────────────────────────
// Step 3 — Paste text input
// ─────────────────────────────────────────────

function Step3PasteText({
  title,
  onTitleChange,
  content,
  onContentChange,
  error,
  submitting,
  onBack,
  onSubmit,
}: {
  title: string;
  onTitleChange: (t: string) => void;
  content: string;
  onContentChange: (c: string) => void;
  error: string | null;
  submitting: boolean;
  onBack: () => void;
  onSubmit: () => void;
}): React.ReactElement {
  const isApproachingLimit = content.length >= 45_000;
  return (
    <>
      <div className="flex flex-col gap-3 py-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="paste-title">Title</Label>
          <Input
            id="paste-title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Short, descriptive title"
            maxLength={TITLE_MAX}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="paste-content">Content</Label>
          <Textarea
            id="paste-content"
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            maxLength={PASTE_TEXT_MAX}
            rows={10}
            placeholder="Paste up to 50,000 characters"
          />
          <span
            className="text-xs"
            style={{
              color: isApproachingLimit
                ? "var(--ds-warning-text)"
                : "var(--ds-ink-tertiary)",
            }}
          >
            {content.length.toLocaleString()} / {PASTE_TEXT_MAX.toLocaleString()}
          </span>
        </div>
        {error ? (
          <p role="alert" className="text-xs" style={{ color: "var(--ds-danger-text)" }}>
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} aria-label="Go back to category">
          Back
        </Button>
        <Button
          onClick={onSubmit}
          disabled={!title.trim() || !content.trim() || submitting}
          aria-label="Save pasted text source"
        >
          {submitting ? "Saving…" : "Save source"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ─────────────────────────────────────────────
// Step 3 — FAQ input
// ─────────────────────────────────────────────

function Step3FaqInput({
  title,
  onTitleChange,
  entries,
  onEntriesChange,
  error,
  submitting,
  onBack,
  onSubmit,
}: {
  title: string;
  onTitleChange: (t: string) => void;
  entries: FAQEntry[];
  onEntriesChange: (e: FAQEntry[]) => void;
  error: string | null;
  submitting: boolean;
  onBack: () => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="flex flex-col gap-4 py-2 max-h-[60vh] overflow-y-auto">
        <div className="flex flex-col gap-2">
          <Label htmlFor="faq-title">FAQ title</Label>
          <Input
            id="faq-title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="e.g., Customer onboarding FAQ"
            maxLength={TITLE_MAX}
          />
        </div>
        <FAQEditor entries={entries} onChange={onEntriesChange} />
        {error ? (
          <p role="alert" className="text-xs" style={{ color: "var(--ds-danger-text)" }}>
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} aria-label="Go back to category">
          Back
        </Button>
        <Button
          onClick={onSubmit}
          disabled={!title.trim() || submitting}
          aria-label="Save FAQ source"
        >
          {submitting ? "Saving…" : "Save FAQ"}
        </Button>
      </DialogFooter>
    </>
  );
}
