// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge Sources admin page (KAN-829), reused by Sprint 12+ surfaces

/**
 * SourceDetailDialog — read-only inspector for a single knowledge source.
 *
 * Loads the source by id via TanStack Query (`/api/knowledge/sources/:id`)
 * and renders:
 *  - Header: title with paired status pill + category badge
 *  - Metadata grid: type, added/updated relative-time, chunk count, checksum
 *  - Per-type extras:
 *      pdf        → filename + size (MB)
 *      paste_text → rawContent excerpt (first 500 chars, "..." overflow)
 *      faq        → Question (metadata.question) + Answer (rawContent)
 *  - Error detail panel when status='error'
 *  - Footer: Close + Delete (Delete forwards to onRequestDelete)
 *
 * **DS v1 compliance:**
 *  - All colors via `--ds-*` tokens (zero hex)
 *  - Composes shadcn Dialog + new StatusPill / CategoryBadge primitives
 *  - Sentence case + verb+object button labels
 *  - Forbidden-words audit (combined-microcopy test) — none present
 *
 * **KAN-841 hand-off (FAQ multi-pair contract):** the FAQ render path uses
 * the legacy single-pair shape (`metadata.question` + `rawContent`) since
 * the server's `FaqIngestBodySchema` and the persistence layer still write
 * one pair per row. KAN-841 will switch the contract to
 * `metadata.faqEntries[]` + multi-row rendering; this component will need
 * a small render-branch update at that point.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusPill, type StatusPillStatus } from "@/components/ui/knowledge/status-pill";
import { CategoryBadge, type Category } from "@/components/ui/knowledge/category-badge";
import { API_BASE, buildHeaders } from "@/lib/api";

interface SourceDetail {
  id: string;
  sourceType: "pdf" | "paste_text" | "faq" | "website" | "spreadsheet" | "social";
  category: Category;
  title: string | null;
  status: StatusPillStatus;
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

interface SourceDetailDialogProps {
  sourceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestDelete: (sourceId: string) => void;
}

const PASTE_EXCERPT_CHARS = 500;

export function SourceDetailDialog({
  sourceId,
  open,
  onOpenChange,
  onRequestDelete,
}: SourceDetailDialogProps): React.ReactElement {
  const detailQuery = useQuery<{ source: SourceDetail }>({
    queryKey: ["knowledge", "source-detail", sourceId],
    enabled: open && Boolean(sourceId),
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/knowledge/sources/${sourceId}`, {
        headers: await buildHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { source: SourceDetail };
    },
  });

  const source = detailQuery.data?.source;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {source?.title ?? source?.fileName ?? "Source details"}
          </DialogTitle>
          <DialogDescription>
            {source ? sourceTypeLabel(source.sourceType) : "Loading source"}
          </DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <p className="text-sm py-4" style={{ color: "var(--ds-ink-tertiary)" }}>
            Loading source details…
          </p>
        ) : detailQuery.isError ? (
          <p
            role="alert"
            className="text-sm py-4 px-3 rounded-md border"
            style={{
              backgroundColor: "var(--ds-danger-soft)",
              color: "var(--ds-danger-text)",
              borderColor: "var(--ds-danger)",
            }}
          >
            Could not load this source. Try closing and reopening this view.
          </p>
        ) : source ? (
          <div className="flex flex-col gap-4 py-2">
            <MetadataGrid source={source} />
            <PerTypeExtras source={source} />
            {source.errorDetail ? <ErrorPanel detail={source.errorDetail} /> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            aria-label="Close source details"
          >
            Close
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (source) onRequestDelete(source.id);
            }}
            disabled={!source}
            aria-label="Delete this source"
            style={{
              borderColor: "var(--ds-danger)",
              color: "var(--ds-danger-text)",
            }}
          >
            Delete source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────
// Metadata grid — status, category, type, timestamps, chunks, checksum
// ─────────────────────────────────────────────

function MetadataGrid({ source }: { source: SourceDetail }): React.ReactElement {
  return (
    <dl
      className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 rounded-lg border"
      style={{
        backgroundColor: "var(--ds-surface-sunken)",
        borderColor: "var(--ds-border-subtle)",
      }}
    >
      <Row label="Status">
        <StatusPill status={source.status} />
      </Row>
      <Row label="Category">
        <CategoryBadge category={source.category} />
      </Row>
      <Row label="Type">
        <span className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
          {sourceTypeLabel(source.sourceType)}
        </span>
      </Row>
      <Row label="Chunks">
        <span className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
          {source.chunkCount}
        </span>
      </Row>
      <Row label="Added">
        <span className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
          {relativeTime(new Date(source.createdAt))}
        </span>
      </Row>
      <Row label="Last updated">
        <span className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
          {relativeTime(new Date(source.updatedAt))}
        </span>
      </Row>
      {source.fileChecksum ? (
        <Row label="Checksum">
          <span
            className="text-xs font-mono"
            style={{ color: "var(--ds-ink-tertiary)" }}
            title={source.fileChecksum}
          >
            {source.fileChecksum.slice(0, 12)}…
          </span>
        </Row>
      ) : null}
    </dl>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <dt
        className="text-xs font-medium uppercase tracking-wide"
        style={{ color: "var(--ds-ink-tertiary)" }}
      >
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

// ─────────────────────────────────────────────
// Per-type extras — pdf / paste_text / faq render branches
// ─────────────────────────────────────────────

function PerTypeExtras({ source }: { source: SourceDetail }): React.ReactElement | null {
  if (source.sourceType === "pdf") {
    return (
      <section
        className="rounded-lg border p-4"
        style={{
          backgroundColor: "var(--ds-surface-base)",
          borderColor: "var(--ds-border-subtle)",
        }}
        aria-label="PDF file metadata"
      >
        <h3
          className="text-xs font-medium uppercase tracking-wide mb-2"
          style={{ color: "var(--ds-ink-tertiary)" }}
        >
          File
        </h3>
        <p className="text-sm font-medium" style={{ color: "var(--ds-ink-secondary)" }}>
          {source.fileName ?? "(no filename)"}
        </p>
        {source.fileSizeBytes !== null ? (
          <p className="text-xs mt-1" style={{ color: "var(--ds-ink-tertiary)" }}>
            {(source.fileSizeBytes / 1024 / 1024).toFixed(2)} MB
          </p>
        ) : null}
      </section>
    );
  }

  if (source.sourceType === "paste_text") {
    const content = source.rawContent ?? "";
    const truncated = content.length > PASTE_EXCERPT_CHARS;
    const excerpt = truncated ? `${content.slice(0, PASTE_EXCERPT_CHARS)}…` : content;
    return (
      <section
        className="rounded-lg border p-4"
        style={{
          backgroundColor: "var(--ds-surface-base)",
          borderColor: "var(--ds-border-subtle)",
        }}
        aria-label="Pasted text excerpt"
      >
        <h3
          className="text-xs font-medium uppercase tracking-wide mb-2"
          style={{ color: "var(--ds-ink-tertiary)" }}
        >
          Content excerpt
        </h3>
        <p
          className="text-sm whitespace-pre-wrap"
          style={{ color: "var(--ds-ink-secondary)" }}
        >
          {excerpt || "(empty)"}
        </p>
        {truncated ? (
          <p className="text-xs mt-2" style={{ color: "var(--ds-ink-tertiary)" }}>
            Showing first {PASTE_EXCERPT_CHARS} of {content.length.toLocaleString()} characters.
          </p>
        ) : null}
      </section>
    );
  }

  if (source.sourceType === "faq") {
    // Single Q/A render — multi-pair contract pending KAN-841.
    // metadata.question + rawContent is the legacy shape; will switch to
    // metadata.faqEntries[] when KAN-841 ships.
    const question =
      typeof source.metadata?.question === "string" ? source.metadata.question : "";
    const answer = source.rawContent ?? "";
    return (
      <section
        className="rounded-lg border p-4 flex flex-col gap-3"
        style={{
          backgroundColor: "var(--ds-surface-base)",
          borderColor: "var(--ds-border-subtle)",
        }}
        aria-label="FAQ Q and A pair"
      >
        <div>
          <h3
            className="text-xs font-medium uppercase tracking-wide mb-1"
            style={{ color: "var(--ds-ink-tertiary)" }}
          >
            Question
          </h3>
          <p className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
            {question || "(no question)"}
          </p>
        </div>
        <div>
          <h3
            className="text-xs font-medium uppercase tracking-wide mb-1"
            style={{ color: "var(--ds-ink-tertiary)" }}
          >
            Answer
          </h3>
          <p
            className="text-sm whitespace-pre-wrap"
            style={{ color: "var(--ds-ink-secondary)" }}
          >
            {answer || "(no answer)"}
          </p>
        </div>
      </section>
    );
  }

  return null;
}

// ─────────────────────────────────────────────
// Error panel — surfaces ingestion errorDetail (status='error' rows)
// ─────────────────────────────────────────────

function ErrorPanel({ detail }: { detail: string }): React.ReactElement {
  return (
    <section
      role="alert"
      aria-label="Ingestion error detail"
      className="rounded-lg border p-4"
      style={{
        backgroundColor: "var(--ds-danger-soft)",
        color: "var(--ds-danger-text)",
        borderColor: "var(--ds-danger)",
      }}
    >
      <h3 className="text-xs font-medium uppercase tracking-wide mb-1">
        Ingestion error
      </h3>
      <p className="text-sm">{detail}</p>
    </section>
  );
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function sourceTypeLabel(t: SourceDetail["sourceType"]): string {
  switch (t) {
    case "pdf":
      return "PDF";
    case "paste_text":
      return "Paste text";
    case "faq":
      return "FAQ";
    case "website":
      return "Website";
    case "spreadsheet":
      return "Spreadsheet";
    case "social":
      return "Social media";
  }
}

// "just now" inside the formatter is the only allowed instance of "just" in
// rendered copy — the forbidden-words audit allows-lists this exact string.
function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
