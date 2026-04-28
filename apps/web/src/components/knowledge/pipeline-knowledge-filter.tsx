"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { knowledgeFiltersApi } from "@/lib/api";
import type { KnowledgeCategory } from "@growth/shared";
import { KNOWLEDGE_CATEGORY_OPTIONS } from "@/components/pipelines/wizard-schema";

/**
 * KAN-708 — per-pipeline knowledge filter editor.
 *
 * Lives on the pipeline detail page. Renders 6 toggles (one per canonical
 * KnowledgeCategory value from KAN-702 PR #54). Default: all 6 enabled.
 *
 * Persistence: tRPC `knowledgeFilters.upsert` (enable) or `knowledgeFilters.delete`
 * (disable) on each toggle. Existing rows on the pipeline come from
 * `pipelinesApi.getById` → KnowledgeFilter[]. The presence of a row = enabled;
 * absence = disabled.
 */
export function PipelineKnowledgeFilter({
  pipelineId,
  initialEnabledCategories,
}: {
  pipelineId: string;
  initialEnabledCategories: KnowledgeCategory[];
}) {
  // Default-enable: if the tenant has never touched the filter, all 6 categories
  // count as enabled. Once a tenant has saved at least one filter row, only
  // the enabled categories appear in initialEnabledCategories.
  const seedAllEnabled = initialEnabledCategories.length === 0;
  const [enabled, setEnabled] = useState<Record<KnowledgeCategory, boolean>>(() => {
    const out = {} as Record<KnowledgeCategory, boolean>;
    for (const opt of KNOWLEDGE_CATEGORY_OPTIONS) {
      out[opt.value] = seedAllEnabled || initialEnabledCategories.includes(opt.value);
    }
    return out;
  });
  const [busy, setBusy] = useState<KnowledgeCategory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialEnabledCategories.length === 0) return;
    // Re-seed if parent prop changes (e.g., after a save round-trip)
    setEnabled(() => {
      const out = {} as Record<KnowledgeCategory, boolean>;
      for (const opt of KNOWLEDGE_CATEGORY_OPTIONS) {
        out[opt.value] = initialEnabledCategories.includes(opt.value);
      }
      return out;
    });
  }, [initialEnabledCategories]);

  async function toggle(category: KnowledgeCategory, next: boolean) {
    setBusy(category);
    setError(null);
    try {
      if (next) {
        await knowledgeFiltersApi.upsert({
          pipelineId,
          knowledgeCategory: category,
          includeRule: {},
          excludeRule: {},
        });
      } else {
        await knowledgeFiltersApi.delete(pipelineId, category);
      }
      setEnabled((cur) => ({ ...cur, [category]: next }));
    } catch (e) {
      setError((e as Error)?.message ?? "Save failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Knowledge filter</CardTitle>
        <CardDescription>
          Choose which knowledge categories this pipeline consults. Disabled categories are hidden from the
          AI when working leads in this pipeline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {KNOWLEDGE_CATEGORY_OPTIONS.map((opt) => (
          <div key={opt.value} className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              checked={enabled[opt.value]}
              onCheckedChange={(v) => toggle(opt.value, v)}
              disabled={busy !== null}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{opt.label}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">{opt.hint}</p>
            </div>
            {busy === opt.value && (
              <span className="text-xs text-muted-foreground">Saving...</span>
            )}
          </div>
        ))}
        {error && <div className="pt-2 text-sm text-destructive">{error}</div>}
      </CardContent>
    </Card>
  );
}
