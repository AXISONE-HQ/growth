"use client";

/**
 * KAN-866 — Account Page Cohort 6: detection-proposals drift banner.
 *
 * **PROMOTION CANDIDATE** — KAN-842 lift candidate when canonical DS v1
 * surfaces consolidate.
 *
 * Renders ABOVE the AccountTabs row (mounted in account/layout.tsx) when
 * the tenant has any AccountFieldDetection rows in `status='proposed'`.
 * Clicking "Review proposals" opens the ReviewProposalsSheet.
 *
 * Tinted with --ds-violet-* per spec §7.7 — violet = "AI activity" hue.
 *
 * No-op render when proposals.length === 0 (returns null).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpcQuery } from "@/lib/api";
import { ReviewProposalsSheet } from "./review-proposals-sheet";

interface ProposalRow {
  id: string;
  fieldPath: string;
  proposedValue: string;
  confidence: number;
  sourceUrl: string | null;
  sourceSnippet: string | null;
  createdAt: string;
}

interface ProposalsResponse {
  proposals: ProposalRow[];
}

export function DriftBanner(): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const proposalsQuery = useQuery<ProposalsResponse>({
    queryKey: ["account", "detection-proposals"],
    queryFn: () => trpcQuery<ProposalsResponse>("account.getDetectionProposals"),
    refetchOnWindowFocus: true,
  });

  const proposals = proposalsQuery.data?.proposals ?? [];
  if (proposals.length === 0) return null;

  const count = proposals.length;
  return (
    <>
      <div
        role="region"
        aria-label="Detected account fields awaiting review"
        className="mb-4 rounded-lg border px-4 py-3 flex items-center gap-3"
        style={{
          backgroundColor: "var(--ds-violet-50)",
          borderColor: "var(--ds-violet-500)",
          color: "var(--ds-ink-primary)",
        }}
      >
        <Sparkles
          aria-hidden="true"
          className="w-4 h-4 flex-shrink-0"
          style={{ color: "var(--ds-violet-500)" }}
        />
        <div className="flex-1 text-sm">
          <span className="font-medium">
            {count} {count === 1 ? "field" : "fields"} ready to review
          </span>
          <span className="ml-2" style={{ color: "var(--ds-ink-secondary)" }}>
            from your latest website scan.
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          aria-label="Review detected proposals"
        >
          Review proposals
        </Button>
      </div>
      <ReviewProposalsSheet
        open={open}
        onOpenChange={setOpen}
        proposals={proposals}
      />
    </>
  );
}
