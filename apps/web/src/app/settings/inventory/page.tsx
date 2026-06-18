"use client";

/**
 * KAN-1217 (Slice 3 of KAN-1211 epic) — Vehicle Inventory UI.
 *
 * Mirrors KAN-1218 /settings/products page shape (1426 LoC precedent at
 * apps/web/src/app/settings/products/page.tsx). Consumes vehiclesRouter
 * tRPC procedures (KAN-1214 Slice 2 shipped: list/get/create/update/archive).
 *
 * # SPO verdict locks (Phase 1 trace)
 *
 * - Q3: Status filter default = active+draft visible. DIVERGES from
 *   products precedent (all statuses) per Vehicle-specific operator UX
 *   doctrine — "current inventory" mental model excludes archived
 *   (sold/removed). Memo 39 UX-justified divergence refinement.
 * - Q4: 5 inline native <select> for enums (REFUTE shared <EnumSelect>).
 *   Codebase precedent (8+ raw <select> sites). Memo 39 anchor #10.
 * - Q5: Inline <Card border-dashed> empty state. REFUTE shared <EmptyState>.
 * - Q6: Scraper-trigger placeholder = disabled Button + "Available after
 *   KAN-1216 Slice 4 merge" tooltip (Memo 19 feature-affordance-honesty).
 *
 * # VIN validation
 *
 * Client-side blur preview against VIN_REGEX (mirrors
 * packages/shared/src/vehicles.ts:86 ISO 3779). Server-side authoritative
 * via VehicleCreateInputSchema (defense-in-depth per J3 verdict).
 */

import { useEffect, useState, type FocusEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Car, Trash2, Pencil, Globe } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  vehiclesApi,
  type VehicleListItem,
  type VehicleStatus,
  type CursorPage,
} from "@/lib/api";
import {
  BODY_STYLES,
  TRANSMISSIONS,
  FUEL_TYPES,
  DRIVETRAINS,
  VEHICLE_CONDITIONS,
} from "@growth/shared";

/* ── Constants — VIN regex + year/mileage bounds ─────────────────────── */

// ISO 3779: 17 alphanumeric chars excluding I, O, Q (digit ambiguity).
// Mirrors packages/shared/src/vehicles.ts:86 — UI-side preview only;
// server-side VehicleCreateInputSchema is authoritative (J3 verdict).
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;

const YEAR_MIN = 1900;
const YEAR_MAX = 2028;
const MILEAGE_MIN = 0;
const MILEAGE_MAX = 999_999;

/* ── Status filter — Q3 verdict lock ─────────────────────────────────── */

const STATUS_FILTER_OPTIONS: Array<{ value: VehicleStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "archived", label: "Archived" },
];

// Q3 — Vehicle-specific operator UX doctrine: "current inventory" excludes
// archived. DIVERGES from /settings/products (all-statuses default). Memo
// 39 UX-justified divergence refinement.
const DEFAULT_STATUS_FILTER: VehicleStatus[] = ["active", "draft"];

const STATUS_LABEL: Record<VehicleStatus, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

function statusBadgeVariant(s: VehicleStatus): "muted" | "green" | "rose" {
  if (s === "active") return "green";
  if (s === "archived") return "rose";
  return "muted";
}

/* ── Enum label helpers — render slugged enum values as Title Case ────── */

function humanize(s: string): string {
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ── Top-level Page ──────────────────────────────────────────────────── */

export default function InventorySettingsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        <p className="text-sm text-muted-foreground">
          Manage your vehicle inventory. The AI references VIN, year/make/model,
          mileage, and condition for pricing and recommendations.
        </p>
      </header>

      <VehiclesTab />
    </div>
  );
}

/* ── Vehicles Tab — list + filters + CTA + modals ────────────────────── */

