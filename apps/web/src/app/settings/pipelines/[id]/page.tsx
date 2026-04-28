"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { EditPipelineDrawer } from "@/components/pipelines/edit-drawer";
import { PipelineKnowledgeFilter } from "@/components/knowledge/pipeline-knowledge-filter";
import { OBJECTIVE_OPTIONS } from "@/components/pipelines/wizard-schema";
import { pipelinesApi, type PipelineDetail, type KnowledgeCategory } from "@/lib/api";

export default function PipelineDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [pipeline, setPipeline] = useState<PipelineDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!params?.id) return;
    pipelinesApi.getById(params.id).then(setPipeline).catch((e) => setError(e?.message));
  }, [params?.id]);

  async function onDelete() {
    if (!pipeline) return;
    if (!confirm(`Delete pipeline "${pipeline.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await pipelinesApi.delete(pipeline.id);
      router.push("/settings/pipelines");
    } catch (e) {
      setError((e as Error)?.message ?? "Delete failed");
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Couldn&apos;t load pipeline</CardTitle>
            <CardDescription className="text-destructive/80">{error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="h-6 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const objectiveLabel =
    OBJECTIVE_OPTIONS.find((o) => o.value === pipeline.objectiveType)?.label ?? pipeline.objectiveType;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground">
          <Link href="/settings/pipelines">
            <ArrowLeft className="h-4 w-4" />
            All pipelines
          </Link>
        </Button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{pipeline.name}</h1>
            {pipeline.description && (
              <p className="mt-1 text-sm text-muted-foreground">{pipeline.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
            <Button variant="outline" size="sm" onClick={onDelete} disabled={deleting}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Objective</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <div>{objectiveLabel}</div>
          {pipeline.objectiveDescription && (
            <p className="text-muted-foreground">{pipeline.objectiveDescription}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stages</CardTitle>
          <CardDescription>{pipeline.stages.length} stages</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {pipeline.stages.map((s, i) => (
              <li key={s.id ?? i} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{i + 1}.</span>
                  <span>{s.name}</span>
                </div>
                <div className="flex items-center gap-1">
                  {s.isInitial && <Badge variant="outline" className="text-xs">Initial</Badge>}
                  {s.isTerminal && <Badge variant="outline" className="text-xs">Terminal</Badge>}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {pipeline.targets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Targets</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {pipeline.targets.map((t) => (
                <li key={t.id} className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t.metric.replace(/_/g, " ")} — {t.period}
                  </span>
                  <span>
                    <strong>{t.currentProgress ?? 0}</strong> / {t.value}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {pipeline.microObjectives.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Micro-objectives</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {pipeline.microObjectives.map((mo) => (
                <Badge key={mo.microObjectiveId} variant="secondary" className="font-normal">
                  {mo.name ?? mo.microObjectiveId}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* KAN-708 — interactive per-pipeline knowledge filter editor.
          Replaces KAN-702 PR B's read-only Badge list with a toggle UI. */}
      <PipelineKnowledgeFilter
        pipelineId={pipeline.id}
        initialEnabledCategories={pipeline.knowledgeFilters.map((f) => f.knowledgeCategory as KnowledgeCategory)}
      />

      <Separator />
      <p className="text-xs text-muted-foreground">
        Pipeline ID: <code className="font-mono">{pipeline.id}</code>
      </p>

      <EditPipelineDrawer
        open={editing}
        onOpenChange={setEditing}
        pipeline={pipeline}
        onSaved={(updated) => setPipeline(updated)}
      />
    </div>
  );
}
