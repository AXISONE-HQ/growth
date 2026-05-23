/**
 * KAN-968 — Pipelines kanban board (read-only).
 *
 * The visibility layer for the engine proven in slice 2a (KAN-961). One tab
 * per objective-bound pipeline; per-tab kanban with stage columns + deal
 * cards. The AI moves cards through stages; humans observe — no manual drag,
 * no stage mutation from this page.
 *
 * Filter: pipelines.listWithStages already returns isActive=true pipelines;
 * we additionally filter `objectiveId !== null` client-side so the legacy
 * KAN-793 fixture (objectiveId=null) is excluded without archiving/deleting
 * it (respects "still testing" hygiene).
 *
 * Empty-board → CTA to /settings/objectives ("declare an objective and
 * growth will build the pipeline to pursue it").
 *
 * Polling: per-pipeline; lives in PipelineBoard. Each tab refetches at 4s
 * while document.visibilityState === 'visible'.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import Link from "next/link";
import { pipelinesApi, type PipelineWithStages } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PipelineBoard } from "@/components/pipelines/board/pipeline-board";

export default function PipelinesPage() {
  const {
    data: pipelines,
    isLoading,
    isError,
    error,
  } = useQuery<PipelineWithStages[]>({
    queryKey: ["pipelines", "listWithStages"],
    queryFn: () => pipelinesApi.listWithStages(),
  });

  if (isLoading) {
    // KAN-995 — light skeleton matching the board's C.3b treatment.
    return (
      <div className="space-y-4">
        <div className="h-10 w-64 animate-pulse rounded bg-muted" />
        <div className="flex gap-4 overflow-x-auto pb-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="w-72 shrink-0 animate-pulse rounded-[var(--ds-radius-card)] border border-border bg-card p-3"
            >
              <div className="mb-3 h-4 w-24 rounded bg-muted" />
              <div className="h-16 rounded bg-muted/60" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    // KAN-995 — light error block matching the board's C.3b treatment.
    return (
      <div
        role="alert"
        className="rounded-[var(--ds-radius-input)] border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] p-4 text-sm text-[var(--ds-danger-text)]"
      >
        Failed to load pipelines: {error instanceof Error ? error.message : "Unknown error"}
      </div>
    );
  }

  // Filter to objective-bound pipelines only. The fixture pipeline (KAN-793
  // bootstrap, objectiveId=null) is intentionally excluded — it stays
  // active for routing fallback but doesn't belong on this board.
  const boardPipelines = (pipelines ?? []).filter(
    (p): p is PipelineWithStages => p.objectiveId !== null,
  );

  if (boardPipelines.length === 0) {
    return (
      <EmptyState
        icon={Workflow}
        heading="No pipelines yet"
        body="Declare an objective and growth will build the pipeline to pursue it."
        action={
          <Button asChild>
            <Link href="/settings/objectives">Go to Objectives</Link>
          </Button>
        }
      />
    );
  }

  // First pipeline as default tab. We don't degenerate the tab strip when
  // count=1 — keep it consistent so the UI doesn't shapeshift as the user
  // declares more objectives.
  const defaultValue = boardPipelines[0]!.id;

  return (
    <div className="space-y-4">
      <Tabs defaultValue={defaultValue} className="w-full">
        {/* KAN-995 — pipeline-selector TabsList: drop the slate-900 strip
            override and let the canonical B.1 pill TabsList styling apply
            (bg-muted container, gradient-active triggers). Keep h-auto +
            flex-wrap so multi-pipeline strips can wrap; keep justify-start
            so triggers cluster left rather than centering. */}
        <TabsList
          data-testid="pipeline-tabs"
          className="h-auto flex-wrap justify-start"
        >
          {boardPipelines.map((p) => (
            <TabsTrigger
              key={p.id}
              value={p.id}
              data-testid="pipeline-tab"
            >
              {p.name}
            </TabsTrigger>
          ))}
        </TabsList>

        {boardPipelines.map((p) => (
          <TabsContent key={p.id} value={p.id} className="mt-4">
            <PipelineBoard pipeline={p} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
