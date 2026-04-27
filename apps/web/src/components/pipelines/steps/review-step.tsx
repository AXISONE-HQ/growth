"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  KNOWLEDGE_CATEGORY_OPTIONS,
  OBJECTIVE_OPTIONS,
  TARGET_METRIC_OPTIONS,
  TARGET_PERIOD_OPTIONS,
  type WizardData,
} from "../wizard-schema";

export function ReviewStep({
  data,
  microObjectiveNames,
  onBack,
  onSubmit,
  submitting,
  submitError,
}: {
  data: WizardData;
  microObjectiveNames: string[];
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  submitError: string | null;
}) {
  const objectiveLabel =
    OBJECTIVE_OPTIONS.find((o) => o.value === data.objectiveType)?.label ?? data.objectiveType;
  const enabledFilters = data.filters.filter((f) => f.enabled);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Review your configuration. Stages, micro-objectives, targets, and knowledge filters can be edited
        from the pipeline detail page once created.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{data.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {data.description && <p className="text-muted-foreground">{data.description}</p>}

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Objective</div>
            <div className="mt-1">{objectiveLabel}</div>
            {data.objectiveDescription && (
              <p className="mt-1 text-muted-foreground">{data.objectiveDescription}</p>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Stages ({data.stages.length})
            </div>
            <ol className="mt-1 space-y-0.5">
              {data.stages.map((s, i) => (
                <li key={s.localId} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{i + 1}.</span>
                  <span>{s.name}</span>
                  {s.isInitial && <Badge variant="outline" className="text-xs">Initial</Badge>}
                  {s.isTerminal && <Badge variant="outline" className="text-xs">Terminal</Badge>}
                </li>
              ))}
            </ol>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Micro-objectives ({microObjectiveNames.length})
            </div>
            {microObjectiveNames.length === 0 ? (
              <div className="mt-1 text-muted-foreground">None selected</div>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {microObjectiveNames.map((n) => (
                  <Badge key={n} variant="secondary" className="font-normal">
                    {n}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Targets ({data.targets.length})
            </div>
            {data.targets.length === 0 ? (
              <div className="mt-1 text-muted-foreground">None set</div>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {data.targets.map((t, i) => {
                  const m = TARGET_METRIC_OPTIONS.find((o) => o.value === t.metric)?.label ?? t.metric;
                  const p = TARGET_PERIOD_OPTIONS.find((o) => o.value === t.period)?.label ?? t.period;
                  return (
                    <li key={i}>
                      {m} — {p.toLowerCase()}: <strong>{t.value}</strong>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Knowledge filters
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {enabledFilters.length === 0 ? (
                <span className="text-muted-foreground">No categories enabled</span>
              ) : (
                enabledFilters.map((f) => {
                  const lbl = KNOWLEDGE_CATEGORY_OPTIONS.find((o) => o.value === f.knowledgeCategory)?.label;
                  return (
                    <Badge key={f.knowledgeCategory} variant="outline" className="text-xs">
                      {lbl}
                    </Badge>
                  );
                })
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {submitError && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="py-3 text-sm text-destructive">{submitError}</CardContent>
        </Card>
      )}

      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button type="button" onClick={onSubmit} disabled={submitting}>
          {submitting ? "Creating..." : "Create pipeline"}
        </Button>
      </div>
    </div>
  );
}
