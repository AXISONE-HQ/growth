// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge admin page (KAN-XXX), reusable for any tenant-scoped
//          FAQ surface (Persona FAQ, etc.)

/**
 * FaqList — admin list view for tenant FAQ entries (first-class entity per
 * KAN-XXX, supersedes KAN-841 multi-pair Q&A schema gap).
 *
 * **Layout** mirrors SourceList's structure but with FAQ-specific columns:
 *   - Question (truncated; click row to view full Q+A in an expand-row)
 *   - Last updated (relativeTime)
 *   - Row actions (Edit / Delete)
 *
 * **DS v1 compliance:**
 *  - All colors via `--ds-*` tokens
 *  - Three-part empty state per spec docs/design-system/v1.md Part 4:
 *    "No FAQ entries yet." / "Entries appear here as you create them. The AI
 *    uses them to answer customer questions specifically — not generically." /
 *    "Add FAQ entry" CTA
 *  - Skeleton loading + system-retriable error state (mirrors SourceList)
 *  - Sentence case + verb+object button labels
 *  - Forbidden-words audit (no magic / simply / just / easily / seamlessly /
 *    revolutionary / cutting-edge / leverage / synergy / unfortunately / please)
 *
 * **Polling contract:** 5s while any entry has status='queued' or 'embedding';
 * off otherwise. Identical pattern to SourceList — reuse-friendly.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusPill, type StatusPillStatus } from "@/components/ui/knowledge/status-pill";
import { AddFaqDialog } from "./add-faq-dialog";
import { EditFaqDialog } from "./edit-faq-dialog";
import { DeleteFaqConfirm } from "./delete-faq-confirm";
import { API_BASE, buildHeaders } from "@/lib/api";
import { relativeTime } from "@/lib/relative-time";

interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  status: StatusPillStatus;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

export function FaqList(): React.ReactElement {
  const [isAddDialogOpen, setIsAddDialogOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<FaqEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; question: string } | null>(null);

  const faqsQuery = useQuery<{ faqs: FaqEntry[] }>({
    queryKey: ["knowledge", "faqs"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/knowledge/faqs`, {
        headers: await buildHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { faqs: FaqEntry[] };
    },
    refetchInterval: (data: { faqs: FaqEntry[] } | undefined): number | false => {
      const faqs = data?.faqs ?? [];
      return faqs.some((f) => f.status === "queued" || f.status === "embedding") ? 5000 : false;
    },
  });

  const faqs = faqsQuery.data?.faqs ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => setIsAddDialogOpen(true)} aria-label="Add FAQ entry">
          Add FAQ entry
        </Button>
      </div>

      <div className="mt-2">
        {faqsQuery.isLoading ? (
          <SkeletonTable />
        ) : faqsQuery.isError ? (
          <ErrorState onRetry={() => void faqsQuery.refetch()} />
        ) : faqs.length === 0 ? (
          <EmptyState onAdd={() => setIsAddDialogOpen(true)} />
        ) : (
          <FaqTable
            faqs={faqs}
            onEdit={(f) => setEditTarget(f)}
            onRequestDelete={(id, question) => setDeleteTarget({ id, question })}
          />
        )}
      </div>

      <AddFaqDialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen} />

      <EditFaqDialog
        faq={editTarget}
        open={editTarget !== null}
        onOpenChange={(next) => {
          if (!next) setEditTarget(null);
        }}
      />

      <DeleteFaqConfirm
        faqId={deleteTarget?.id ?? null}
        question={deleteTarget?.question ?? null}
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// EmptyState — three-part formula per DS v1 spec Part 4
// ─────────────────────────────────────────────

function EmptyState({ onAdd }: { onAdd: () => void }): React.ReactElement {
  return (
    <div
      className="flex flex-col items-center text-center py-16 px-6 rounded-lg border"
      style={{
        backgroundColor: "var(--ds-surface-raised)",
        borderColor: "var(--ds-border-subtle)",
      }}
    >
      <h3 className="text-h3 mb-2" style={{ color: "var(--ds-ink-primary)" }}>
        No FAQ entries yet.
      </h3>
      <p
        className="text-body max-w-md mb-6"
        style={{ color: "var(--ds-ink-secondary)" }}
      >
        Entries appear here as you create them. The AI uses them to answer customer questions specifically — not generically.
      </p>
      <Button onClick={onAdd} aria-label="Add FAQ entry">
        Add FAQ entry
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// SkeletonTable — matches FaqTable column layout (Question / Updated / Actions)
// ─────────────────────────────────────────────

function SkeletonTable(): React.ReactElement {
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: "var(--ds-border-subtle)" }}
      aria-label="Loading FAQ entries"
      role="status"
    >
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-4 border-b last:border-0"
          style={{ borderColor: "var(--ds-border-subtle)" }}
        >
          <div
            className="rounded h-4 flex-[3]"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
          <div
            className="rounded h-4 flex-1"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
          <div
            className="rounded h-4 w-24"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// ErrorState — system-retriable; identical posture to SourceList
// ─────────────────────────────────────────────

function ErrorState({ onRetry }: { onRetry: () => void }): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-col items-center text-center py-12 px-6 rounded-lg border"
      style={{
        backgroundColor: "var(--ds-danger-soft)",
        borderColor: "var(--ds-danger)",
        color: "var(--ds-danger-text)",
      }}
    >
      <p className="text-body mb-4">
        We couldn&apos;t load your FAQ entries. Try again.
      </p>
      <Button variant="outline" onClick={onRetry} aria-label="Retry loading FAQ entries">
        Try again
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// FaqTable
// ─────────────────────────────────────────────

const QUESTION_PREVIEW_CHARS = 120;

function FaqTable({
  faqs,
  onEdit,
  onRequestDelete,
}: {
  faqs: FaqEntry[];
  onEdit: (f: FaqEntry) => void;
  onRequestDelete: (id: string, question: string) => void;
}): React.ReactElement {
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: "var(--ds-border-subtle)" }}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Question</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last updated</TableHead>
            <TableHead aria-label="Row actions"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {faqs.map((f) => {
            const truncated =
              f.question.length > QUESTION_PREVIEW_CHARS
                ? `${f.question.slice(0, QUESTION_PREVIEW_CHARS)}…`
                : f.question;
            return (
              <TableRow key={f.id} data-faq-id={f.id}>
                <TableCell className="font-medium" title={f.question}>
                  {truncated}
                </TableCell>
                <TableCell>
                  <StatusPill status={f.status} />
                </TableCell>
                <TableCell style={{ color: "var(--ds-ink-tertiary)" }}>
                  {relativeTime(new Date(f.updatedAt))}
                </TableCell>
                <TableCell>
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(f)}
                      aria-label={`Edit FAQ entry: ${truncated}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRequestDelete(f.id, f.question)}
                      aria-label={`Delete FAQ entry: ${truncated}`}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
