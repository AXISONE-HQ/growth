// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge admin page (KAN-XXX)

/**
 * EditServiceDialog — pre-filled form for editing an existing Service.
 * Mirror of AddServiceDialog but PUTs to /api/knowledge/services/:id and
 * seeds the fields from the row passed in. Re-embeds server-side on save.
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { API_BASE, buildHeaders } from "@/lib/api";
import {
  PRICE_UNIT_VALUES,
  priceUnitLabel,
  type ServicePriceUnit,
} from "@/lib/service-pricing";
import { ItemListEditor, validateClient } from "./add-service-dialog";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2_000;
const PRICE_LABEL_MAX = 200;

interface ServiceShape {
  id: string;
  title: string;
  description: string;
  price: number | null;
  priceUnit: ServicePriceUnit;
  priceCustomLabel: string | null;
  startDate: string | null;
  endDate: string | null;
  includedItems: string[];
  excludedItems: string[];
}

interface EditServiceDialogProps {
  service: ServiceShape | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditServiceDialog({
  service,
  open,
  onOpenChange,
}: EditServiceDialogProps): React.ReactElement {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [priceText, setPriceText] = React.useState("");
  const [priceUnit, setPriceUnit] = React.useState<ServicePriceUnit>("PER_HOUR");
  const [priceCustomLabel, setPriceCustomLabel] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [includedItems, setIncludedItems] = React.useState<string[]>([""]);
  const [excludedItems, setExcludedItems] = React.useState<string[]>([""]);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const queryClient = useQueryClient();

  // Seed fields when the dialog opens for a new target.
  React.useEffect(() => {
    if (open && service) {
      setTitle(service.title);
      setDescription(service.description);
      setPriceText(service.price !== null ? String(service.price) : "");
      setPriceUnit(service.priceUnit);
      setPriceCustomLabel(service.priceCustomLabel ?? "");
      setStartDate(service.startDate ? service.startDate.slice(0, 10) : "");
      setEndDate(service.endDate ? service.endDate.slice(0, 10) : "");
      setIncludedItems(service.includedItems.length > 0 ? service.includedItems : [""]);
      setExcludedItems(service.excludedItems.length > 0 ? service.excludedItems : [""]);
      setErrorMessage(null);
    }
  }, [open, service]);

  const handleClose = React.useCallback(
    (next: boolean) => {
      if (!next) setErrorMessage(null);
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const mutation = useMutation({
    mutationFn: async (input: { id: string; body: Record<string, unknown> }): Promise<{
      service: { id: string; status: string; errorDetail: string | null };
    }> => {
      const res = await fetch(`${API_BASE}/api/knowledge/services/${input.id}`, {
        method: "PUT",
        headers: await buildHeaders(),
        body: JSON.stringify(input.body),
      });
      if (!res.ok) {
        const fallback = (await res.text()) || `HTTP ${res.status}`;
        let userMessage: string;
        switch (res.status) {
          case 400:
            userMessage = `Invalid input. ${fallback}`;
            break;
          case 404:
            userMessage = "This service no longer exists. Refresh the list.";
            break;
          case 401:
          case 403:
            userMessage = "Sign in expired. Refresh and try again.";
            break;
          default:
            userMessage = "Something went wrong. Try again later.";
        }
        throw new Error(userMessage);
      }
      return (await res.json()) as {
        service: { id: string; status: string; errorDetail: string | null };
      };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "services"] });
      if (result.service.status === "error") {
        setErrorMessage(result.service.errorDetail ?? "Embedding failed. Try again.");
        return;
      }
      toast.success("Service saved.");
      handleClose(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const handleSubmit = () => {
    if (!service) return;
    setErrorMessage(null);
    const validated = validateClient({
      title: title.trim(),
      description: description.trim(),
      priceText: priceText.trim(),
      priceUnit,
      priceCustomLabel: priceCustomLabel.trim(),
      startDate,
      endDate,
      includedItems,
      excludedItems,
    });
    if ("error" in validated) {
      setErrorMessage(validated.error);
      return;
    }
    // PUT body — send the full validated shape; the server's no-op
    // short-circuit handles "nothing changed" on its end. Spread to widen
    // the strict `ServicePostBody` shape into the mutation's
    // `Record<string, unknown>` contract.
    mutation.mutate({ id: service.id, body: { ...validated.body } });
  };

  const isCustom = priceUnit === "CUSTOM";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit service</DialogTitle>
          <DialogDescription>
            Save changes to update what the AI cites for this service.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2 max-h-[70vh] overflow-y-auto">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-service-title">Title</Label>
            <Input
              id="edit-service-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-service-description">Description</Label>
            <Textarea
              id="edit-service-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={DESCRIPTION_MAX}
              rows={4}
            />
            <span className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
              {description.length} / {DESCRIPTION_MAX.toLocaleString()}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-service-price-unit">Price unit</Label>
              <select
                id="edit-service-price-unit"
                value={priceUnit}
                onChange={(e) => setPriceUnit(e.target.value as ServicePriceUnit)}
                className="flex h-10 w-full items-center rounded-md border px-3 py-2 text-sm motion-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
                style={{
                  backgroundColor: "var(--ds-surface-base)",
                  borderColor: "var(--ds-border-default)",
                  color: "var(--ds-ink-primary)",
                }}
              >
                {PRICE_UNIT_VALUES.map((u) => (
                  <option key={u} value={u}>
                    {priceUnitLabel(u)}
                  </option>
                ))}
              </select>
            </div>
            {!isCustom ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-service-price">Price</Label>
                <Input
                  id="edit-service-price"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={priceText}
                  onChange={(e) => setPriceText(e.target.value)}
                />
              </div>
            ) : null}
          </div>

          {isCustom ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-service-custom-label">Custom price label</Label>
              <Input
                id="edit-service-custom-label"
                value={priceCustomLabel}
                onChange={(e) => setPriceCustomLabel(e.target.value)}
                maxLength={PRICE_LABEL_MAX}
              />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-service-start-date">Start date (optional)</Label>
              <Input
                id="edit-service-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-service-end-date">End date (optional)</Label>
              <Input
                id="edit-service-end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <ItemListEditor
            label="What's included"
            addLabel="Add included item"
            removeLabel="Remove included item"
            items={includedItems}
            onChange={setIncludedItems}
            inputIdPrefix="edit-service-included"
          />
          <ItemListEditor
            label="What's excluded"
            addLabel="Add excluded item"
            removeLabel="Remove excluded item"
            items={excludedItems}
            onChange={setExcludedItems}
            inputIdPrefix="edit-service-excluded"
          />

          {errorMessage ? (
            <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
              {errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={mutation.isPending}
            aria-label="Cancel editing service"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!title.trim() || !description.trim() || mutation.isPending || !service}
            aria-label="Save service"
          >
            {mutation.isPending ? "Saving…" : "Save service"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
