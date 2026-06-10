"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PipelineCard } from "@/components/pipelines/pipeline-card";
import { ReassignmentModal } from "./_components/ReassignmentModal";
import { pipelinesApi, type PipelineSummary, type PipelineDeleteResult } from "@/lib/api";

export default function PipelinesSettingsPage() {
  const [pipelines, setPipelines] = useState<PipelineSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // KAN-1169 — Reassignment modal state. `deleteTargetId` controls which
  // pipeline is being deleted; `lastResult` shows a transient confirmation
  // toast after success.
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<PipelineDeleteResult | null>(null);

  const refetch = () => {
    pipelinesApi
      .list()
      .then((rows) => setPipelines(rows))
      .catch((e) => setError(e?.message ?? "Failed to load pipelines"));
  };

  useEffect(() => {
    let cancelled = false;
    pipelinesApi
      .list()
      .then((rows) => {
        if (!cancelled) setPipelines(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? "Failed to load pipelines");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleDeleted(result: PipelineDeleteResult) {
    setLastResult(result);
    setDeleteTargetId(null);
    refetch();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pipelines</h1>
          <p className="text-sm text-muted-foreground">
            Define how leads move through stages, what the AI optimizes for, and how progress is measured.
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/pipelines/new">
            <Plus className="h-4 w-4" />
            New pipeline
          </Link>
        </Button>
      </header>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Couldn&apos;t load pipelines</CardTitle>
            <CardDescription className="text-destructive/80">{error}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {pipelines === null && !error && (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 w-2/3 rounded bg-muted" />
                <div className="mt-2 h-3 w-full rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="h-3 w-1/2 rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {pipelines && pipelines.length === 0 && <EmptyState />}

      {pipelines && pipelines.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {pipelines.map((p) => (
            <div key={p.id} className="relative">
              <PipelineCard pipeline={p} />
              {/* KAN-1169 — per-card delete trigger (absolute-positioned over the
                  card; PipelineCard wraps a <Link>, so this lives outside it). */}
              <button
                type="button"
                aria-label={`Delete ${p.name}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDeleteTargetId(p.id);
                }}
                className="absolute right-3 top-3 z-10 rounded-md bg-background/80 p-1.5 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100 group-focus-within:opacity-100"
                style={{ opacity: 1 }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* KAN-1169 — Transient success banner. Surfaces the outcome path so the
          operator sees whether the pipeline was deleted vs archived. */}
      {lastResult ? (
        <div
          className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          role="status"
        >
          {lastResult.outcome === 'pipeline.deleted_empty'
            ? `Pipeline deleted.`
            : lastResult.outcome === 'pipeline.archived_empty'
              ? `Pipeline archived (stage history preserved).`
              : `${lastResult.dealCount} deals moved; pipeline archived.`}
        </div>
      ) : null}

      <ReassignmentModal
        pipelineId={deleteTargetId}
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null);
        }}
        onDeleted={handleDeleted}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="rounded-full bg-muted p-3">
          <Workflow className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="max-w-md space-y-1">
          <h3 className="text-lg font-semibold">No pipelines yet</h3>
          <p className="text-sm text-muted-foreground">
            A pipeline defines what the AI is trying to accomplish for a lead. Create your first pipeline to
            unlock guided multi-stage flows — quote sending, meeting booking, reactivation, and more.
          </p>
        </div>
        <Button asChild className="mt-2">
          <Link href="/settings/pipelines/new">
            <Plus className="h-4 w-4" />
            Create your first pipeline
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
