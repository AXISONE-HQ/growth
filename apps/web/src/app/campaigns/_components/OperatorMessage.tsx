/**
 * KAN-1166 PR 3-core-shell — Operator message bubble.
 *
 * Right-aligned with "OP" letter-circle avatar. The MVP only renders the
 * operator's goal-setting statement (read from Campaign.goalDescription);
 * PR 3-variants adds free-text turns from CampaignConversationTurn.
 */
import { cn } from "@/lib/utils";

export interface OperatorMessageProps {
  content: string;
  timestamp?: string;
  className?: string;
}

export function OperatorMessage({ content, timestamp, className }: OperatorMessageProps) {
  return (
    <div className={cn("flex justify-end gap-3", className)}>
      <div className="max-w-[640px] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-primary-foreground">
        <p className="whitespace-pre-wrap text-body">{content}</p>
        {timestamp ? (
          <p className="mt-1 text-xs opacity-70">{timestamp}</p>
        ) : null}
      </div>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        OP
      </div>
    </div>
  );
}
