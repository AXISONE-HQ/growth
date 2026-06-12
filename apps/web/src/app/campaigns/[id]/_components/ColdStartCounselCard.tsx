/**
 * KAN-1166 PR 3-variants — Cold-start counsel card.
 *
 * Rendered when feasibility.kind === 'cold_start_counsel' (dataReadiness
 * insufficient; deterministic template; NO LLM call per Phase 1 lock).
 *
 * Q-ADD D3 lock (ratified): distinct shell from FeasibilityCounselDetailCard
 * — cold-start has NO above-the-fold achievability/confidence/math cluster,
 * so sharing a shell would force complex conditional rendering. Composition:
 *
 *   1. message paragraph (analyzer's framing)
 *   2. Missing-data chip strip (visualizes the gap)
 *   3. Per-substrate AcquisitionCTA stack (×N where N=missingDataTypes)
 */
import type { ColdStartCounsel } from "@growth/shared";
import { Badge } from "@/components/ui/badge";
import { AcquisitionCTA } from "./AcquisitionCTA";

export interface ColdStartCounselCardProps {
  counsel: ColdStartCounsel;
  className?: string;
}

const DATA_TYPE_LABELS: Record<ColdStartCounsel["missingDataTypes"][number], string> = {
  sales_history: "Sales history",
  customer_base: "Customer base",
  lead_history: "Lead history",
  engagement_history: "Engagement history",
};

export function ColdStartCounselCard({ counsel, className }: ColdStartCounselCardProps) {
  return (
    <div className={"flex flex-col gap-4 " + (className ?? "")}>
      <p className="whitespace-pre-wrap text-body">{counsel.message}</p>

      {counsel.missingDataTypes.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            Missing data:
          </span>
          {counsel.missingDataTypes.map((dataType) => (
            <Badge key={dataType} variant="muted">
              {DATA_TYPE_LABELS[dataType]}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        {counsel.acquisitionRecommendations.map((recommendation) => (
          <AcquisitionCTA
            key={recommendation.dataType}
            recommendation={recommendation}
          />
        ))}
      </div>
    </div>
  );
}
