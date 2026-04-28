"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TARGET_METRIC_OPTIONS,
  TARGET_PERIOD_OPTIONS,
  type TargetInput,
} from "../wizard-schema";
import type { TargetMetric, TargetPeriod } from "@/lib/api";

export function TargetsStep({
  defaultTargets,
  onSubmit,
  onBack,
}: {
  defaultTargets: TargetInput[];
  onSubmit: (targets: TargetInput[]) => void;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<TargetInput[]>(defaultTargets);

  function add() {
    setRows((cur) => [...cur, { metric: "appointments_booked", period: "monthly", value: 0 }]);
  }
  function remove(idx: number) {
    setRows((cur) => cur.filter((_, i) => i !== idx));
  }
  function patch(idx: number, p: Partial<TargetInput>) {
    setRows((cur) => cur.map((r, i) => (i === idx ? { ...r, ...p } : r)));
  }

  // Local validation: metric+period combinations must be unique.
  const dupes = new Set<string>();
  const seen = new Set<string>();
  rows.forEach((r) => {
    const k = `${r.metric}|${r.period}`;
    if (seen.has(k)) dupes.add(k);
    else seen.add(k);
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Targets calibrate the AI's pacing and surface progress on the dashboard. Skip this step if you'd
        rather wire targets later.
      </p>

      <div className="space-y-2">
        {rows.map((r, idx) => {
          const dupe = dupes.has(`${r.metric}|${r.period}`);
          return (
            <Card key={idx} className="border-border">
              <CardContent className="flex items-end gap-3 py-3">
                <div className="flex-1 space-y-1">
                  <Select
                    value={r.metric}
                    onValueChange={(v) => patch(idx, { metric: v as TargetMetric })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TARGET_METRIC_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1 space-y-1">
                  <Select
                    value={r.period}
                    onValueChange={(v) => patch(idx, { period: v as TargetPeriod })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TARGET_PERIOD_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32 space-y-1">
                  <Input
                    type="number"
                    min={0}
                    value={r.value}
                    onChange={(e) => patch(idx, { value: Number(e.target.value) || 0 })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(idx)}
                  aria-label="Remove target"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
              {dupe && (
                <CardContent className="-mt-2 pb-3 text-xs text-destructive">
                  Duplicate metric/period — only the last entry will save.
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="h-4 w-4" />
        Add target
      </Button>

      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={() => onSubmit(rows.filter((r) => !dupes.has(`${r.metric}|${r.period}`)))}>
          Continue
        </Button>
      </div>
    </div>
  );
}
