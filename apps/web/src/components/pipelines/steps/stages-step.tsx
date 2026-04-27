"use client";

import { useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import {
  defaultStages,
  newLocalId,
  stagesSchema,
  type StageInput,
} from "../wizard-schema";

export function StagesStep({
  defaultStages: initial,
  onSubmit,
  onBack,
}: {
  defaultStages: StageInput[];
  onSubmit: (stages: StageInput[]) => void;
  onBack: () => void;
}) {
  const [stages, setStages] = useState<StageInput[]>(
    initial.length > 0 ? initial : defaultStages(),
  );
  const [errors, setErrors] = useState<string[]>([]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = stages.findIndex((s) => s.localId === active.id);
    const newIdx = stages.findIndex((s) => s.localId === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    setStages(arrayMove(stages, oldIdx, newIdx));
  }

  function update(idx: number, patch: Partial<StageInput>) {
    setStages((cur) => cur.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  function setInitial(idx: number) {
    // Exactly-one invariant: any toggle to true demotes others.
    setStages((cur) => cur.map((s, i) => ({ ...s, isInitial: i === idx })));
  }

  function addStage() {
    setStages((cur) => [
      ...cur,
      { localId: newLocalId(), name: "", isInitial: false, isTerminal: false },
    ]);
  }

  function removeStage(idx: number) {
    setStages((cur) => cur.filter((_, i) => i !== idx));
  }

  function next() {
    const r = stagesSchema.safeParse({ stages });
    if (!r.success) {
      setErrors(r.error.issues.map((i) => i.message));
      return;
    }
    setErrors([]);
    onSubmit(stages);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Drag to reorder. Mark exactly one stage as <strong>initial</strong> (where new leads land) and any
          number as <strong>terminal</strong> (closed-won, closed-lost, etc.).
        </p>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={stages.map((s) => s.localId)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {stages.map((stage, idx) => (
              <SortableStageRow
                key={stage.localId}
                stage={stage}
                onChange={(patch) => update(idx, patch)}
                onSetInitial={() => setInitial(idx)}
                onRemove={() => removeStage(idx)}
                canRemove={stages.length > 1}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <Button type="button" variant="outline" size="sm" onClick={addStage}>
        <Plus className="h-4 w-4" />
        Add stage
      </Button>

      {errors.length > 0 && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="space-y-1 py-3 text-sm text-destructive">
            {errors.map((e, i) => (
              <div key={i}>• {e}</div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={next}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function SortableStageRow({
  stage,
  onChange,
  onSetInitial,
  onRemove,
  canRemove,
}: {
  stage: StageInput;
  onChange: (patch: Partial<StageInput>) => void;
  onSetInitial: () => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.localId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Card ref={setNodeRef} style={style} className="border-border">
      <CardContent className="flex items-center gap-3 py-3">
        <button
          type="button"
          className="cursor-grab text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
          aria-label="Drag stage"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <Input
          value={stage.name}
          placeholder="Stage name"
          onChange={(e) => onChange({ name: e.target.value })}
          className="flex-1"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Label className="cursor-pointer text-xs">
            <Switch checked={stage.isInitial} onCheckedChange={() => onSetInitial()} className="mr-1.5 inline-flex align-middle" />
            Initial
          </Label>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Label className="cursor-pointer text-xs">
            <Switch
              checked={stage.isTerminal}
              onCheckedChange={(v) => onChange({ isTerminal: v })}
              className="mr-1.5 inline-flex align-middle"
            />
            Terminal
          </Label>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Remove stage"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
