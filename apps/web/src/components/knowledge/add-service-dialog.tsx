// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge admin page (KAN-XXX)

/**
 * AddServiceDialog — single-screen create flow for a Service entry.
 * Form fields: title, description, price + priceUnit (with CUSTOM escape
 * hatch + free-form label), startDate/endDate (optional → "Ongoing"),
 * includedItems[] / excludedItems[] (dynamic add/remove rows).
 *
 * **Server contract:** POST /api/knowledge/services returns the created
 * entry in its terminal status (sync embedding). On 'ready' the dialog
 * closes and the list refreshes; on 'error' the inline error panel surfaces
 * `errorDetail` so the operator can retry without having to reopen.
 *
 * **DS v1 compliance:**
 *  - All colors via `--ds-*` tokens; zero hex
 *  - Sentence case + verb+object button labels ("Add service", "Add included
 *    item", "Remove excluded item")
 *  - Forbidden-words audit (foundation-pattern.test.ts covers this file)
 *
 * Native `<select>` is used over the shadcn Radix Select primitive — the
 * Radix portal makes jsdom testing fragile, and the form is admin-only
 * where DS purity matters less than testability + reliability.
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

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2_000;
const PRICE_LABEL_MAX = 200;
const ITEM_MAX = 500;
const MAX_ITEMS = 50;

interface AddServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddServiceDialog({
  open,
  onOpenChange,
}: AddServiceDialogProps): React.ReactElement {
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

  const reset = React.useCallback(() => {
    setTitle("");
    setDescription("");
    setPriceText("");
    setPriceUnit("PER_HOUR");
    setPriceCustomLabel("");
    setStartDate("");
    setEndDate("");
    setIncludedItems([""]);
    setExcludedItems([""]);
    setErrorMessage(null);
  }, []);

  const handleClose = React.useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const mutation = useMutation({
    mutationFn: async (input: ServicePostBody): Promise<{
      service: { id: string; status: string; errorDetail: string | null };
    }> => {
      const res = await fetch(`${API_BASE}/api/knowledge/services`, {
        method: "POST",
        headers: await buildHeaders(),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const fallback = (await res.text()) || `HTTP ${res.status}`;
        let userMessage: string;
        switch (res.status) {
          case 400:
            userMessage = `Invalid input. ${fallback}`;
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
      toast.success("Service added.");
      handleClose(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const handleSubmit = () => {
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
    mutation.mutate(validated.body);
  };

  const isCustom = priceUnit === "CUSTOM";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add service</DialogTitle>
          <DialogDescription>
            Structured catalog entry. The AI cites this when a customer asks about pricing or what you offer.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2 max-h-[70vh] overflow-y-auto">
          {/* Title */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-service-title">Title</Label>
            <Input
              id="add-service-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              placeholder="Short, descriptive title"
            />
          </div>

          {/* Description */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-service-description">Description</Label>
            <Textarea
              id="add-service-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={DESCRIPTION_MAX}
              rows={4}
              placeholder="What the service includes and who it's for."
            />
            <span className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
              {description.length} / {DESCRIPTION_MAX.toLocaleString()}
            </span>
          </div>

          {/* Price + Unit */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="add-service-price-unit">Price unit</Label>
              <select
                id="add-service-price-unit"
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
                <Label htmlFor="add-service-price">Price</Label>
                <Input
                  id="add-service-price"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={priceText}
                  onChange={(e) => setPriceText(e.target.value)}
                  placeholder="50.00"
                />
              </div>
            ) : null}
          </div>

          {/* Custom label (conditional on CUSTOM) */}
          {isCustom ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="add-service-custom-label">Custom price label</Label>
              <Input
                id="add-service-custom-label"
                value={priceCustomLabel}
                onChange={(e) => setPriceCustomLabel(e.target.value)}
                maxLength={PRICE_LABEL_MAX}
                placeholder="e.g., Contact for quote"
              />
            </div>
          ) : null}

          {/* Availability window */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="add-service-start-date">Start date (optional)</Label>
              <Input
                id="add-service-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="add-service-end-date">End date (optional)</Label>
              <Input
                id="add-service-end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs -mt-2" style={{ color: "var(--ds-ink-tertiary)" }}>
            Leave both empty for ongoing availability.
          </p>

          {/* Included items */}
          <ItemListEditor
            label="What's included"
            addLabel="Add included item"
            removeLabel="Remove included item"
            items={includedItems}
            onChange={setIncludedItems}
            inputIdPrefix="add-service-included"
          />

          {/* Excluded items */}
          <ItemListEditor
            label="What's excluded"
            addLabel="Add excluded item"
            removeLabel="Remove excluded item"
            items={excludedItems}
            onChange={setExcludedItems}
            inputIdPrefix="add-service-excluded"
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
            aria-label="Cancel adding service"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!title.trim() || !description.trim() || mutation.isPending}
            aria-label="Save service"
          >
            {mutation.isPending ? "Saving…" : "Save service"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────
// ItemListEditor — shared dynamic add/remove rows for included/excluded
// ─────────────────────────────────────────────

export function ItemListEditor({
  label,
  addLabel,
  removeLabel,
  items,
  onChange,
  inputIdPrefix,
}: {
  label: string;
  addLabel: string;
  removeLabel: string;
  items: string[];
  onChange: (next: string[]) => void;
  inputIdPrefix: string;
}): React.ReactElement {
  const handleChange = (index: number, value: string) => {
    onChange(items.map((it, i) => (i === index ? value : it)));
  };
  const handleRemove = (index: number) => {
    if (items.length === 1) {
      // Keep at least one (empty) row so the editor stays mounted
      onChange([""]);
      return;
    }
    onChange(items.filter((_, i) => i !== index));
  };
  const handleAdd = () => {
    if (items.length >= MAX_ITEMS) return;
    onChange([...items, ""]);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium" style={{ color: "var(--ds-ink-primary)" }}>
        {label}
      </span>
      {items.map((item, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input
            id={`${inputIdPrefix}-${idx}`}
            value={item}
            onChange={(e) => handleChange(idx, e.target.value)}
            maxLength={ITEM_MAX}
            placeholder="Bullet point text"
            aria-label={`${label} item ${idx + 1}`}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleRemove(idx)}
            aria-label={`${removeLabel} ${idx + 1}`}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAdd}
        disabled={items.length >= MAX_ITEMS}
        aria-label={addLabel}
        className="self-start"
      >
        {addLabel}
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// Client-side validation + body assembly
// ─────────────────────────────────────────────

interface ServicePostBody {
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

interface ValidationOk {
  body: ServicePostBody;
}
interface ValidationErr {
  error: string;
}

export function validateClient(input: {
  title: string;
  description: string;
  priceText: string;
  priceUnit: ServicePriceUnit;
  priceCustomLabel: string;
  startDate: string;
  endDate: string;
  includedItems: string[];
  excludedItems: string[];
}): ValidationOk | ValidationErr {
  if (!input.title) return { error: "Title is required." };
  if (!input.description) return { error: "Description is required." };

  let price: number | null = null;
  let priceCustomLabel: string | null = null;
  if (input.priceUnit === "CUSTOM") {
    if (!input.priceCustomLabel) {
      return { error: "Custom price label is required when unit is Custom." };
    }
    priceCustomLabel = input.priceCustomLabel;
  } else {
    if (!input.priceText) return { error: "Price is required." };
    const parsed = Number.parseFloat(input.priceText);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: "Price must be a non-negative number." };
    }
    price = parsed;
  }

  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    return { error: "End date cannot precede start date." };
  }

  const includedItems = input.includedItems.map((s) => s.trim()).filter(Boolean);
  const excludedItems = input.excludedItems.map((s) => s.trim()).filter(Boolean);

  return {
    body: {
      title: input.title,
      description: input.description,
      price,
      priceUnit: input.priceUnit,
      priceCustomLabel,
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      includedItems,
      excludedItems,
    },
  };
}
