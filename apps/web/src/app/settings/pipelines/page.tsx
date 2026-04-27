"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PipelineCard } from "@/components/pipelines/pipeline-card";
import { pipelinesApi, type PipelineSummary } from "@/lib/api";

export default function PipelinesSettingsPage() {
  const [pipelines, setPipelines] = useState<PipelineSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            <PipelineCard key={p.id} pipeline={p} />
          ))}
        </div>
      )}
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