function VehiclesTab() {
  // Multi-chip status filter. Default active+draft visible (Q3 verdict).
  const [statusFilter, setStatusFilter] = useState<VehicleStatus[]>(
    DEFAULT_STATUS_FILTER,
  );
  const [pages, setPages] = useState<CursorPage<VehicleListItem>[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<VehicleListItem | null>(null);

  // Reset paged accumulator when filter changes.
  useEffect(() => {
    setPages([]);
  }, [statusFilter]);

  const currentCursor =
    pages.length > 0 ? pages[pages.length - 1]?.nextCursor : null;

  // Translate chip selection to vehiclesApi.list input:
  //   - includeArchived: true iff 'archived' chip is selected
  //   - status: single-value when exactly ONE non-archived chip selected
  //   - else omitted; client-side filter handles multi-non-archived shapes
  const includeArchived = statusFilter.includes("archived");
  const onlyOneStatusSelected =
    statusFilter.length === 1 ? statusFilter[0] : undefined;

  const queryInput = {
    limit: 50,
    includeArchived,
    ...(onlyOneStatusSelected ? { status: onlyOneStatusSelected } : {}),
    ...(currentCursor ? { cursor: currentCursor } : {}),
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<VehicleListItem>
  >({
    queryKey: ["vehicles", "list", queryInput, statusFilter],
    queryFn: () => vehiclesApi.list(queryInput),
  });

  useEffect(() => {
    if (!data) return;
    setPages((prev) => {
      if (prev.length === 0) return [data];
      const last = prev[prev.length - 1];
      if (last && last.nextCursor === data.nextCursor) return prev;
      return [...prev, data];
    });
  }, [data]);

  // Client-side filter for multi-chip combinations the server can't express
  // with a single-status filter. Server still applies includeArchived gate.
  const allItems = pages.flatMap((p) => p.items);
  const items = allItems.filter((v) => statusFilter.includes(v.status));
  const hasMore =
    (pages[pages.length - 1]?.nextCursor ?? data?.nextCursor) != null;

  function toggleStatusChip(s: VehicleStatus): void {
    setStatusFilter((prev) => {
      if (prev.includes(s)) {
        // Don't allow empty selection — leave at least one chip on.
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== s);
      }
      return [...prev, s];
    });
  }

  async function handleArchive(v: VehicleListItem): Promise<void> {
    const label = `${v.year} ${v.make} ${v.model}`;
    if (
      !confirm(`Archive "${label}"? This cannot be undone.`)
    ) {
      return;
    }
    try {
      await vehiclesApi.archive(v.id);
      toast.success("Vehicle archived");
      setPages([]);
      void refetch();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to archive vehicle");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1">
          <div className="flex gap-1">
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleStatusChip(opt.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                  statusFilter.includes(opt.value)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:bg-muted"
                }`}
                aria-pressed={statusFilter.includes(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Q6 — Scraper-trigger placeholder. Memo 19 feature-affordance-
              honesty: render disabled with disclosure tooltip. The scrape
              endpoint lands in KAN-1216 Slice 4. */}
          <Button
            variant="outline"
            size="sm"
            disabled
            title="Available after KAN-1216 Slice 4 merge"
            aria-label="Scrape inventory (not yet available)"
          >
            <Globe className="h-4 w-4" />
            Scrape inventory
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Create vehicle
          </Button>
        </div>
      </div>

      {isError && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              Couldn&apos;t load vehicles
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-destructive/80">
              {(error as Error)?.message}
            </p>
          </CardContent>
        </Card>
      )}

      {isLoading && pages.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="h-16" />
            </Card>
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        // Q5 — inline <Card border-dashed> empty state. REFUTE shared
        // <EmptyState> import. Mirrors products precedent at :403-412.
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Car className="h-10 w-10 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium">
                No vehicles in inventory yet
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Click Create vehicle to add your first vehicle
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {items.map((v) => {
          const label = `${v.year} ${v.make} ${v.model}`;
          const trimSuffix = v.trim ? ` ${v.trim}` : "";
          return (
            <div
              key={v.id}
              className="rounded-lg border bg-card"
            >
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3 text-left flex-1">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{label}{trimSuffix}</span>
                      <Badge
                        variant={statusBadgeVariant(v.status)}
                        className="text-xs"
                      >
                        {STATUS_LABEL[v.status]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {humanize(v.condition)} · {humanize(v.bodyStyle)}
                      </span>
                      {v.mileage != null && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {v.mileage.toLocaleString()} mi
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 flex gap-3 flex-wrap">
                      {v.vin && <span>VIN: {v.vin}</span>}
                      {v.stockNumber && <span>Stock #{v.stockNumber}</span>}
                      {v.dealerLot && <span>Lot: {v.dealerLot}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditing(v)}
                    aria-label={`Edit ${label}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {v.status !== "archived" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleArchive(v)}
                      aria-label={`Archive ${label}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}

      <CreateVehicleModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          // Memo 52 operator-visibility — newly-created drafts must
          // surface. active+draft is the default filter; reset to it
          // (not 'all') because Memo 39 vehicle-UX excludes archived.
          setStatusFilter(DEFAULT_STATUS_FILTER);
          setPages([]);
          void refetch();
        }}
      />

      <EditVehicleModal
        vehicle={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={() => {
          setEditing(null);
          setStatusFilter(DEFAULT_STATUS_FILTER);
          setPages([]);
          void refetch();
        }}
      />
    </div>
  );
}

/* ── VehicleForm draft + helpers ─────────────────────────────────────── */

interface VehicleDraft {
  // Identity
  year: string;
  make: string;
  model: string;
  trim: string;
  vin: string;
  // Specs
  mileage: string;
  bodyStyle: string;
  transmission: string;
  fuelType: string;
  drivetrain: string;
  condition: string;
  // Cosmetics
  exteriorColor: string;
  interiorColor: string;
  // Dealer-meta
  stockNumber: string;
  dealerLot: string;
  // Status
  status: VehicleStatus;
}

function emptyDraft(): VehicleDraft {
  return {
    year: "",
    make: "",
    model: "",
    trim: "",
    vin: "",
    mileage: "",
    bodyStyle: "sedan",
    transmission: "automatic",
    fuelType: "gas",
    drivetrain: "fwd",
    condition: "used",
    exteriorColor: "",
    interiorColor: "",
    stockNumber: "",
    dealerLot: "",
    status: "draft",
  };
}

function draftFromVehicle(v: VehicleListItem): VehicleDraft {
  return {
    year: String(v.year),
    make: v.make,
    model: v.model,
    trim: v.trim ?? "",
    vin: v.vin ?? "",
    mileage: v.mileage == null ? "" : String(v.mileage),
    bodyStyle: v.bodyStyle,
    transmission: v.transmission,
    fuelType: v.fuelType,
    drivetrain: v.drivetrain,
    condition: v.condition,
    exteriorColor: v.exteriorColor ?? "",
    interiorColor: v.interiorColor ?? "",
    stockNumber: v.stockNumber ?? "",
    dealerLot: v.dealerLot ?? "",
    status: v.status,
  };
}

interface VehicleFormErrors {
  year: string | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  mileage: string | null;
}

function emptyErrors(): VehicleFormErrors {
  return {
    year: null,
    make: null,
    model: null,
    vin: null,
    mileage: null,
  };
}

/* ── CreateVehicleModal ──────────────────────────────────────────────── */

function CreateVehicleModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState<VehicleDraft>(emptyDraft());
  const [errors, setErrors] = useState<VehicleFormErrors>(emptyErrors());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setDraft(emptyDraft());
      setErrors(emptyErrors());
    }
  }, [open]);

  async function handleSubmit(): Promise<void> {
    const validation = validateDraft(draft);
    if (validation.hasErrors) {
      setErrors(validation.errors);
      return;
    }
    setSaving(true);
    try {
      const payload = buildCreatePayload(draft);
      await vehiclesApi.create(payload);
      toast.success("Vehicle created");
      setSaving(false);
      onCreated();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to create vehicle");
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create vehicle</DialogTitle>
          <DialogDescription>
            Add a vehicle to your inventory. Year, make, and model are required.
            VIN is optional but must be 17 alphanumeric characters (ISO 3779)
            when provided.
          </DialogDescription>
        </DialogHeader>
        <VehicleForm draft={draft} setDraft={setDraft} errors={errors} setErrors={setErrors} />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── EditVehicleModal ────────────────────────────────────────────────── */

function EditVehicleModal({
  vehicle,
  onOpenChange,
  onSaved,
}: {
  vehicle: VehicleListItem | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<VehicleDraft>(emptyDraft());
  const [errors, setErrors] = useState<VehicleFormErrors>(emptyErrors());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (vehicle) {
      setDraft(draftFromVehicle(vehicle));
      setErrors(emptyErrors());
    }
  }, [vehicle]);

  async function handleSubmit(): Promise<void> {
    if (!vehicle) return;
    const validation = validateDraft(draft);
    if (validation.hasErrors) {
      setErrors(validation.errors);
      return;
    }
    setSaving(true);
    try {
      const payload = buildUpdatePayload(vehicle.id, draft);
      await vehiclesApi.update(payload);
      toast.success("Vehicle updated");
      setSaving(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to update vehicle");
      setSaving(false);
    }
  }

  return (
    <Dialog open={vehicle !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit vehicle</DialogTitle>
          <DialogDescription>
            Update the vehicle&apos;s identity, specs, cosmetics, or dealer
            metadata.
          </DialogDescription>
        </DialogHeader>
        <VehicleForm draft={draft} setDraft={setDraft} errors={errors} setErrors={setErrors} />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── VehicleForm — 15 fields across 4 sections ───────────────────────── */

function VehicleForm({
  draft,
  setDraft,
  errors,
  setErrors,
}: {
  draft: VehicleDraft;
  setDraft: (d: VehicleDraft) => void;
  errors: VehicleFormErrors;
  setErrors: (e: VehicleFormErrors) => void;
}) {
  function setField(
    key: keyof VehicleDraft,
    value: VehicleDraft[keyof VehicleDraft],
  ): void {
    setDraft({ ...draft, [key]: value });
  }

  function clearError(k: keyof VehicleFormErrors): void {
    if (errors[k]) setErrors({ ...errors, [k]: null });
  }

  // J3 — client-side VIN blur validation. Server-side authoritative via
  // VehicleCreateInputSchema. Empty VIN is allowed (Memo 45 — nullable
  // with SQL three-valued logic uniqueness).
  function handleVinBlur(e: FocusEvent<HTMLInputElement>): void {
    const v = e.target.value.trim().toUpperCase();
    if (!v) {
      setErrors({ ...errors, vin: null });
      return;
    }
    if (!VIN_REGEX.test(v)) {
      setErrors({
        ...errors,
        vin: "VIN must be 17 alphanumeric chars (excluding I/O/Q per ISO 3779)",
      });
    } else {
      setErrors({ ...errors, vin: null });
    }
  }

  function handleYearBlur(e: FocusEvent<HTMLInputElement>): void {
    const v = e.target.value.trim();
    if (!v) return;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < YEAR_MIN || n > YEAR_MAX) {
      setErrors({
        ...errors,
        year: `Year must be between ${YEAR_MIN} and ${YEAR_MAX}`,
      });
    } else {
      setErrors({ ...errors, year: null });
    }
  }

  function handleMileageBlur(e: FocusEvent<HTMLInputElement>): void {
    const v = e.target.value.trim();
    if (!v) return;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < MILEAGE_MIN || n > MILEAGE_MAX) {
      setErrors({
        ...errors,
        mileage: `Mileage must be between ${MILEAGE_MIN} and ${MILEAGE_MAX.toLocaleString()}`,
      });
    } else {
      setErrors({ ...errors, mileage: null });
    }
  }

  return (
    <div className="space-y-5 py-2 max-h-[60vh] overflow-y-auto pr-1">
      {/* ── Section 1: Identity ─────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Identity
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="vehicle-year">Year</Label>
            <Input
              id="vehicle-year"
              type="number"
              value={draft.year}
              onChange={(e) => {
                setField("year", e.target.value);
                clearError("year");
              }}
              onBlur={handleYearBlur}
              placeholder="2024"
              min={YEAR_MIN}
              max={YEAR_MAX}
            />
            {errors.year && (
              <p className="text-sm text-destructive">{errors.year}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="vehicle-make">Make</Label>
            <Input
              id="vehicle-make"
              value={draft.make}
              onChange={(e) => {
                setField("make", e.target.value);
                clearError("make");
              }}
              placeholder="Toyota"
            />
            {errors.make && (
              <p className="text-sm text-destructive">{errors.make}</p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="vehicle-model">Model</Label>
            <Input
              id="vehicle-model"
              value={draft.model}
              onChange={(e) => {
                setField("model", e.target.value);
                clearError("model");
              }}
              placeholder="Camry"
            />
            {errors.model && (
              <p className="text-sm text-destructive">{errors.model}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="vehicle-trim">Trim (optional)</Label>
            <Input
              id="vehicle-trim"
              value={draft.trim}
              onChange={(e) => setField("trim", e.target.value)}
              placeholder="SE Hybrid"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="vehicle-vin">VIN (optional)</Label>
          <Input
            id="vehicle-vin"
            value={draft.vin}
            onChange={(e) => {
              setField("vin", e.target.value.toUpperCase());
              clearError("vin");
            }}
            onBlur={handleVinBlur}
            placeholder="1HGBH41JXMN109186"
            maxLength={17}
            className="font-mono uppercase"
          />
          {errors.vin && (
            <p className="text-sm text-destructive">{errors.vin}</p>
          )}
        </div>
      </section>

      {/* ── Section 2: Specs (5 inline native <select>) ────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Specs
        </h3>
        <div className="space-y-2">
          <Label htmlFor="vehicle-mileage">Mileage (optional)</Label>
          <Input
            id="vehicle-mileage"
            type="number"
            value={draft.mileage}
            onChange={(e) => {
              setField("mileage", e.target.value);
              clearError("mileage");
            }}
            onBlur={handleMileageBlur}
            placeholder="42500"
            min={MILEAGE_MIN}
            max={MILEAGE_MAX}
          />
          {errors.mileage && (
            <p className="text-sm text-destructive">{errors.mileage}</p>
          )}
        </div>
        {/* Q4 — 5 inline native <select> blocks. REFUTE shared <EnumSelect>
            extraction. 8+ codebase precedent sites (products status, category
            parent/status, etc.) confirm raw native selects are canonical. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="vehicle-body-style">Body style</Label>
            <select
              id="vehicle-body-style"
              value={draft.bodyStyle}
              onChange={(e) => setField("bodyStyle", e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              {BODY_STYLES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="vehicle-transmission">Transmission</Label>
            <select
              id="vehicle-transmission"
              value={draft.transmission}
              onChange={(e) => setField("transmission", e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              {TRANSMISSIONS.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="vehicle-fuel-type">Fuel type</Label>
            <select
              id="vehicle-fuel-type"
              value={draft.fuelType}
              onChange={(e) => setField("fuelType", e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              {FUEL_TYPES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="vehicle-drivetrain">Drivetrain</Label>
            <select
              id="vehicle-drivetrain"
              value={draft.drivetrain}
              onChange={(e) => setField("drivetrain", e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              {DRIVETRAINS.map((s) => (
                <option key={s} value={s}>
                  {s.toUpperCase().replace("_", "")}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="vehicle-condition">Condition</Label>
          <select
            id="vehicle-condition"
            value={draft.condition}
            onChange={(e) => setField("condition", e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
          >
            {VEHICLE_CONDITIONS.map((s) => (
              <option key={s} value={s}>
                {s === "cpo" ? "CPO" : humanize(s)}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* ── Section 3: Cosmetics ───────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cosmetics
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="vehicle-exterior-color">Exterior color</Label>
            <Input
              id="vehicle-exterior-color"
              value={draft.exteriorColor}
              onChange={(e) => setField("exteriorColor", e.target.value)}
              placeholder="Pearl White"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vehicle-interior-color">Interior color</Label>
            <Input
              id="vehicle-interior-color"
              value={draft.interiorColor}
              onChange={(e) => setField("interiorColor", e.target.value)}
              placeholder="Black Leather"
            />
          </div>
        </div>
      </section>

      {/* ── Section 4: Dealer metadata ─────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Dealer metadata
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="vehicle-stock-number">Stock number</Label>
            <Input
              id="vehicle-stock-number"
              value={draft.stockNumber}
              onChange={(e) => setField("stockNumber", e.target.value)}
              placeholder="STK-12345"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vehicle-dealer-lot">Dealer lot</Label>
            <Input
              id="vehicle-dealer-lot"
              value={draft.dealerLot}
              onChange={(e) => setField("dealerLot", e.target.value)}
              placeholder="Main"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="vehicle-status">Status</Label>
          <select
            id="vehicle-status"
            value={draft.status}
            onChange={(e) =>
              setField("status", e.target.value as VehicleStatus)
            }
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
          >
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </section>
    </div>
  );
}

/* ── Validation + payload builders ───────────────────────────────────── */

function validateDraft(draft: VehicleDraft): {
  hasErrors: boolean;
  errors: VehicleFormErrors;
} {
  const errors = emptyErrors();
  // Year required + range
  const yearNum = Number(draft.year);
  if (!draft.year.trim()) {
    errors.year = "Year is required";
  } else if (
    !Number.isFinite(yearNum) ||
    !Number.isInteger(yearNum) ||
    yearNum < YEAR_MIN ||
    yearNum > YEAR_MAX
  ) {
    errors.year = `Year must be between ${YEAR_MIN} and ${YEAR_MAX}`;
  }
  // Make required
  if (!draft.make.trim()) {
    errors.make = "Make is required";
  }
  // Model required
  if (!draft.model.trim()) {
    errors.model = "Model is required";
  }
  // VIN optional but must match regex when provided
  if (draft.vin.trim()) {
    const vinUpper = draft.vin.trim().toUpperCase();
    if (!VIN_REGEX.test(vinUpper)) {
      errors.vin =
        "VIN must be 17 alphanumeric chars (excluding I/O/Q per ISO 3779)";
    }
  }
  // Mileage optional but must be valid integer range when provided
  if (draft.mileage.trim()) {
    const m = Number(draft.mileage);
    if (
      !Number.isFinite(m) ||
      !Number.isInteger(m) ||
      m < MILEAGE_MIN ||
      m > MILEAGE_MAX
    ) {
      errors.mileage = `Mileage must be between ${MILEAGE_MIN} and ${MILEAGE_MAX.toLocaleString()}`;
    }
  }
  const hasErrors = Object.values(errors).some((v) => v !== null);
  return { hasErrors, errors };
}

function buildCreatePayload(draft: VehicleDraft): Partial<VehicleListItem> {
  return {
    year: Number(draft.year),
    make: draft.make.trim(),
    model: draft.model.trim(),
    trim: draft.trim.trim() || null,
    vin: draft.vin.trim() ? draft.vin.trim().toUpperCase() : null,
    mileage: draft.mileage.trim() ? Number(draft.mileage) : null,
    bodyStyle: draft.bodyStyle,
    transmission: draft.transmission,
    fuelType: draft.fuelType,
    drivetrain: draft.drivetrain,
    condition: draft.condition,
    exteriorColor: draft.exteriorColor.trim() || null,
    interiorColor: draft.interiorColor.trim() || null,
    stockNumber: draft.stockNumber.trim() || null,
    dealerLot: draft.dealerLot.trim() || null,
    status: draft.status,
  };
}

function buildUpdatePayload(
  id: string,
  draft: VehicleDraft,
): { id: string } & Partial<VehicleListItem> {
  return { id, ...buildCreatePayload(draft) };
}
