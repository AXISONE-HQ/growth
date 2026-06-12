/**
 * KAN-1166 PR 3-core-shell — Loading state inside an AI message bubble.
 *
 * Renders the analyzer-is-thinking placeholder while
 * campaigns.analyzeFeasibility is in flight. Reused for both initial-load
 * spinner and operator-initiated re-run spinner.
 */
import { Loader2 } from "lucide-react";

export function LoadingState() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-body">Reading your historical signal…</span>
    </div>
  );
}
