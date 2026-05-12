/**
 * KAN-884 — shared EmptyState primitive.
 *
 * Lifted from the inline pattern at apps/web/src/app/settings/pipelines/
 * page.tsx:85 and apps/web/src/components/knowledge/faq-list.tsx:130. Both
 * pre-existing instances stay as-is for now (touching them widens this PR's
 * blast radius); future per-page refactors can swap to this primitive.
 *
 * Used by /companies and /orders list pages; PR 3 reuses for /customers
 * redesign.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

interface EmptyStateProps {
  icon: LucideIcon;
  heading: string;
  body: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, heading, body, action }: EmptyStateProps) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="rounded-full bg-muted p-3">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="max-w-md space-y-1">
          <h3 className="text-lg font-semibold">{heading}</h3>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
        {action ? <div className="mt-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}
