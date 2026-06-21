"use client";

/**
 * KAN-1219 Slice E (Slice 7 of KAN-1211 epic) — Vehicle detail page.
 *
 * Renders the per-vehicle detail surface fed by Slice D substrate
 * (photoUrls + description + features) at the route
 * `/settings/inventory/[vehicleId]`.
 *
 * # SPO scope locks (Slice E directive)
 *
 * - Carousel: main photo + thumbnail strip (per Fred earlier Q2 choice).
 * - Description: render as preformatted text (preserves newlines from
 *   /tmp/cars-import.json post_content). UTF-8 native; no markdown
 *   transform in Slice E (Memo 54 empirical-priority — defer rich-text
 *   render until operator demand).
 * - Features: humanized chips (UI render-time transformation of semantic
 *   tokens — `remote_start` → "Remote start"). Matches inventory list
 *   chip-toggle pattern from Slice C.
 * - Edit + Archive: Edit links to `/settings/inventory?edit=<id>` (inventory
 *   page consumes that query param to auto-open the existing edit modal —
 *   single-source-of-truth UX). Archive calls vehiclesApi.archive with
 *   window.confirm; on success navigates back to inventory.
 * - "Back to inventory" link preserves filter querystring from the previous
 *   inventory visit (sessionStorage key, written by the inventory page
 *   on URL changes — small extension for round-trip operator UX).
 *
 * # Memo 56 #10 helper-component amortization (UI substrate)
 *
 * `SpecCell` × N field instances + `ChipRow` × 1 (features) + `Section`
 * wrapper compress the per-element substrate cost. Pattern matches
 * /settings/inventory/page.tsx FilterChipRow + RangeFilter helper
 * extraction.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Activity,
  CalendarClock,
  CircleX,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  vehiclesApi,
  type VehicleActivityEvent,
  type VehicleListItem,
} from "@/lib/api";

const INVENTORY_FILTER_STATE_KEY = "kan-1219-inventory-filter-querystring";

function humanize(s: string): string {
  return s
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function statusBadgeVariant(s: VehicleListItem["status"]): "muted" | "green" | "rose" {
  if (s === "active") return "green";
  if (s === "archived") return "rose";
  return "muted";
}

// ─────────────────────────────────────────────────────────────────────
// Detail page
// ─────────────────────────────────────────────────────────────────────

export default function VehicleDetailPage() {
  const params = useParams<{ vehicleId: string }>();
  const router = useRouter();
  const vehicleId = params?.vehicleId ?? "";

  const { data, isLoading, isError, error } = useQuery<VehicleListItem>({
    queryKey: ["vehicles", "get", vehicleId, true],
    queryFn: () => vehiclesApi.get(vehicleId, true),
    enabled: vehicleId.length > 0,
  });

  // Restore "Back to inventory" filter querystring from sessionStorage.
  const [backHref, setBackHref] = useState<string>("/settings/inventory");
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.sessionStorage.getItem(INVENTORY_FILTER_STATE_KEY);
      if (stored && stored.length > 0) {
        setBackHref(`/settings/inventory?${stored}`);
      }
    } catch {
      // sessionStorage may be unavailable in some sandboxes; safe fallback.
    }
  }, []);

  async function handleArchive(v: VehicleListItem): Promise<void> {
    const label = `${v.year} ${v.make} ${v.model}`;
    if (!confirm(`Archive "${label}"? This cannot be undone.`)) return;
    try {
      await vehiclesApi.archive(v.id);
      toast.success("Vehicle archived");
      router.push(backHref);
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to archive vehicle");
    }
  }

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-4">
        <Card className="animate-pulse">
          <CardContent className="h-64" />
        </Card>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="container mx-auto p-6 space-y-4">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to inventory
        </Link>
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              Couldn&apos;t load vehicle
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-destructive/80">
              {(error as Error)?.message ?? "Unknown error"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const v = data;
  const title = `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ""}`;

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-1">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            aria-label="Back to inventory"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to inventory
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/settings/inventory?edit=${v.id}`}>
            <Button variant="outline" size="sm">
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
          </Link>
          {v.status !== "archived" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleArchive(v)}
              aria-label="Archive vehicle"
            >
              <Trash2 className="h-4 w-4" />
              Archive
            </Button>
          )}
        </div>
      </div>

      {/* Title row */}
      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <Badge variant={statusBadgeVariant(v.status)}>{humanize(v.status)}</Badge>
          {v.price != null && (
            <span className="text-xl font-semibold tabular-nums">
              ${v.price.toLocaleString()}
            </span>
          )}
        </div>
        <div className="text-sm text-muted-foreground mt-1 flex gap-3 flex-wrap">
          {v.vin && <span>VIN: {v.vin}</span>}
          {v.stockNumber && <span>Stock #{v.stockNumber}</span>}
          {v.dealerLot && <span>Lot: {v.dealerLot}</span>}
        </div>
      </div>

      {/* Main 2-col grid */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
          <PhotoCarousel photoUrls={v.photoUrls} alt={title} />
        </div>
        <div className="lg:col-span-2 space-y-6">
          <Section title="Specifications">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <SpecCell label="Year" value={String(v.year)} />
              <SpecCell label="Make" value={v.make} />
              <SpecCell label="Model" value={v.model} />
              <SpecCell label="Trim" value={v.trim} />
              <SpecCell label="Body style" value={humanize(v.bodyStyle)} />
              <SpecCell label="Condition" value={humanize(v.condition)} />
              <SpecCell label="Transmission" value={humanize(v.transmission)} />
              <SpecCell label="Drivetrain" value={humanize(v.drivetrain)} />
              <SpecCell label="Fuel type" value={humanize(v.fuelType)} />
              <SpecCell
                label="Mileage"
                value={v.mileage != null ? `${v.mileage.toLocaleString()} mi` : null}
              />
              <SpecCell label="Exterior color" value={v.exteriorColor} />
              <SpecCell label="Interior color" value={v.interiorColor} />
            </div>
          </Section>
        </div>
      </div>

      {/* Features */}
      {v.features.length > 0 && (
        <Section title="Features">
          <FeatureChipGrid features={v.features} />
        </Section>
      )}

      {/* Description */}
      {v.description && (
        <Section title="Description">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">
            {v.description}
          </p>
        </Section>
      )}

      {/* KAN-1219 Slice F3 — Lifecycle dates + activity timeline. */}
      <LifecycleSection vehicle={v} />
      <ActivityTimeline vehicleId={v.id} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// KAN-1219 Slice F3 — Lifecycle dates section
//
// Renders firstSeenAt / lastSeenAt as plain rows; renders removedAt as a
// warning row ONLY when set. firstSeenAt/lastSeenAt diverge after the
// first daily sync confirms each VIN; removedAt is set when the VIN
// disappears from the dealer feed (sold / delisted).
// ─────────────────────────────────────────────────────────────────────

function LifecycleSection({ vehicle }: { vehicle: VehicleListItem }) {
  return (
    <Section title="Lifecycle">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <LifecycleDateCell
          icon={<CalendarClock className="h-4 w-4" />}
          label="First seen"
          iso={vehicle.firstSeenAt}
        />
        <LifecycleDateCell
          icon={<Activity className="h-4 w-4" />}
          label="Last seen"
          iso={vehicle.lastSeenAt}
        />
        {vehicle.removedAt && (
          <LifecycleDateCell
            icon={<CircleX className="h-4 w-4 text-amber-600" />}
            label="Removed"
            iso={vehicle.removedAt}
            tone="warning"
          />
        )}
      </div>
      {vehicle.removedAt && (
        <p className="mt-3 text-xs text-amber-700">
          This VIN is no longer in the dealer&apos;s published feed. It may have
          been sold or delisted.
        </p>
      )}
    </Section>
  );
}

function LifecycleDateCell({
  icon,
  label,
  iso,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  iso: string;
  tone?: "warning";
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        tone === "warning" ? "border-amber-300 bg-amber-50" : ""
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-medium tabular-nums">{formatAbsolute(iso)}</div>
      <div className="text-xs text-muted-foreground">{formatRelative(iso)}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// KAN-1219 Slice F3 — Activity timeline
//
// Surfaces the per-vehicle audit_log feed (operator mutations + daily
// sync events). Action-type + extraction-source humanization mappings
// keep raw enum strings out of operator UX (Memo 19/42 affordance-
// honesty). Events grouped by calendar date for readability.
// ─────────────────────────────────────────────────────────────────────

const ACTION_TYPE_LABELS: Record<string, string> = {
  "vehicle.created": "Vehicle added to inventory",
  "vehicle.updated": "Vehicle updated",
  "vehicle.scraped": "Vehicle scraped from dealer site",
  "vehicle.archived": "Vehicle archived",
  "vehicle.sync_seen": "Confirmed in inventory sync",
  "vehicle.sync_created": "Added via inventory sync",
  "vehicle.sync_removed": "Marked removed (no longer in dealer feed)",
};

const EXTRACTION_SOURCE_LABELS: Record<string, string> = {
  manual_import_4mkauto_kan_1219: "Initial bulk import",
  manual_import_4mkauto_kan_1219_detail_backfill: "Photo / description backfill",
  manual_import_4mkauto_kan_1219_lifecycle_backfill: "Lifecycle backfill",
  manual_import_4mkauto_kan_1219_price_backfill: "Price backfill",
  "github-actions-daily-cron": "Daily auto-sync (GitHub Actions)",
  "operator-sync-now": "Manual sync (operator-triggered)",
  "inventory-sync-api": "Inventory sync API",
};

function labelForActionType(type: string): string {
  return ACTION_TYPE_LABELS[type] ?? humanize(type.replace(/^vehicle\./, ""));
}

function labelForExtractionSource(source: string | null): string | null {
  if (!source) return null;
  return EXTRACTION_SOURCE_LABELS[source] ?? source;
}

function ActivityTimeline({ vehicleId }: { vehicleId: string }) {
  const { data, isLoading, isError } = useQuery<VehicleActivityEvent[]>({
    queryKey: ["vehicles", "getActivityLog", vehicleId],
    queryFn: () => vehiclesApi.getActivityLog(vehicleId),
    enabled: vehicleId.length > 0,
  });

  if (isLoading) {
    return (
      <Section title="Activity">
        <div className="text-sm text-muted-foreground">Loading activity…</div>
      </Section>
    );
  }
  if (isError) {
    return (
      <Section title="Activity">
        <div className="text-sm text-destructive">Couldn&apos;t load activity log.</div>
      </Section>
    );
  }
  if (!data || data.length === 0) {
    return (
      <Section title="Activity">
        <div className="text-sm text-muted-foreground">
          No activity recorded yet.
        </div>
      </Section>
    );
  }

  const grouped = groupByDate(data);
  return (
    <Section title="Activity">
      <div className="space-y-5">
        {grouped.map(({ dateLabel, events }) => (
          <div key={dateLabel} className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {dateLabel}
            </div>
            <ul className="space-y-2">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="flex items-start gap-3 text-sm border rounded-md p-3"
                >
                  <div className="mt-0.5 shrink-0 text-muted-foreground">
                    <Activity className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">
                      {labelForActionType(e.actionType)}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatAbsoluteWithTime(e.createdAt)}
                    </div>
                    {labelForExtractionSource(e.extractionSource) && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Source: {labelForExtractionSource(e.extractionSource)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

function groupByDate(
  events: VehicleActivityEvent[],
): Array<{ dateLabel: string; events: VehicleActivityEvent[] }> {
  const buckets = new Map<string, VehicleActivityEvent[]>();
  for (const e of events) {
    const key = new Date(e.createdAt).toISOString().slice(0, 10);
    const list = buckets.get(key) ?? [];
    list.push(e);
    buckets.set(key, list);
  }
  return Array.from(buckets.entries()).map(([key, evs]) => ({
    dateLabel: formatDateGroupLabel(key),
    events: evs,
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Date formatters (kept inline — used only by Slice F3 surfaces)
// ─────────────────────────────────────────────────────────────────────

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatAbsoluteWithTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateGroupLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateAtMidnight = new Date(date);
  dateAtMidnight.setHours(0, 0, 0, 0);
  const diffDays = Math.round(
    (today.getTime() - dateAtMidnight.getTime()) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo} month${diffMo === 1 ? "" : "s"} ago`;
  const diffYr = Math.round(diffMo / 12);
  return `${diffYr} year${diffYr === 1 ? "" : "s"} ago`;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers — kept inline per Memo 56 #10 helper-component amortization
// ─────────────────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SpecCell({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium">
        {value && value.length > 0 ? value : <span className="text-muted-foreground">—</span>}
      </div>
    </>
  );
}

function FeatureChipGrid({ features }: { features: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {features.map((f) => (
        <span
          key={f}
          className="px-2.5 py-1 text-xs rounded-md border bg-muted text-muted-foreground"
        >
          {humanize(f)}
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// PhotoCarousel
// ─────────────────────────────────────────────────────────────────────

function PhotoCarousel({ photoUrls, alt }: { photoUrls: string[]; alt: string }) {
  const [index, setIndex] = useState(0);
  const [errored, setErrored] = useState<Set<number>>(new Set());

  const valid = useMemo(() => photoUrls.filter((u) => /^https?:\/\//.test(u)), [photoUrls]);

  if (valid.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <ImageOff className="h-8 w-8" />
          <p className="text-sm">No photos available</p>
        </CardContent>
      </Card>
    );
  }

  const safeIndex = Math.min(Math.max(index, 0), valid.length - 1);
  const main = valid[safeIndex]!;

  function prev() {
    setIndex((i) => (i <= 0 ? valid.length - 1 : i - 1));
  }
  function next() {
    setIndex((i) => (i >= valid.length - 1 ? 0 : i + 1));
  }

  return (
    <div className="space-y-2">
      <div className="relative bg-muted rounded-lg overflow-hidden">
        {errored.has(safeIndex) ? (
          <div className="aspect-[4/3] flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImageOff className="h-8 w-8" />
            <p className="text-xs">Failed to load photo</p>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={main}
            alt={`${alt} — photo ${safeIndex + 1} of ${valid.length}`}
            className="w-full aspect-[4/3] object-cover"
            onError={() => setErrored((s) => new Set(s).add(safeIndex))}
          />
        )}
        {valid.length > 1 && (
          <>
            <button
              type="button"
              onClick={prev}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background rounded-full p-2 shadow"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={next}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background rounded-full p-2 shadow"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div className="absolute bottom-2 right-2 bg-background/80 px-2 py-0.5 rounded text-xs tabular-nums">
              {safeIndex + 1} / {valid.length}
            </div>
          </>
        )}
      </div>
      {valid.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1" role="list" aria-label="Photo thumbnails">
          {valid.map((url, i) => (
            <button
              key={`${url}-${i}`}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`View photo ${i + 1}`}
              aria-current={i === safeIndex}
              className={`shrink-0 rounded-md overflow-hidden border-2 transition-colors ${
                i === safeIndex ? "border-primary" : "border-transparent hover:border-muted-foreground/30"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt=""
                className="h-16 w-20 object-cover"
                onError={() => setErrored((s) => new Set(s).add(i))}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
