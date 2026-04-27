"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { basicsSchema, OBJECTIVE_OPTIONS, type BasicsInput } from "../wizard-schema";

export function BasicsStep({
  defaultValues,
  onSubmit,
}: {
  defaultValues: Partial<BasicsInput>;
  onSubmit: (data: BasicsInput) => void;
}) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<BasicsInput>({
    resolver: zodResolver(basicsSchema),
    defaultValues: {
      name: defaultValues.name ?? "",
      description: defaultValues.description ?? "",
      objectiveType: defaultValues.objectiveType ?? "send_quote",
      objectiveDescription: defaultValues.objectiveDescription ?? "",
    },
  });

  const objective = watch("objectiveType");

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="name">Pipeline name</Label>
        <Input id="name" placeholder="e.g. Enterprise Sales" {...register("name")} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description (optional)</Label>
        <Textarea
          id="description"
          rows={3}
          placeholder="What kind of leads flow through this pipeline?"
          {...register("description")}
        />
        {errors.description && <p className="text-xs text-destructive">{errors.description.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="objectiveType">Primary objective</Label>
        <Select value={objective} onValueChange={(v) => setValue("objectiveType", v as BasicsInput["objectiveType"], { shouldValidate: true })}>
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
        <p className="text-xs text-muted-foreground">
          {OBJECTIVE_OPTIONS.find((o) => o.value === objective)?.hint}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="objectiveDescription">Objective detail (optional)</Label>
        <Textarea
          id="objectiveDescription"
          rows={3}
          placeholder="Add nuance the AI should respect when working leads in this pipeline."
          {...register("objectiveDescription")}
        />
        {errors.objectiveDescription && (
          <p className="text-xs text-destructive">{errors.objectiveDescription.message}</p>
        )}
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit">Continue</Button>
      </div>
    </form>
  );
}
