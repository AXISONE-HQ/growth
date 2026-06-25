"use client";

/**
 * KAN-1234 Phase A — Decision Scoreboard.
 *
 * Renders below DimensionSidebar in the right column. Shows a realistic outcome
 * estimate (reachable × closing rate × time) so the operator can decide to
 * commit or refine BEFORE clicking Generate Action Plan (Doctrine #5). The
 * projection comes from campaigns.computeProjection, which reads the persisted
 * Campaign + tenant; this component refetches (debounced 500ms) as the operator
 * confirms dimensions, and discloses fields progressively as they arrive.
 *
 * Memo 19/42 affordance-honesty — when the closing rate is an industry default
 * (the tenant has <3 measured outcomes), an explicit "(industry baseline)"
 * label tells the operator it isn't their data yet.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { campaignsApi, type CampaignProjection } from "@/lib/api";
import type { ConversationState } from "@growth/shared";

export interface CampaignScoreboardProps {
  campaignId: string;
  state: ConversationState;
  className?: string;
}

const VERDICT_META: Record<
  NonNullable<CampaignProjection["verdict"]>,
  { label: string; cls: string }
> = {
  on_track: { label: "🟢 ON TRACK", cls: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  stretch: { label: "🟡 STRETCH GOAL", cls: "border-amber-300 bg-amber-50 text-amber-900" },
  unrealistic: { label: "🔴 UNREALISTIC", cls: "border-red-300 bg-red-50 text-red-900" },
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

export function CampaignScoreboard({
  campaignId,
  state,
  className,
}: CampaignScoreboardProps): JSX.Element | null {
  // A target must exist before there's anything to project. Signature of the
  // projection-affecting dimensions drives the debounced refetch.
  const hasTarget =
    state.entityType.kind === "confirmed" && state.product.kind !== "empty";
  const signature = useMemo(
    () =>
      JSON.stringify({
        e: state.entityType,
        p: state.product,
        o: state.objectives,
        t: state.timeline,
      }),
    [state.entityType, state.product, state.objectives, state.timeline],
  );

  // Debounce: only bump the query key 500ms after the last state change so a
  // multi-dim turn (several dims at once) triggers one refetch, not several.
  const [debouncedSig, setDebouncedSig] = useState(signature);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSig(signature), 500);
    return () => clearTimeout(id);
  }, [signature]);

  const query = useQuery({
    queryKey: ["campaign-projection", campaignId, debouncedSig],
    queryFn: () => campaignsApi.computeProjection(campaignId),
    enabled: hasTarget,
  });

  if (!hasTarget) {
    return (
      <aside
        className={`rounded-lg border border-border bg-card p-4 ${className ?? ""}`}
        aria-label="Decision scoreboard"
      >
        <h2 className="text-sm font-semibold text-foreground">Scoreboard</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Scoreboard appears as you build your campaign.
        </p>
      </aside>
    );
  }

  const p = query.data;
  const fmt = (n: number | null, digits = 0) =>
    n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });

  return (
    <aside
      className={`rounded-lg border border-border bg-card p-4 ${className ?? ""}`}
      aria-label="Decision scoreboard"
    >
      <h2 className="text-sm font-semibold text-foreground">Scoreboard</h2>

      {query.isLoading && (
        <div className="mt-3 space-y-2" aria-label="Loading projection">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-muted" />
          ))}
        </div>
      )}

      {query.isError && (
        <div className="mt-3 text-xs text-muted-foreground">
          <p>Couldn&apos;t compute a projection right now.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => query.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {!query.isLoading && !query.isError && p && (
        <div className="mt-3 space-y-2">
          <Row label="Reachable now" value={fmt(p.reachableContacts)} />

          {p.projected != null && (
            <>
              <Row
                label="Closing rate"
                value={
                  <span>
                    {p.closingRate != null ? `${(p.closingRate * 100).toFixed(1)}%` : "—"}
                    {p.closingRateSource === "industry" && (
                      <span
                        className="ml-1 text-xs font-normal italic text-muted-foreground"
                        title="We'll refine this rate based on your campaign outcomes over time"
                      >
                        (industry baseline)
                      </span>
                    )}
                  </span>
                }
              />
              <Row label="Projected" value={`${fmt(p.projected, 1)} units`} />
              <Row label="Goal" value={`${fmt(p.goal)} units`} />
            </>
          )}

          {p.verdict != null && (
            <>
              <Row
                label="Gap"
                value={
                  p.gap == null
                    ? "—"
                    : p.gap > 0
                      ? `${fmt(p.gap, 1)} units short`
                      : `${fmt(Math.abs(p.gap), 1)} units ahead`
                }
              />
              <div
                className={`mt-2 rounded-md border px-2.5 py-1.5 text-center text-xs font-semibold ${VERDICT_META[p.verdict].cls}`}
                role="status"
              >
                {VERDICT_META[p.verdict].label}
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
