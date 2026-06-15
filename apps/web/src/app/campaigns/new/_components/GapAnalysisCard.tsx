"use client";

/**
 * KAN-1188 G7 — Gap Analysis sub-card.
 *
 * Renders the substrate's discrete numerical values FAITHFULLY (no prose
 * synthesis). Honest counsel doctrine extended to UI: the data speaks for
 * itself via numbers; prose synthesis is a separate concern deferred to a
 * dedicated copy-refinement PR.
 *
 * 3-line panel:
 *   1. Goal: "{goalTarget} {goalType} in {goalWindowDays} days"
 *   2. Projected from current trajectory: "{projectedOrganic} {goalType} ({gapPercent}% short)"
 *   3. Per-Pipeline breakdown: name + audienceCount + projectedContribution + shareOfGoal
 */
import type { ActionPlan } from "@/lib/api";

export interface GapAnalysisCardProps {
  plan: ActionPlan;
  goalType: string;
  className?: string;
}

export function GapAnalysisCard({
  plan,
  goalType,
  className,
}: GapAnalysisCardProps) {
  const { gapAnalysis, pipelines } = plan;
  const overGoal = gapAnalysis.gapAbsolute <= 0;
  return (
    <section
      aria-label="Gap analysis"
      className={`flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4 ${className ?? ""}`}
    >
      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Gap analysis
      </h4>
      <dl className="grid gap-2 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Goal</dt>
          <dd className="font-medium tabular-nums">
            {gapAnalysis.goalTarget.toLocaleString()} {goalType} in{" "}
            {gapAnalysis.goalWindowDays} days
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Projected from current trajectory</dt>
          <dd className="font-medium tabular-nums">
            {gapAnalysis.projectedOrganic.toLocaleString()} {goalType}{" "}
            <span
              className={
                overGoal
                  ? "text-emerald-700"
                  : gapAnalysis.gapPercent > 50
                    ? "text-rose-700"
                    : "text-amber-700"
              }
            >
              ({overGoal ? "at or above goal" : `${gapAnalysis.gapPercent.toFixed(0)}% short`})
            </span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Gap</dt>
          <dd className="font-medium tabular-nums">
            {overGoal
              ? `+${Math.abs(gapAnalysis.gapAbsolute).toLocaleString()} ${goalType} surplus`
              : `${gapAnalysis.gapAbsolute.toLocaleString()} ${goalType} short`}
          </dd>
        </div>
      </dl>
      {pipelines.length > 0 && (
        <div className="mt-2 border-t border-border pt-3">
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Per-pipeline contribution
          </h5>
          <ul className="flex flex-col gap-1.5">
            {pipelines.map((p, idx) => (
              <li
                key={idx}
                className="flex items-baseline justify-between gap-3 text-xs"
              >
                <span className="text-foreground">{p.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {p.audienceCount.toLocaleString()} contacts → {p.projectedContribution.toLocaleString()} {goalType}{" "}
                  ({p.shareOfGoal.toFixed(0)}% of goal)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
