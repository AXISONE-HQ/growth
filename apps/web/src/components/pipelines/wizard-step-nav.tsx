"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WizardStep {
  id: string;
  label: string;
}

export function WizardStepNav({
  steps,
  current,
  completed,
  onJump,
}: {
  steps: WizardStep[];
  current: number;
  completed: Set<number>;
  onJump?: (index: number) => void;
}) {
  return (
    <nav aria-label="Wizard progress" className="flex items-center justify-between gap-2">
      {steps.map((step, i) => {
        const isCurrent = i === current;
        const isDone = completed.has(i);
        const reachable = isDone || i <= current;
        return (
          <div key={step.id} className="flex flex-1 items-center gap-2">
            <button
              type="button"
              disabled={!reachable || !onJump}
              onClick={() => reachable && onJump?.(i)}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                isCurrent && "border-primary bg-primary text-primary-foreground",
                !isCurrent && isDone && "border-primary/40 bg-primary/10 text-primary",
                !isCurrent && !isDone && "border-muted bg-background text-muted-foreground",
                reachable && onJump ? "cursor-pointer hover:border-primary/60" : "cursor-default",
              )}
              aria-current={isCurrent ? "step" : undefined}
              aria-label={`${step.label}${isDone ? " (completed)" : ""}`}
            >
              {isDone && !isCurrent ? <Check className="h-4 w-4" /> : i + 1}
            </button>
            <span
              className={cn(
                "hidden text-xs font-medium md:inline",
                isCurrent ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step.label}
            </span>
            {i < steps.length - 1 && (
              <div className={cn("h-px flex-1 bg-border", isDone && "bg-primary/40")} />
            )}
          </div>
        );
      })}
    </nav>
  );
}
