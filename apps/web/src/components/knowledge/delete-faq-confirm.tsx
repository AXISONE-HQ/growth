// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge admin page (KAN-XXX)

/**
 * DeleteFaqConfirm — destructive-action confirmation for soft-deleting a
 * FAQ entry. Mirrors DeleteSourceConfirm structure (KAN-829), narrowed for
 * FAQ entries (no chunk count, no fileSize columns).
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

interface DeleteFaqConfirmProps {
  faqId: string | null;
  question: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PREVIEW_MAX = 80;

export function DeleteFaqConfirm({
  faqId,
  question,
  open,
  onOpenChange,
}: DeleteFaqConfirmProps): React.ReactElement {
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (open) setErrorMessage(null);
  }, [open, faqId]);

  const mutation = useMutation({
    mutationFn: async (id: string): Promise<{ id: string; status: "deleted" }> => {
      const res = await fetch(`${API_BASE}/api/knowledge/faqs/${id}`, {
        method: "DELETE",
        headers: await buildHeaders(),
      });
      if (!res.ok) {
        const fallback = (await res.text()) || `HTTP ${res.status}`;
        let userMessage: string;
        switch (res.status) {
          case 404:
            userMessage = "This FAQ entry no longer exists. Refresh the list.";
            break;
          case 401:
          case 403:
            userMessage = "Sign in expired. Refresh and try again.";
            break;
          default:
            userMessage = `Could not delete this FAQ entry. ${fallback}`;
        }
        throw new Error(userMessage);
      }
      return (await res.json()) as { id: string; status: "deleted" };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "faqs"] });
      toast.success("FAQ entry deleted.");
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const handleConfirm = () => {
    if (!faqId) return;
    setErrorMessage(null);
    mutation.mutate(faqId);
  };

  const preview =
    question && question.length > PREVIEW_MAX ? `${question.slice(0, PREVIEW_MAX)}…` : question?.trim() || "this FAQ entry";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete FAQ entry?</DialogTitle>
          <DialogDescription>
            Confirm removal of {preview} from this workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <p className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
            The AI stops citing this entry right away. A 30-day grace window keeps audit history before hard removal.
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
            disabled={mutation.isPending || !faqId}
            aria-label="Confirm delete FAQ entry"
            style={{
              backgroundColor: "var(--ds-danger)",
              color: "var(--ds-on-danger, #fff)",
              borderColor: "var(--ds-danger)",
            }}
          >
            {mutation.isPending ? "Deleting…" : "Delete FAQ entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
