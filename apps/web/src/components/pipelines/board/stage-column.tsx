/**
 * KAN-968 — Pipelines board stage column.
 *
 * Fixed-width column (w-72) with a header (stage name + count badge + subtle
 * terminal accent) and a vertically-scrolling card list. 50-cap is enforced
 * server-side (KAN-967); when `truncatedCount > 0` we render a muted
 * "+N more in this stage" affordance at the bottom.
 *
 * Terminal stages get a subtle accent on the header (emerald for won, red for
 * lost). Open stages render plain. Color is supplementary — name + outcome
 * type drive the semantics.
 */
import type { BoardDealCard } from "@/lib/api";
import { DealCard } from "./deal-card";

export interface StageColumnProps {
  stage: {
    id: string;
    name: string;
    isInitial: boolean;
    isTerminal: boolean;
  };
  outcomeType?: "open" | "terminal_won" | "terminal_lost";
  deals: BoardDealCard[];
  truncatedCount: number;
  now?: Date;
}

function headerAccent(outcomeType: StageColumnProps["outcomeType"]): string {
  switch (outcomeType) {
    case "terminal_won":
      return "border-l-2 border-emerald-500/50";
    case "terminal_lost":
      return "border-l-2 border-red-500/50";
    default:
      return "";
  }
}

export function StageColumn({
  stage,
  outcomeType,
  deals,
  truncatedCount,
  now,
}: StageColumnProps) {
  // Total = visible cards + truncated overflow. Surfaces the real volume per
  // the PRD's "count badge" + "+N more" affordance.
  const total = deals.length + truncatedCount;

  return (
    <section
      role="region"
      aria-label={`${stage.name} — ${total} deal${total === 1 ? "" : "s"}`}
      data-testid="board-stage-column"
      data-stage-id={stage.id}
      className="flex w-72 shrink-0 flex-col"
    >
      <header
        className={`mb-2 flex items-center justify-between rounded-t-md bg-slate-900/70 px-3 py-2 ${headerAccent(outcomeType)}`}
      >
        <h3 className="text-sm font-semibold text-slate-200">{stage.name}</h3>
        <span
          className="rounded-full bg-slate-700/70 px-2 py-0.5 text-[11px] font-medium tabular-nums text-slate-300"
          aria-label={`${total} deals`}
        >
          {total}
        </span>
      </header>

      <div className="flex max-h-[calc(100vh-280px)] flex-col gap-2 overflow-y-auto pr-1">
        {deals.length === 0 ? (
          <p
            data-testid="empty-stage-message"
            className="px-1 py-4 text-center text-xs text-slate-500"
          >
            No deals in this stage.
          </p>
        ) : (
          <>
            {deals.map((deal) => (
              <DealCard
                key={deal.id}
                deal={deal}
                stageName={stage.name}
                now={now}
              />
            ))}
            {truncatedCount > 0 ? (
              <p
                data-testid="truncated-count-row"
                className="px-1 py-2 text-center text-xs text-slate-500"
              >
                +{truncatedCount} more in this stage
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
