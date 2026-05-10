"use client";

/**
 * KAN-866 — Account Page Cohort 6: per-field detection affordance helper.
 *
 * **PROMOTION CANDIDATE** — composition-of-atoms helper. KAN-842 lift
 * candidate when detection UX patterns stabilize.
 *
 * Renders AFTER the input element it applies to (compose-from-atoms per
 * Cohort 2's deliberate rejection of a FormField primitive). When the
 * matching `AccountFieldDetection` row is `status='proposed'`:
 *
 *   - ConfidenceBadge (right-aligned)
 *   - Source URL link (when present)
 *   - Inline Accept · Reject pill row (Edit folds into "open source")
 *
 * When no detection exists (or status !== 'proposed'), renders nothing.
 *
 * Mutations invalidate ['account', 'get'] + ['account', 'detection-proposals']
 * — same contract as ReviewProposalsSheet.
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpcMutation } from "@/lib/api";
import { ConfidenceBadge } from "@/components/growth/confidence-badge";
import { humanizeFieldPath } from "./review-proposals-sheet";

export interface DetectionRow {
  id: string;
  fieldPath: string;
  proposedValue: string;
  confidence: number;
  sourceUrl: string | null;
  sourceSnippet: string | null;
}

export interface DetectionAffordancesProps {
  /** The detection row matching this field path; pass `null` when none exists. */
  detection: DetectionRow | null;
}

export function DetectionAffordances({
  detection,
}: DetectionAffordancesProps): React.ReactElement | null {
  const queryClient = useQueryClient();
  const invalidate = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["account", "get"] });
    queryClient.invalidateQueries({ queryKey: ["account", "detection-proposals"] });
  }, [queryClient]);

  const acceptMutation = useMutation({
    mutationFn: (detectionId: string) =>
      trpcMutation("account.acceptDetection", { detectionId }),
    onSuccess: () => {
      invalidate();
      toast.success("Proposal accepted.");
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't accept. Try again."),
  });

  const rejectMutation = useMutation({
    mutationFn: (detectionId: string) =>
      trpcMutation("account.rejectDetection", { detectionId }),
    onSuccess: () => {
      invalidate();
      toast.success("Proposal rejected.");
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't reject. Try again."),
  });

  if (!detection) return null;
  const isBusy = acceptMutation.isPending || rejectMutation.isPending;
  const fieldLabel = humanizeFieldPath(detection.fieldPath);
  const confidencePct = Math.round(detection.confidence * 100);

  return (
    <div
      role="region"
      aria-label={`AI proposal for ${fieldLabel}`}
      className="mt-1 flex flex-col gap-1.5 rounded-md border px-3 py-2"
      style={{
        backgroundColor: "var(--ds-violet-50)",
        borderColor: "var(--ds-violet-500)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs font-medium"
          style={{ color: "var(--ds-violet-700)" }}
        >
          Proposed by AI
        </span>
        <ConfidenceBadge value={confidencePct} showWord={false} />
      </div>
      {detection.sourceUrl && (
        <a
          href={detection.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline truncate"
          style={{ color: "var(--ds-violet-700)" }}
          aria-label={`Source for ${fieldLabel}`}
        >
          {detection.sourceUrl}
        </a>
      )}
      <div className="flex justify-end gap-2 mt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isBusy}
          onClick={() => rejectMutation.mutate(detection.id)}
          aria-label={`Reject proposal for ${fieldLabel}`}
        >
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isBusy}
          onClick={() => acceptMutation.mutate(detection.id)}
          aria-label={`Accept proposal for ${fieldLabel}`}
        >
          Accept
        </Button>
      </div>
    </div>
  );
}
