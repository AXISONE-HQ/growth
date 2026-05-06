// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge Sources admin page (KAN-829), reused by Sprint 12+ destructive flows

/**
 * DeleteSourceConfirm — destructive-action confirmation dialog for soft-deleting
 * a knowledge source.
 *
 * Two-step UX (row button → confirm dialog):
 *   Step 1 (in SourceList) — operator clicks "Delete source" on a table row
 *   Step 2 (this dialog)   — operator confirms via the prominent danger button
 *
 * Wire: row button opens this dialog with the target sourceId. Confirm fires a
 * `DELETE /api/knowledge/sources/:id` mutation. On success the sources +
 * tier-limits queries are invalidated, the dialog closes, and a sonner
 * toast.success surfaces a soft confirmation. On error an inline panel
 * renders inside the dialog (NOT a toast — server-side error context belongs
 * next to the action that triggered it) and the dialog stays open.
 *
 * **DS v1 compliance:**
 *  - All colors via `--ds-*` tokens — danger panel uses ds-danger-soft +
 *    ds-danger-text + ds-danger border
 *  - Sentence case + verb+object button labels
 *  - Forbidden-words audit (combined-microcopy test) — none of:
 *    permanent / forever / cannot be undone / unfortunately / please / sorry,
 *    nor the global list (magic / simply / just / easily / seamlessly / etc.)
 *  - Color paired with text label on every state
 *
 * **Soft-delete behavior** (KAN-827 server contract):
 *  - status='deleted' + deletedAt=NOW() — row hidden from list/retrieval
 *  - 30-day grace window before hard removal (server cron, not surfaced here)
 *  - AuditLog row written (best-effort) for compliance trail
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { API_BASE, buildHeaders } from "@/lib/api";

interface DeleteSourceConfirmProps {
  sourceId: string | null;
  sourceTitle: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteSourceConfirm({
  sourceId,
  sourceTitle,
  open,
  onOpenChange,
}: DeleteSourceConfirmProps): React.ReactElement {
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const queryClient = useQueryClient();

  // Reset inline error whenever the dialog reopens for a new target.
  React.useEffect(() => {
    if (open) setErrorMessage(null);
  }, [open, sourceId]);

  const mutation = useMutation({
    mutationFn: async (id: string): Promise<{ id: string; status: "deleted" }> => {
      const res = await fetch(`${API_BASE}/api/knowledge/sources/${id}`, {
        method: "DELETE",
        headers: await buildHeaders(),
      });
      if (!res.ok) {
        const fallback = (await res.text()) || `HTTP ${res.status}`;
        let userMessage: string;
        switch (res.status) {
          case 404:
            userMessage = "This source no longer exists. Refresh the list.";
            break;
          case 401:
          case 403:
            userMessage = "Sign in expired. Refresh and try again.";
            break;
          default:
            userMessage = `Could not delete this source. ${fallback}`;
        }
        throw new Error(userMessage);
      }
      return (await res.json()) as { id: string; status: "deleted" };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "sources"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "tier-limits"] });
      toast.success("Source deleted.");
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const handleConfirm = () => {
    if (!sourceId) return;
    setErrorMessage(null);
    mutation.mutate(sourceId);
  };

  const displayName = sourceTitle?.trim() || "this source";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete source?</DialogTitle>
          <DialogDescription>
            Confirm removal of {displayName} from this workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <p className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
            The AI stops retrieving from this source right away. A 30-day grace
            window keeps audit history before hard removal.
          </p>

          {errorMessage ? (
            <div
              role="alert"
              aria-label="Delete error"
              className="rounded-md border p-3"
              style={{
                backgroundColor: "var(--ds-danger-soft)",
                color: "var(--ds-danger-text)",
                borderColor: "var(--ds-danger)",
              }}
            >
              <p className="text-sm">{errorMessage}</p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
            aria-label="Cancel delete"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={mutation.isPending || !sourceId}
            aria-label="Confirm delete source"
            style={{
              backgroundColor: "var(--ds-danger)",
              color: "var(--ds-on-danger, #fff)",
              borderColor: "var(--ds-danger)",
            }}
          >
            {mutation.isPending ? "Deleting…" : "Delete source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
