/**
 * KAN-1166 PR 3-core-shell — Empty state for the chat thread.
 *
 * Shown when the operator hasn't set a goal triplet yet (goalType /
 * goalTarget / goalDescription). The chat thread renders this in place of
 * messages until campaigns.setGoal populates the triplet (handled by a
 * separate goal-setting surface PR-out-of-scope here).
 */
import Link from "next/link";
import { Sparkles } from "lucide-react";

export interface EmptyStateProps {
  campaignId: string;
}

export function EmptyState({ campaignId }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-100 text-violet-700">
        <Sparkles className="h-6 w-6" />
      </div>
      <h3 className="text-h3 font-semibold">Tell us your goal</h3>
      <p className="max-w-md text-body text-muted-foreground">
        Set a quantified outcome for this Campaign — e.g. &quot;100 closed deals
        by end of Q3.&quot; The Feasibility Analyzer will check your historical
        signal and give you honest counsel before activation.
      </p>
      <Link
        href={`/campaigns/${campaignId}/goal`}
        className="text-sm font-medium text-primary hover:underline"
      >
        Set the goal →
      </Link>
    </div>
  );
}
