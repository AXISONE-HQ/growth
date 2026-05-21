/**
 * KAN-968 — Per-pipeline kanban board.
 *
 * Renders the columns of a single Pipeline (one tab worth of content):
 *   - one column per Stage in Stage.order
 *   - cards = deals from KAN-967's deals.listByPipeline grouped response
 *   - 50-cap + "+N more" enforced server-side; UI just renders truncatedCount
 *
 * Polling: react-query `refetchInterval` at 4s, gated on
 * `document.visibilityState === 'visible'` so we don't burn cycles when the
 * tab is backgrounded. Keep previous data during refetch (no flicker).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { dealsApi, type PipelineWithStages } from "@/lib/api";
import { StageColumn } from "./stage-column";

export interface PipelineBoardProps {
  pipeline: PipelineWithStages;
  /** Injected for deterministic age strings in tests. */
  now?: Date;
}

const POLL_INTERVAL_MS = 4000;

export function PipelineBoard({ pipeline, now }: PipelineBoardProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["board", "deals.listByPipeline", pipeline.id],
    queryFn: () => dealsApi.listByPipeline(pipeline.id),
    // Polling: skip when the tab isn't visible (cheap heuristic, no cost
    // when the user is on another tab). The PRD chose polling for v1; SSE
    // upgrade tracked under KAN-969.
    refetchInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? false
        : POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  // First-load skeleton: keep it cheap — column shells only, no shimmer.
  // After first success, polling-refresh uses previous data (no flicker).
  if (isLoading) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-4" data-testid="board-loading">
        {pipeline.stages.map((stage) => (
          <div
            key={stage.id}
            className="w-72 shrink-0 animate-pulse rounded-md bg-slate-900/50 p-3"
          >
            <div className="mb-3 h-4 w-24 rounded bg-slate-800" />
            <div className="space-y-2">
              <div className="h-16 rounded bg-slate-800/60" />
              <div className="h-16 rounded bg-slate-800/60" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div
        role="alert"
        className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300"
      >
        Failed to load board: {error instanceof Error ? error.message : "Unknown error"}
      </div>
    );
  }

  // Build a stageId → group lookup. The backend returns one group per stage
  // (even empty ones), but the UI defensively handles missing entries by
  // rendering an empty column.
  const groupByStageId = new Map(
    (data?.stages ?? []).map((s) => [s.stageId, s]),
  );

  return (
    <div
      className="flex gap-4 overflow-x-auto pb-4"
      data-testid="board-kanban-columns"
    >
      {pipeline.stages.map((stage) => {
        const group = groupByStageId.get(stage.id);
        return (
          <StageColumn
            key={stage.id}
            stage={stage}
            outcomeType={stage.outcomeType}
            deals={group?.deals ?? []}
            truncatedCount={group?.truncatedCount ?? 0}
            now={now}
          />
        );
      })}
    </div>
  );
}
