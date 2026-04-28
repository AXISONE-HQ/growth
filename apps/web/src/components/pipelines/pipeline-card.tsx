"use client";

import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Layers, Users, Target as TargetIcon } from "lucide-react";
import type { PipelineSummary } from "@/lib/api";

// Mirrors OBJECTIVE_OPTIONS labels in wizard-schema.ts. Keep in sync.
const OBJECTIVE_LABELS: Record<string, string> = {
  warm_up_lead: "Warm Up Lead",
  book_appointment: "Book Meeting",
  buy_online: "Online Purchase",
  send_quote: "Send Quote",
};

export function PipelineCard({ pipeline }: { pipeline: PipelineSummary }) {
  const objectiveLabel = OBJECTIVE_LABELS[pipeline.objectiveType] ?? pipeline.objectiveType;
  return (
    <Link href={`/settings/pipelines/${pipeline.id}`} className="block">
      <Card className="transition-shadow hover:shadow-md">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="truncate">{pipeline.name}</CardTitle>
              {pipeline.description && (
                <CardDescription className="mt-1 line-clamp-2">{pipeline.description}</CardDescription>
              )}
            </div>
            {!pipeline.isActive && <Badge variant="secondary">Paused</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <TargetIcon className="h-3.5 w-3.5" />
            <span>{objectiveLabel}</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5" />
              <span>{pipeline.stageCount} stage{pipeline.stageCount === 1 ? "" : "s"}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              <span>{pipeline.activeLeadCount} lead{pipeline.activeLeadCount === 1 ? "" : "s"}</span>
            </div>
          </div>
          {pipeline.targets.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {pipeline.targets.slice(0, 3).map((t, i) => (
                <Badge key={i} variant="outline" className="font-normal">
                  {t.metric.replace(/_/g, " ")}: {t.currentProgress ?? 0}/{t.value}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
