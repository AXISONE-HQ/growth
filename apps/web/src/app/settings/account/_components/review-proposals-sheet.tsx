"use client";

/**
 * KAN-866 — Account Page Cohort 6: detection-proposals review sheet.
 *
 * **PROMOTION CANDIDATE** — KAN-842 lift candidate.
 *
 * Slide-from-right Sheet (shadcn primitive at components/ui/sheet.tsx)
 * listing every AccountFieldDetection in `status='proposed'`. Per row:
 *   - Field label (humanized fieldPath)
 *   - Proposed value (JSON-decoded; objects rendered as multi-line)
 *   - Source URL + snippet (collapsed expand-on-click)
 *   - ConfidenceBadge
 *   - Accept · Reject buttons (Edit deferred per Cohort 6 brief — opens
 *     the source URL in a new tab as the "edit" affordance for now)
 *
 * Bulk "Accept all" at the top fires `account.acceptAllDetections`.
 *
 * On any mutation success, invalidates:
 *   ['account', 'get'] — so the input field re-renders the new value
 *   ['account', 'detection-proposals'] — so the sheet refreshes
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { trpcMutation } from "@/lib/api";
import { ConfidenceBadge } from "@/components/growth/confidence-badge";

interface ProposalRow {
  id: string;
  fieldPath: string;
  proposedValue: string;
  confidence: number;
  sourceUrl: string | null;
  sourceSnippet: string | null;
  createdAt: string;
}

export interface ReviewProposalsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proposals: ProposalRow[];
}

/** Humanize a dot-notation fieldPath — "primaryPhone" → "Primary phone". */
export function humanizeFieldPath(path: string): string {
  const last = path.split(".").pop() ?? path;
  const spaced = last.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Decode JSON-stringified proposedValue into a display string. */
export function renderProposedValue(stringified: string): string {
  try {
    const parsed = JSON.parse(stringified);
    if (typeof parsed === "string") return parsed;
    if (parsed === null) return "(empty)";
    return JSON.stringify(parsed, null, 2);
  } catch {
    return stringified;
  }
}

export function ReviewProposalsSheet({
  open,
  onOpenChange,
  proposals,
}: ReviewProposalsSheetProps): React.ReactElement {
  const queryClient = useQueryClient();

  const invalidate = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["account", "get"] });
    queryClient.invalidateQueries({ queryKey: ["account", "detection-proposals"] });
  }, [queryClient]);

  const acceptOne = useMutation({
    mutationFn: (detectionId: string) =>
      trpcMutation("account.acceptDetection", { detectionId }),
    onSuccess: () => {
      invalidate();
      toast.success("Proposal accepted.");
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't accept. Try again."),
  });

  const rejectOne = useMutation({
    mutationFn: (detectionId: string) =>
      trpcMutation("account.rejectDetection", { detectionId }),
    onSuccess: () => {
      invalidate();
      toast.success("Proposal rejected.");
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't reject. Try again."),
  });

  const acceptAll = useMutation({
    mutationFn: () =>
      trpcMutation<{ acceptedCount: number }>("account.acceptAllDetections", {}),
    onSuccess: (data) => {
      invalidate();
      toast.success(`Accepted ${data.acceptedCount} proposals.`);
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't accept all. Try again."),
  });

  const isBusy = acceptOne.isPending || rejectOne.isPending || acceptAll.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" aria-label="Review detected proposals">
        <SheetHeader>
          <SheetTitle>Review proposals</SheetTitle>
          <SheetDescription>
            Detected fields from your website scan. Accept to apply, reject to
            discard.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 mb-3 flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={isBusy || proposals.length === 0}
            onClick={() => acceptAll.mutate()}
            aria-label="Accept all proposals"
          >
            {acceptAll.isPending ? "Accepting…" : "Accept all"}
          </Button>
        </div>

        <ul className="flex flex-col gap-3" aria-label="Proposed fields">
          {proposals.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border p-3 flex flex-col gap-2"
              style={{
                borderColor: "var(--ds-border-subtle)",
                backgroundColor: "var(--ds-surface-base)",
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span
                    className="text-sm font-medium"
                    style={{ color: "var(--ds-ink-primary)" }}
                  >
                    {humanizeFieldPath(p.fieldPath)}
                  </span>
                  <span
                    className="text-xs"
                    style={{ color: "var(--ds-ink-tertiary)" }}
                  >
                    {p.fieldPath}
                  </span>
                </div>
                <ConfidenceBadge value={Math.round(p.confidence * 100)} />
              </div>

              <pre
                className="text-xs whitespace-pre-wrap break-words rounded p-2 font-sans"
                style={{
                  backgroundColor: "var(--ds-surface-sunken)",
                  color: "var(--ds-ink-primary)",
                }}
              >
                {renderProposedValue(p.proposedValue)}
              </pre>

              {p.sourceUrl && (
                <details className="text-xs">
                  <summary
                    className="cursor-pointer"
                    style={{ color: "var(--ds-ink-secondary)" }}
                  >
                    Source
                  </summary>
                  <div className="mt-1 flex flex-col gap-1">
                    <a
                      href={p.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 underline"
                      style={{ color: "var(--ds-violet-700)" }}
                    >
                      {p.sourceUrl}
                      <ExternalLink aria-hidden="true" className="w-3 h-3" />
                    </a>
                    {p.sourceSnippet && (
                      <blockquote
                        className="border-l-2 pl-2 italic"
                        style={{
                          borderColor: "var(--ds-border-subtle)",
                          color: "var(--ds-ink-tertiary)",
                        }}
                      >
                        {p.sourceSnippet}
                      </blockquote>
                    )}
                  </div>
                </details>
              )}

              <div className="flex justify-end gap-2 mt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isBusy}
                  onClick={() => rejectOne.mutate(p.id)}
                  aria-label={`Reject ${humanizeFieldPath(p.fieldPath)}`}
                >
                  Reject
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => acceptOne.mutate(p.id)}
                  aria-label={`Accept ${humanizeFieldPath(p.fieldPath)}`}
                >
                  Accept
                </Button>
              </div>
            </li>
          ))}
        </ul>

        {proposals.length === 0 && (
          <p
            className="text-sm text-center mt-6"
            style={{ color: "var(--ds-ink-tertiary)" }}
          >
            No proposals to review.
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
