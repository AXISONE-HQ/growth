/**
 * KAN-968 — Pipelines board deal card.
 *
 * Read-only card. Whole card is a Link to the Deal detail page; no drag,
 * no inline actions. Layout per the PRD screen spec:
 *   - contact name (primary) + value (secondary, right-aligned)
 *   - company (small secondary)
 *   - AI line ("AI: {action} · {confidence}%") — ONLY when latestDecision
 *     is non-null. We never fabricate a decision.
 *   - stage age ("in {stage} · {2h}") — micro, muted
 *
 * Confidence color is supplementary; the text label is always present.
 */
import Link from "next/link";
import {
  humanizeActionType,
  confidenceLevel,
  confidencePercent,
  confidenceClasses,
  formatStageAge,
  contactDisplayName,
  formatMoney,
} from "@/lib/board-helpers";
import type { BoardDealCard } from "@/lib/api";

export interface DealCardProps {
  deal: BoardDealCard;
  stageName: string;
  /** Injected for deterministic tests of the age string. */
  now?: Date;
}

export function DealCard({ deal, stageName, now }: DealCardProps) {
  const decision = deal.latestDecision;

  return (
    <Link
      href={`/opportunities/${deal.id}`}
      role="article"
      aria-label={`Deal ${deal.name} — ${stageName}`}
      className="block rounded-xl border border-slate-700/60 bg-slate-800/80 p-3 transition-colors hover:border-slate-500 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      data-testid="board-deal-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm font-medium text-slate-100">
          {contactDisplayName(deal.contact)}
        </div>
        <div className="shrink-0 text-sm tabular-nums text-slate-300">
          {formatMoney(deal.value, deal.currency)}
        </div>
      </div>

      {deal.company?.name ? (
        <div className="mt-0.5 truncate text-xs text-slate-400">
          {deal.company.name}
        </div>
      ) : null}

      {decision ? (
        <div className="mt-2 flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400"
          />
          <span className="text-xs text-slate-300">
            AI: {humanizeActionType(decision.actionType)}
          </span>
          <span
            data-testid="confidence-badge"
            data-confidence-level={confidenceLevel(decision.confidence)}
            className={`ml-auto rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${confidenceClasses(confidenceLevel(decision.confidence))}`}
          >
            {confidencePercent(decision.confidence)}%
          </span>
        </div>
      ) : null}

      <div className="mt-2 text-[11px] text-slate-500">
        in {stageName} · {formatStageAge(deal.enteredStageAt, now)}
      </div>
    </Link>
  );
}
