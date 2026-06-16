"use client";

/**
 * KAN-1206 — Per-Pipeline LIVE render in the committed Campaign view.
 *
 * Live source (NOT snapshot): `pipelines.listWithStages({campaignId})` returns
 * current Pipeline + Stages from the DB. Operator edits via
 * /settings/pipelines/[id] (per-stage rename, knowledge filter changes) are
 * reflected here on subsequent loads.
 *
 * Strategy badge is read from the per-pipeline slice in
 * `Campaign.committedPlan.plan.pipelines[i]` (matched by index → name). This
 * is the snapshot value preserved at commit; Pipeline.strategy may diverge if
 * an operator edits via settings, but the badge stays anchored to commit
 * intent. Operator-visible drift is acceptable here — the snapshot card above
 * preserves the agreed-to plan; this card shows where things stand now.
 *
 * Direct-edit affordance: deep-link to `/settings/pipelines/[id]` reuses the
 * existing canonical Pipeline detail view (KAN-708 + KAN-1169) rather than
 * duplicating the form. No KAN-1206 in-page editing.
 */
import Link from "next/link";
import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PipelineWithStages, ActionPlan } from "@/lib/api";

export interface CommittedPipelineCardProps {
  pipeline: PipelineWithStages;
  /** Snapshot strategy + audience-count + share from committedPlan; null if
   *  the live Pipeline row predates a commit or no snapshot slice matched. */
  snapshot?: ActionPlan["pipelines"][number];
  index: number;
  goalType: string;
}

const STRATEGY_LABEL: Record<NonNullable<CommittedPipelineCardProps["snapshot"]>["strategy"], string> = {
  direct: "Direct Conversion",
  re_engage: "Re-engagement",
  trust_build: "Trust Building",
  guided: "Guided Assistance",
};

export function CommittedPipelineCard({
  pipeline,
  snapshot,
  index,
  goalType,
}: CommittedPipelineCardProps) {
  return (
    <article
      aria-label={`Pipeline ${index + 1}: ${pipeline.name}`}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-semibold">{pipeline.name}</h4>
          {snapshot && (
            <p className="text-xs text-muted-foreground">
              {snapshot.segment.replace(/_/g, " ")} ·{" "}
              {snapshot.audienceCount.toLocaleString()} contacts ·{" "}
              {snapshot.projectedContribution.toLocaleString()} {goalType}{" "}
              projected
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {snapshot && (
            <Badge variant="ai" className="text-xs">
              {STRATEGY_LABEL[snapshot.strategy]}
            </Badge>
          )}
          <Link
            href={`/settings/pipelines/${pipeline.id}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
            aria-label={`Edit pipeline ${pipeline.name}`}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Link>
        </div>
      </header>

      <section aria-label="Stages">
        <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Stages ({pipeline.stages.length})
        </h5>
        <ol className="flex flex-col gap-1">
          {pipeline.stages.map((s, i) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded border border-border/60 bg-background px-3 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {i + 1}.
                </span>
                <span className="text-sm">{s.name}</span>
              </div>
              <div className="flex items-center gap-1">
                {s.isInitial && (
                  <Badge variant="outline" className="text-xs">
                    Initial
                  </Badge>
                )}
                {s.isTerminal && (
                  <Badge variant="outline" className="text-xs">
                    Terminal
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
