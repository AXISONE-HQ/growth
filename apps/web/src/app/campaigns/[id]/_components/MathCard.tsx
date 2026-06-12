/**
 * KAN-1166 PR 3-variants — Math card showing projection / goal / gap.
 *
 * Layout (Q-ADD V3 ratified): aligned-text block via <dl> for semantic
 * "label/value" pairs. The divider before the gap row literally enacts
 * the subtraction visually. tabular-nums keeps numbers right-aligned.
 *
 * Above-the-fold doctrine (Q-ADD D1): this card MUST render within the
 * first ~500px of viewport on 1920×1080. Vertical stack keeps total height
 * ~140px (3 rows + divider + padding).
 */
import type { ProjectedOrganic, GoalGap } from "@growth/shared";

export interface MathCardProps {
  projectedOrganic: ProjectedOrganic;
  goalTarget: number;
  goalGap: GoalGap;
  className?: string;
}

export function MathCard({
  projectedOrganic,
  goalTarget,
  goalGap,
  className,
}: MathCardProps) {
  const { count, unit } = projectedOrganic;
  const { absolute, percent } = goalGap;
  const isSurplus = absolute < 0;
  const absDisplay = Math.abs(absolute);
  return (
    <dl
      className={
        "space-y-2 rounded-lg border border-border bg-background px-4 py-3 text-body " +
        (className ?? "")
      }
    >
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-muted-foreground">Organic projection</dt>
        <dd className="tabular-nums font-medium">
          {count.toLocaleString()} {unit}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-muted-foreground">Your goal</dt>
        <dd className="tabular-nums font-medium">
          {goalTarget.toLocaleString()} {unit}
        </dd>
      </div>
      <hr className="border-border" />
      <div className="flex items-baseline justify-between gap-3 font-semibold">
        <dt>{isSurplus ? "Surplus" : "Gap"}</dt>
        <dd className="tabular-nums">
          {absDisplay.toLocaleString()} {unit}{" "}
          <span className="font-normal text-muted-foreground">
            ({Math.abs(percent)}% {isSurplus ? "above" : "short"})
          </span>
        </dd>
      </div>
    </dl>
  );
}
