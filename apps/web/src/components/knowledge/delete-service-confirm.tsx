// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge admin page (KAN-XXX)

/**
 * DeleteServiceConfirm — destructive-action confirmation for soft-deleting
 * a Service. Mirrors DeleteFaqConfirm structure (KAN-849).
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

interface DeleteServiceConfirmProps {
  serviceId: string | null;
  title: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PREVIEW_MAX = 80;

export function DeleteServiceConfirm({
  serviceId,
  title,
  open,
  onOpenChange,
}: DeleteServiceConfirmProps): React.ReactElement {
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (open) setErrorMessage(null);
  }, [open, serviceId]);

  const mutation = useMutation({
    mutationFn: async (id: string): Promise<{ id: string; status: "deleted" }> => {
      const res = await fetch(`${API_BASE}/api/knowledge/services/${id}`, {
        method: "DELETE",
        headers: await buildHeaders(),
      });
      if (!res.ok) {
        const fallback = (await res.text()) || `HTTP ${res.status}`;
        let userMessage: string;
        switch (res.status) {
          case 404:
            userMessage = "This service no longer exists. Refresh the list.";
            break;
          case 401:
          case 403:
            userMessage = "Sign in expired. Refresh and try again.";
            break;
          default:
            userMessage = `Could not delete this service. ${fallback}`;
        }
        throw new Error(userMessage);
      }
      return (await res.json()) as { id: string; status: "deleted" };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "services"] });
      toast.success("Service deleted.");
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const handleConfirm = () => {
    if (!serviceId) return;
    setErrorMessage(null);
    mutation.mutate(serviceId);
  };

  const preview =
    title && title.length > PREVIEW_MAX
      ? `${title.slice(0, PREVIEW_MAX)}…`
      : title?.trim() || "this service";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete service?</DialogTitle>
          <DialogDescription>
            Confirm removal of {preview} from this workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <p className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
            The AI stops citing this service right away. A 30-day grace window keeps audit history before hard removal.
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
            disabled={mutation.isPending || !serviceId}
            aria-label="Confirm delete service"
            style={{
              backgroundColor: "var(--ds-danger)",
              color: "var(--ds-on-danger, #fff)",
              borderColor: "var(--ds-danger)",
            }}
          >
            {mutation.isPending ? "Deleting…" : "Delete service"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
