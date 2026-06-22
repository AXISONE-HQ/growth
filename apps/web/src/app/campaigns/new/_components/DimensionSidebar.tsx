"use client";

/**
 * KAN-1187 — Dimension sidebar (F3 chip group lock).
 *
 * Renders the 4-dimension state (Product / Objectives / Timeline / Audience)
 * as a chip group with state-derived badge variants:
 *   empty     → muted outline ("Pending")
 *   proposed  → amber filled ("Proposed")
 *   confirmed → green filled ("✓ Confirmed")
 *
 * Sticky "Generate Action Plan" button in footer once all 4 dimensions
 * are Confirmed (F5 dual-placement lock — second affordance; first is
 * inline within the AIMessage of the all_dimensions_confirmed turn).
 *
 * Vocabulary continuity: chip group matches KAN-1183 list-view filter
 * chip pattern (operators already trained on this idiom).
 */
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DIMENSION_ORDER,
  type ConversationState,
  type DimensionKey,
  type DimensionState,
} from "@growth/shared";

export interface DimensionSidebarProps {
  state: ConversationState;
  allDimensionsConfirmed: boolean;
  onGeneratePlan: () => void;
  isGenerating: boolean;
  className?: string;
}

// KAN-1219 Slice G3 — Record now scoped to full DimensionKey (5 dims) with
// entityType promoted to DIMENSION_ORDER position 0 per Q1 lock. Sidebar
// shows the operator's polymorphic discriminator decision as the first
// chip — Memo 19/42 affordance-honesty (explicit branch, never implicit).
const DIMENSION_LABELS: Record<DimensionKey, string> = {
  entityType: "Target type",
  product: "Product",
  objectives: "Objectives",
  timeline: "Timeline",
  audience: "Audience",
};

function chipVariant(
  dim: DimensionState,
): "muted" | "amber" | "green" {
  switch (dim.kind) {
    case "empty":
      return "muted";
    case "proposed":
      return "amber";
    case "confirmed":
      return "green";
  }
}

function chipLabel(dim: DimensionState): string {
  switch (dim.kind) {
    case "empty":
      return "Pending";
    case "proposed":
      return "Proposed";
    case "confirmed":
      return "✓ Confirmed";
  }
}

function formatValue(dim: DimensionState): string | null {
  if (dim.kind === "empty") return null;
  if (typeof dim.value === "string") return dim.value;
  try {
    return JSON.stringify(dim.value);
  } catch {
    return null;
  }
}

export function DimensionSidebar({
  state,
  allDimensionsConfirmed,
  onGeneratePlan,
  isGenerating,
  className,
}: DimensionSidebarProps) {
  return (
    <aside
      className={`flex flex-col gap-4 rounded-lg border border-border bg-card p-4 ${className ?? ""}`}
      aria-label="Campaign dimensions"
    >
      <h2 className="text-sm font-semibold text-foreground">
        Campaign dimensions
      </h2>
      <ul className="flex flex-col gap-3">
        {DIMENSION_ORDER.map((key) => {
          const dim = state[key];
          const variant = chipVariant(dim);
          const label = chipLabel(dim);
          const value = formatValue(dim);
          return (
            <li key={key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {DIMENSION_LABELS[key]}
                </span>
                <Badge variant={variant} aria-label={`${DIMENSION_LABELS[key]}: ${label}`}>
                  {label}
                </Badge>
              </div>
              {value && (
                <p className="text-xs text-foreground/80 break-words leading-snug">
                  {value}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {allDimensionsConfirmed && (
        <div className="mt-2 border-t border-border pt-3">
          <Button
            type="button"
            onClick={onGeneratePlan}
            disabled={isGenerating}
            className="w-full gap-2"
          >
            <Sparkles className="h-4 w-4" />
            {isGenerating ? "Generating..." : "Generate Action Plan"}
          </Button>
        </div>
      )}
    </aside>
  );
}
