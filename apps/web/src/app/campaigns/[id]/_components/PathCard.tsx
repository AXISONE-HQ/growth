/**
 * KAN-1166 PR 3-variants — Path card (one of three achievable paths).
 *
 * Layout (Q-ADD V4 ratified): vertical stack, full card width — NOT a
 * 3-column grid. 120-char requiredAction strings would wrap unreadably at
 * <1400px in a 3-col layout. Vertical stack scrolls naturally below the
 * fold (where doctrine permits).
 *
 * Refine-goal CTA (Q-ADD I2 + Decision 4 refinement):
 *   - Copy: "Refine goal" — operator mental model match (shapes target
 *     toward strategy; NOT "Edit goal" which blames the operator's prior
 *     entry, NOT "Try this strategy" which overcommits)
 *   - URL: ?refineGoalHint=<encoded label + colon + requiredAction>
 *     (single-param per Decision 4)
 *   - Each PathCard renders its own Refine-goal CTA top-right; clicking
 *     navigates within the same /campaigns/[id] route so the chat thread
 *     re-renders with the hint surfaced to the goal-setting flow.
 */
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { AchievablePath } from "@growth/shared";

export interface PathCardProps {
  path: AchievablePath;
  campaignId: string;
  className?: string;
}

export function PathCard({ path, campaignId, className }: PathCardProps) {
  const hint = `${path.label}: ${path.requiredAction}`;
  const href = `/campaigns/${campaignId}?refineGoalHint=${encodeURIComponent(hint)}`;
  return (
    <div
      className={
        "rounded-lg border border-border bg-background px-4 py-3 " +
        (className ?? "")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-body font-semibold">{path.label}</h4>
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          Refine goal <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <p className="mt-1 text-body text-muted-foreground">{path.description}</p>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex gap-2">
          <dt className="shrink-0 font-medium text-muted-foreground">Required action:</dt>
          <dd>{path.requiredAction}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 font-medium text-muted-foreground">Estimated impact:</dt>
          <dd>{path.estimatedImpact}</dd>
        </div>
      </dl>
    </div>
  );
}
