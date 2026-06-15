"use client";

/**
 * KAN-1188 G3 — Chat refinement input with 4-family chip pre-anchors.
 *
 * Above the textarea: 4 chips (Stages / First Actions / Audience / Dimension)
 * — click pre-fills the input with a structured starter for that family.
 * Each chip has a tooltip with examples. The refiner LLM still classifies
 * naive operator NL; chips are operator-discoverability scaffolding.
 *
 * Y3 lock: no optimistic update. Send disabled while pending; LoadingState
 * rendered inline.
 *
 * G6 — bounds_violation banner persists for 8s under input then auto-dismisses.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Send, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "../../_components/LoadingState";
import type { RefineActionPlanResult } from "@/lib/api";

export interface ChatRefinementInputProps {
  onSend: (message: string) => void;
  isRefining: boolean;
  refineResult: RefineActionPlanResult | null;
  onReloadFromConflict: () => void;
  className?: string;
}

interface AxisChip {
  label: string;
  starter: string;
  description: string;
}

const AXIS_CHIPS: AxisChip[] = [
  {
    label: "Stages",
    starter: "Rename stage 1 to ",
    description: "Rename / reorder / add / remove a Pipeline stage",
  },
  {
    label: "First Actions",
    starter: "Change Day 0 of the first pipeline to ",
    description: "Edit channel / day / intent of a first action",
  },
  {
    label: "Audience",
    starter: "Narrow the audience to ",
    description: "Replace the audience conditions for the whole Campaign",
  },
  {
    label: "Dimension",
    starter: "Raise the goal target to ",
    description: "Edit goal / timeline / product — top-level Campaign dimension",
  },
];

export function ChatRefinementInput({
  onSend,
  isRefining,
  refineResult,
  onReloadFromConflict,
  className,
}: ChatRefinementInputProps) {
  const [draft, setDraft] = useState("");
  const [boundsBanner, setBoundsBanner] = useState<string | null>(null);

  // G6 — surface bounds_violation banner for 8s then auto-dismiss
  useEffect(() => {
    if (refineResult?.kind === "bounds_violation") {
      setBoundsBanner(refineResult.message);
      const t = setTimeout(() => setBoundsBanner(null), 8000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [refineResult]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || isRefining) return;
    onSend(trimmed);
    setDraft("");
  };

  return (
    <div className={`flex flex-col gap-2 ${className ?? ""}`}>
      {/* G3 — 4-family chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Refine:</span>
        {AXIS_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => setDraft(chip.starter)}
            title={chip.description}
            className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-medium hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {chip.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Refine the Action Plan…"
          aria-label="Refine the Action Plan"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={isRefining}
        />
        <Button
          type="submit"
          disabled={isRefining || draft.trim().length === 0}
          aria-label="Send refinement"
          className="gap-2"
        >
          <Send className="h-4 w-4" />
          {isRefining ? "Refining…" : "Refine"}
        </Button>
      </form>

      {isRefining && (
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <LoadingState />
        </div>
      )}

      {/* G6 — bounds_violation banner */}
      {boundsBanner && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{boundsBanner}</span>
          {refineResult?.kind === "bounds_violation" && (
            <Badge variant="amber" className="ml-auto text-xs">
              {refineResult.strategy}
            </Badge>
          )}
        </div>
      )}

      {/* G4 — concurrent_edit_conflict banner */}
      {refineResult?.kind === "concurrent_edit_conflict" && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{refineResult.message}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onReloadFromConflict}
          >
            Reload to current
          </Button>
        </div>
      )}

      {/* G5 — no_plan_to_refine */}
      {refineResult?.kind === "no_plan_to_refine" && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {refineResult.message}
        </div>
      )}

      {/* analyzer_unavailable */}
      {refineResult?.kind === "analyzer_unavailable" && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {refineResult.message}
        </div>
      )}
    </div>
  );
}
