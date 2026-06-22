"use client";

/**
 * KAN-1219 Slice G2 — VehicleTargetCard
 *
 * Operator-facing vehicle card inside the TargetEntityPanel confirmation
 * surface. Renders a single Vehicle entity (year/make/model/trim + photo +
 * mileage + price + condition badge) with a selectable checkbox.
 *
 * # SPO Q5 lock — removed VINs surfaced honestly
 *
 * If the underlying Vehicle row has `removedAt` set, the card renders an
 * amber warning (consistent with the detail page Slice F3 lifecycle
 * display) so the operator knows that VIN will be skipped at send time.
 * The send-time skip-removed semantics land at the consumer in G3; this
 * card just makes the state visible at confirm time.
 *
 * # Memo 56 #10 multi-purpose-helper amortization
 *
 * Mirrors the inventory list card pattern at
 * `apps/web/src/app/settings/inventory/page.tsx`. Same shadcn primitives,
 * same status-badge variants.
 */
import { ImageOff, Check, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { VehicleListItem } from "@/lib/api";

function humanize(s: string): string {
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export interface VehicleTargetCardProps {
  vehicle: VehicleListItem;
  selected: boolean;
  onToggle: (vehicleId: string, nextSelected: boolean) => void;
}

export function VehicleTargetCard({
  vehicle,
  selected,
  onToggle,
}: VehicleTargetCardProps): JSX.Element {
  const handleClick = (): void => {
    onToggle(vehicle.id, !selected);
  };

  const title = `${vehicle.year} ${vehicle.make} ${vehicle.model}${
    vehicle.trim ? ` ${vehicle.trim}` : ""
  }`;
  const isRemoved = vehicle.removedAt != null;
  const primaryPhoto = vehicle.photoUrls?.[0] ?? null;

  return (
    <Card
      role="button"
      aria-pressed={selected}
      aria-label={`${selected ? "Unselect" : "Select"} ${title}`}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      className={`cursor-pointer transition-colors ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "hover:border-muted-foreground/50"
      } ${isRemoved ? "border-amber-300" : ""}`}
    >
      <CardContent className="flex items-center gap-3 p-3">
        {/* Selection indicator */}
        <div
          className={`h-5 w-5 shrink-0 rounded-sm border-2 flex items-center justify-center ${
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40"
          }`}
          aria-hidden
        >
          {selected && <Check className="h-3.5 w-3.5" />}
        </div>

        {/* Vehicle photo / fallback */}
        <div className="h-14 w-20 shrink-0 rounded-md overflow-hidden bg-muted flex items-center justify-center">
          {primaryPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={primaryPhoto}
              alt={title}
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageOff className="h-5 w-5 text-muted-foreground" />
          )}
        </div>

        {/* Title + meta + badges */}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{title}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
            {vehicle.price != null && (
              <span className="tabular-nums font-medium text-foreground">
                ${vehicle.price.toLocaleString()}
              </span>
            )}
            {vehicle.mileage != null && (
              <span className="tabular-nums">
                {vehicle.mileage.toLocaleString()} mi
              </span>
            )}
            <Badge variant="muted">{humanize(vehicle.bodyStyle)}</Badge>
            <Badge variant="muted">{humanize(vehicle.condition)}</Badge>
            {isRemoved && (
              <span
                className="inline-flex items-center gap-1 text-amber-700"
                title="No longer in dealer feed; will be skipped at send time"
              >
                <AlertTriangle className="h-3 w-3" />
                Removed
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
