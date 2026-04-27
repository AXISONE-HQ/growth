"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { pipelineMicroObjectivesApi, type MicroObjective } from "@/lib/api";

export function MicroObjectivesStep({
  selectedIds,
  onSubmit,
  onBack,
}: {
  selectedIds: string[];
  onSubmit: (ids: string[]) => void;
  onBack: () => void;
}) {
  const [available, setAvailable] = useState<MicroObjective[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(selectedIds));

  useEffect(() => {
    pipelineMicroObjectivesApi
      .listAvailable()
      .then(setAvailable)
      .catch((e) => setError(e?.message ?? "Failed to load micro-objectives"));
  }, []);

  function toggle(id: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Micro-objectives are smaller wins the AI can pursue along the way (e.g. <em>identify decision-maker</em>,
        <em> qualify budget</em>). Pick the ones relevant to this pipeline. You can change this later.
      </p>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {available === null && !error && (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="h-12 py-3" />
            </Card>
          ))}
        </div>
      )}

      {available && available.length === 0 && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            No micro-objectives configured for your tenant yet. Skip this step — you can attach them later.
          </CardContent>
        </Card>
      )}

      {available && available.length > 0 && (
        <div className="space-y-2">
          {available.map((mo) => (
            <Card key={mo.id} className="border-border">
              <CardContent className="flex items-start gap-3 py-3">
                <Switch checked={picked.has(mo.id)} onCheckedChange={() => toggle(mo.id)} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{mo.name}</span>
                    {mo.isDefault && <Badge variant="outline" className="text-xs">Platform default</Badge>}
                  </div>
                  {mo.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{mo.description}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={() => onSubmit(Array.from(picked))}>
          Continue ({picked.size})
        </Button>
      </div>
    </div>
  );
}
