"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WizardStepNav, type WizardStep } from "./wizard-step-nav";
import { BasicsStep } from "./steps/basics-step";
import { StagesStep } from "./steps/stages-step";
import { MicroObjectivesStep } from "./steps/micro-objectives-step";
import { TargetsStep } from "./steps/targets-step";
import { KnowledgeFiltersStep } from "./steps/knowledge-filters-step";
import { ReviewStep } from "./steps/review-step";
import {
  defaultStages,
  KNOWLEDGE_CATEGORY_OPTIONS,
  type BasicsInput,
  type KnowledgeFilterInput,
  type StageInput,
  type TargetInput,
  type WizardData,
} from "./wizard-schema";
import {
  knowledgeFiltersApi,
  pipelineMicroObjectivesApi,
  pipelinesApi,
  targetsApi,
  type MicroObjective,
} from "@/lib/api";

const STEPS: WizardStep[] = [
  { id: "basics", label: "Basics" },
  { id: "stages", label: "Stages" },
  { id: "micro-objectives", label: "Micro-objectives" },
  { id: "targets", label: "Targets" },
  { id: "knowledge-filters", label: "Knowledge" },
  { id: "review", label: "Review" },
];

function emptyWizardData(): WizardData {
  return {
    name: "",
    description: "",
    objectiveType: "send_quote",
    objectiveDescription: "",
    stages: defaultStages(),
    microObjectiveIds: [],
    targets: [],
    filters: KNOWLEDGE_CATEGORY_OPTIONS.map((opt) => ({
      knowledgeCategory: opt.value,
      enabled: true,
    })),
  };
}

export function PipelineWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [completed, setCompleted] = useState<Set<number>>(new Set());
  const [data, setData] = useState<WizardData>(() => emptyWizardData());
  const [available, setAvailable] = useState<MicroObjective[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Pre-fetch available micro-objectives so the review step can show names.
  useEffect(() => {
    pipelineMicroObjectivesApi.listAvailable().then(setAvailable).catch(() => {});
  }, []);

  function advance(idx: number) {
    setCompleted((cur) => new Set(cur).add(idx));
    setStep(Math.min(idx + 1, STEPS.length - 1));
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // 1. Create the pipeline + stages in one nested write.
      const created = await pipelinesApi.create({
        name: data.name,
        description: data.description ?? null,
        objectiveType: data.objectiveType,
        objectiveDescription: data.objectiveDescription ?? null,
        order: 0,
        stages: data.stages.map((s, i) => ({
          name: s.name,
          order: i,
          isInitial: s.isInitial,
          isTerminal: s.isTerminal,
        })),
      });
      const pipelineId = (created as { id: string }).id;

      // 2. Set micro-objectives (replace-all semantics — fine for first save).
      if (data.microObjectiveIds.length > 0) {
        await pipelineMicroObjectivesApi.setForPipeline(pipelineId, data.microObjectiveIds);
      }

      // 3. Targets (one upsert per row).
      for (const t of data.targets) {
        await targetsApi.upsert({
          pipelineId,
          metric: t.metric,
          period: t.period,
          value: t.value,
        });
      }

      // 4. Knowledge filters — only persist enabled categories. Disabled
      // categories are absent from the table = "not filtered in" by the
      // backend (default permissive). We don't write disabled rows.
      for (const f of data.filters.filter((x) => x.enabled)) {
        await knowledgeFiltersApi.upsert({
          pipelineId,
          knowledgeCategory: f.knowledgeCategory,
          includeRule: {},
          excludeRule: {},
        });
      }

      router.push(`/settings/pipelines/${pipelineId}`);
    } catch (e) {
      setSubmitError((e as Error)?.message ?? "Failed to create pipeline");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New pipeline</h1>
        <p className="text-sm text-muted-foreground">
          Define a new lead-flow shape. You can edit any of these settings later.
        </p>
      </header>

      <Card>
        <CardHeader>
          <WizardStepNav steps={STEPS} current={step} completed={completed} onJump={(i) => setStep(i)} />
          <CardTitle className="pt-4 text-lg">{STEPS[step].label}</CardTitle>
        </CardHeader>
        <CardContent>
          {step === 0 && (
            <BasicsStep
              defaultValues={data}
              onSubmit={(b: BasicsInput) => {
                setData((cur) => ({ ...cur, ...b }));
                advance(0);
              }}
            />
          )}
          {step === 1 && (
            <StagesStep
              defaultStages={data.stages}
              onSubmit={(s: StageInput[]) => {
                setData((cur) => ({ ...cur, stages: s }));
                advance(1);
              }}
              onBack={() => setStep(0)}
            />
          )}
          {step === 2 && (
            <MicroObjectivesStep
              selectedIds={data.microObjectiveIds}
              onSubmit={(ids) => {
                setData((cur) => ({ ...cur, microObjectiveIds: ids }));
                advance(2);
              }}
              onBack={() => setStep(1)}
            />
          )}
          {step === 3 && (
            <TargetsStep
              defaultTargets={data.targets}
              onSubmit={(t: TargetInput[]) => {
                setData((cur) => ({ ...cur, targets: t }));
                advance(3);
              }}
              onBack={() => setStep(2)}
            />
          )}
          {step === 4 && (
            <KnowledgeFiltersStep
              defaultFilters={data.filters}
              onSubmit={(f: KnowledgeFilterInput[]) => {
                setData((cur) => ({ ...cur, filters: f }));
                advance(4);
              }}
              onBack={() => setStep(3)}
            />
          )}
          {step === 5 && (
            <ReviewStep
              data={data}
              microObjectiveNames={data.microObjectiveIds
                .map((id) => available.find((m) => m.id === id)?.name)
                .filter((n): n is string => !!n)}
              onBack={() => setStep(4)}
              onSubmit={submit}
              submitting={submitting}
              submitError={submitError}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
