"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { KNOWLEDGE_CATEGORY_OPTIONS, type KnowledgeFilterInput } from "../wizard-schema";
import type { KnowledgeCategory } from "@growth/shared";

export function KnowledgeFiltersStep({
  defaultFilters,
  onSubmit,
  onBack,
}: {
  defaultFilters: KnowledgeFilterInput[];
  onSubmit: (filters: KnowledgeFilterInput[]) => void;
  onBack: () => void;
}) {
  const initial = new Map<KnowledgeCategory, boolean>(
    defaultFilters.map((f) => [f.knowledgeCategory, f.enabled]),
  );
  const [enabled, setEnabled] = useState<Record<KnowledgeCategory, boolean>>(() => {
    const out = {} as Record<KnowledgeCategory, boolean>;
    for (const opt of KNOWLEDGE_CATEGORY_OPTIONS) {
      out[opt.value] = initial.get(opt.value) ?? true; // default-enabled
    }
    return out;
  });

  function build(): KnowledgeFilterInput[] {
    return KNOWLEDGE_CATEGORY_OPTIONS.map((opt) => ({
      knowledgeCategory: opt.value,
      enabled: enabled[opt.value],
    }));
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Knowledge filters control which categories of your knowledge base the AI consults when working leads
        in this pipeline. Disable categories irrelevant to this objective to keep the AI focused.
      </p>

      <div className="space-y-2">
        {KNOWLEDGE_CATEGORY_OPTIONS.map((opt) => (
          <Card key={opt.value} className="border-border">
            <CardContent className="flex items-start gap-3 py-3">
              <Switch
                checked={enabled[opt.value]}
                onCheckedChange={(v) => setEnabled((cur) => ({ ...cur, [opt.value]: v }))}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{opt.label}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">{opt.hint}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={() => onSubmit(build())}>
          Continue
        </Button>
      </div>
    </div>
  );
}
