"use client";

/**
 * KAN-1188 G1 — Per-Pipeline sub-card.
 *
 * Header row: name + segment + strategy chip + projected contribution chip.
 * Expand toggle reveals StageRows + FirstActionRows.
 *
 * Y2 lock: expansion state via local useState; preserved across refinement
 * turns (the card stays mounted on refineActionPlan response). The parent
 * ActionPlanCard's concurrent_edit_conflict Reload path constructs a fresh
 * subtree, naturally resetting expansion to default-collapsed.
 *
 * Pencil hint on each StageRow / FirstActionRow — DISABLED affordance with
 * tooltip pointing to KAN-1198 (Y1 deferred direct-edit substrate). Operators
 * use the chat-refinement input below the card to refine for now.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ActionPlanPipeline } from "@growth/shared";

export interface PipelineCardProps {
  pipeline: ActionPlanPipeline;
  index: number;
  goalType: string;
}

const STRATEGY_LABEL: Record<ActionPlanPipeline["strategy"], string> = {
  direct: "Direct Conversion",
  re_engage: "Re-engagement",
  trust_build: "Trust Building",
  guided: "Guided Assistance",
};

const DIRECT_EDIT_DEFERRED_HINT =
  "Inline edit deferred — use the chat input below to refine (KAN-1198).";

export function PipelineCard({ pipeline, index, goalType }: PipelineCardProps) {
  const [expanded, setExpanded] = useState(false);
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <article
      aria-label={`Pipeline ${index + 1}: ${pipeline.name}`}
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
    >
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="flex items-start justify-between gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        aria-expanded={expanded}
      >
        <div className="flex items-start gap-2">
          <ChevronIcon className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold">{pipeline.name}</span>
            <span className="text-xs text-muted-foreground">
              {pipeline.segment.replace(/_/g, " ")} ·{" "}
              {pipeline.audienceCount.toLocaleString()} contacts
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="ai" className="text-xs">
            {STRATEGY_LABEL[pipeline.strategy]}
          </Badge>
          <Badge variant="muted" className="text-xs tabular-nums">
            {pipeline.projectedContribution.toLocaleString()} {goalType}
          </Badge>
        </div>
      </button>

      {expanded && (
        <div className="mt-2 flex flex-col gap-3 border-t border-border pt-3">
          <section aria-label="Stages">
            <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Stages ({pipeline.proposedStages.length})
            </h5>
            <ol className="flex flex-col gap-1.5">
              {pipeline.proposedStages.map((s, i) => (
                <li
                  key={i}
                  className="flex items-start justify-between gap-2 rounded border border-border/60 bg-background px-3 py-2"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {i + 1}. {s.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {s.description}
                    </span>
                  </div>
                  <Pencil
                    className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
                    aria-label={DIRECT_EDIT_DEFERRED_HINT}
                  >
                    <title>{DIRECT_EDIT_DEFERRED_HINT}</title>
                  </Pencil>
                </li>
              ))}
            </ol>
          </section>

          <section aria-label="First actions">
            <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              First actions ({pipeline.firstActions.length})
            </h5>
            <ol className="flex flex-col gap-1.5">
              {pipeline.firstActions.map((a, i) => (
                <li
                  key={i}
                  className="flex items-start justify-between gap-2 rounded border border-border/60 bg-background px-3 py-2"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      Day {a.day} · {a.channel} · {a.intent}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {a.description}
                    </span>
                  </div>
                  <Pencil
                    className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
                    aria-label={DIRECT_EDIT_DEFERRED_HINT}
                  >
                    <title>{DIRECT_EDIT_DEFERRED_HINT}</title>
                  </Pencil>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </article>
  );
}
