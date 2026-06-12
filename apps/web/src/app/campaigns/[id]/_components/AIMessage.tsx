/**
 * KAN-1166 PR 3-core-shell — AI message bubble.
 *
 * Left-aligned with Sparkles violet letter-circle avatar. Renders structured
 * children (e.g. counsel cards, paths grid) above an optional free-text
 * footer. PR 3-core-shell renders a single honestAssessment paragraph;
 * PR 3-variants renders cold-start substrate cards + achievable paths grid.
 */
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AIMessageProps {
  children: React.ReactNode;
  timestamp?: string;
  className?: string;
}

export function AIMessage({ children, timestamp, className }: AIMessageProps) {
  return (
    <div className={cn("flex gap-3", className)}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="max-w-[640px] rounded-2xl rounded-bl-sm bg-muted px-4 py-3">
        <div className="text-body">{children}</div>
        {timestamp ? (
          <p className="mt-1 text-xs text-muted-foreground">{timestamp}</p>
        ) : null}
      </div>
    </div>
  );
}
