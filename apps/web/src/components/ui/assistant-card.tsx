/**
 * KAN-983 Phase B.6 — AssistantCard.
 *
 * "How can I help you?" surface per prototype `.assist`. Presentational
 * primitive — no backend wiring. Future Phase C / later phase will wire
 * onSubmit to an actual assistant API.
 *
 * Anatomy (per prototype):
 *   - Soft gradient bg (160deg, #F3F1FE 0%, #FFF 65%) + hairline border +
 *     --ds-shadow-card + --ds-radius-card
 *   - Header: 26×26 gradient "spark" mark (rounded square 8px) + title in
 *     .text-h3 (DS v1 type-scale conformance)
 *   - Suggestion chips: violet text, white bg, hairline border, pill
 *     shape. Click → onSuggestionClick(suggestion).
 *   - Ask pill: rounded-full input row + right-edge gradient circle "Go"
 *     button (ArrowUp icon). Submit on Enter or Go click → onSubmit(value).
 *
 * Use anywhere a user needs the AI prompt-launchpad. Dashboard is the
 * primary target (Phase C); detail pages may also surface it scoped to
 * the current entity.
 */
"use client";

import * as React from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AssistantCardProps {
  /** Title text. Defaults to "How can I help you?". */
  title?: string;
  /** Suggested-action chips. Click fires onSuggestionClick. */
  suggestions?: string[];
  onSuggestionClick?: (suggestion: string) => void;
  /** Input placeholder. */
  placeholder?: string;
  /** Submit handler — fires on Enter key or Go button click. */
  onSubmit?: (value: string) => void;
  className?: string;
}

export function AssistantCard({
  title = "How can I help you?",
  suggestions = [],
  onSuggestionClick,
  placeholder = "Ask growth anything…",
  onSubmit,
  className,
}: AssistantCardProps) {
  const [value, setValue] = React.useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || !onSubmit) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <section
      aria-label={title}
      className={cn(
        "rounded-[var(--ds-radius-card)] border border-border p-5 shadow-[var(--ds-shadow-card)]",
        "[background-image:linear-gradient(160deg,#F3F1FE_0%,#FFFFFF_65%)]",
        className,
      )}
    >
      {/* Header: gradient spark mark + title */}
      <div className="flex items-center gap-[9px]">
        <div
          aria-hidden="true"
          className="flex h-[26px] w-[26px] items-center justify-center rounded-lg [background-image:var(--ds-accent-gradient)]"
        >
          <Sparkles className="h-[15px] w-[15px] text-white" />
        </div>
        <h3 className="text-h3 text-foreground">{title}</h3>
      </div>

      {/* Suggestion chips */}
      {suggestions.length > 0 ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {suggestions.map((s, i) => (
            <button
              key={`${i}-${s}`}
              type="button"
              onClick={() => onSuggestionClick?.(s)}
              className="text-label rounded-[var(--ds-radius-pill)] border border-border bg-card px-[13px] py-[7px] text-[var(--ds-violet-500)] transition-colors hover:bg-accent"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {/* Ask input */}
      <div className="mt-2 flex items-center justify-between gap-2 rounded-[var(--ds-radius-pill)] border border-border bg-card py-[9px] pl-4 pr-[9px] transition-all focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/10">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          className="w-full border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          aria-label={`${title} — input`}
        />
        <button
          type="button"
          onClick={submit}
          aria-label="Send"
          disabled={!value.trim()}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-white transition-opacity [background-image:var(--ds-accent-gradient)] hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}
