"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { OBJECTIVE_OPTIONS } from "./wizard-schema";
import { pipelinesApi, type PipelineDetail, type PipelineObjectiveType } from "@/lib/api";

export function EditPipelineDrawer({
  open,
  onOpenChange,
  pipeline,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipeline: PipelineDetail;
  onSaved: (updated: PipelineDetail) => void;
}) {
  const [name, setName] = useState(pipeline.name);
  const [description, setDescription] = useState(pipeline.description ?? "");
  const [objectiveType, setObjectiveType] = useState<PipelineObjectiveType>(pipeline.objectiveType);
  const [objectiveDescription, setObjectiveDescription] = useState(pipeline.objectiveDescription ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await pipelinesApi.update({
        id: pipeline.id,
        name,
        description: description || null,
        objectiveType,
        objectiveDescription: objectiveDescription || null,
      });
      onSaved(updated);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="space-y-5">
        <SheetHeader>
          <SheetTitle>Edit pipeline</SheetTitle>
          <SheetDescription>
            Update basics in place. Use the wizard to change stages or micro-objective associations.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="objectiveType">Objective</Label>
          <Select value={objectiveType} onValueChange={(v) => setObjectiveType(v as PipelineObjectiveType)}>
            <SelectTrigger id="objectiveType">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OBJECTIVE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="objectiveDescription">Objective detail</Label>
          <Textarea
            id="objectiveDescription"
            rows={3}
            value={objectiveDescription}
            onChange={(e) => setObjectiveDescription(e.target.value)}
          />
        </div>

        {error && <div className="text-sm text-destructive">{error}</div>}

        <SheetFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
