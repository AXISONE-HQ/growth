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

import { useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Plus,
  Car,
  Trash2,
  Pencil,
  Globe,
  RefreshCw,
  X,
  Search,
  SlidersHorizontal,
} from "lucide-react";
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
  type VehicleListInput,
  type VehicleListSort,
  type CursorPage,
  type CrawlJobRecord,
  type CrawlJobStatus,
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

// KAN-1219 Slice C — Filter state + URL sync helpers.
//
// Filter dimensions are stored in a single object; URL state sync via
// next/navigation reflects active filters as querystring (shareable links).
// Memo 19/42 affordance-honesty — URL is the source of truth for "what the
// operator is currently looking at," so bookmarks + back/forward work.

interface UiFilters {
  searchText: string;
  sort: VehicleListSort;
  statusFilter: VehicleStatus[];
  bodyStyleIn: string[];
  makeIn: string[];
  transmissionIn: string[];
  fuelTypeIn: string[];
  drivetrainIn: string[];
  conditionIn: string[];
  yearMin: string;
  yearMax: string;
  mileageMin: string;
  mileageMax: string;
  priceMin: string;
  priceMax: string;
}

const EMPTY_FILTERS: UiFilters = {
  searchText: "",
  sort: "createdAt_desc",
  statusFilter: DEFAULT_STATUS_FILTER,
  bodyStyleIn: [],
  makeIn: [],
  transmissionIn: [],
  fuelTypeIn: [],
  drivetrainIn: [],
  conditionIn: [],
  yearMin: "",
  yearMax: "",
  mileageMin: "",
  mileageMax: "",
  priceMin: "",
  priceMax: "",
};

const SORT_OPTIONS: Array<{ value: VehicleListSort; label: string }> = [
  { value: "createdAt_desc", label: "Newest first" },
  { value: "year_desc", label: "Year (newest)" },
  { value: "year_asc", label: "Year (oldest)" },
  { value: "mileage_asc", label: "Mileage (lowest)" },
  { value: "mileage_desc", label: "Mileage (highest)" },
  { value: "price_asc", label: "Price (lowest)" },
  { value: "price_desc", label: "Price (highest)" },
];

function parseCsv(v: string | null): string[] {
  return v ? v.split(",").filter(Boolean) : [];
}

function decodeFilters(sp: URLSearchParams): UiFilters {
  const status = parseCsv(sp.get("status")) as VehicleStatus[];
  const sort = (sp.get("sort") as VehicleListSort | null) ?? "createdAt_desc";
  return {
    searchText: sp.get("q") ?? "",
    sort,
    statusFilter: status.length > 0 ? status : DEFAULT_STATUS_FILTER,
    bodyStyleIn: parseCsv(sp.get("bodyStyle")),
    makeIn: parseCsv(sp.get("make")),
    transmissionIn: parseCsv(sp.get("transmission")),
    fuelTypeIn: parseCsv(sp.get("fuelType")),
    drivetrainIn: parseCsv(sp.get("drivetrain")),
    conditionIn: parseCsv(sp.get("condition")),
    yearMin: sp.get("yearMin") ?? "",
    yearMax: sp.get("yearMax") ?? "",
    mileageMin: sp.get("mileageMin") ?? "",
    mileageMax: sp.get("mileageMax") ?? "",
    priceMin: sp.get("priceMin") ?? "",
    priceMax: sp.get("priceMax") ?? "",
  };
}

function encodeFilters(f: UiFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.searchText) sp.set("q", f.searchText);
  if (f.sort !== "createdAt_desc") sp.set("sort", f.sort);
  // statusFilter only emitted if it diverges from DEFAULT.
  const isDefaultStatus =
    f.statusFilter.length === DEFAULT_STATUS_FILTER.length &&
    DEFAULT_STATUS_FILTER.every((s) => f.statusFilter.includes(s));
  if (!isDefaultStatus) sp.set("status", f.statusFilter.join(","));
  if (f.bodyStyleIn.length > 0) sp.set("bodyStyle", f.bodyStyleIn.join(","));
  if (f.makeIn.length > 0) sp.set("make", f.makeIn.join(","));
  if (f.transmissionIn.length > 0) sp.set("transmission", f.transmissionIn.join(","));
  if (f.fuelTypeIn.length > 0) sp.set("fuelType", f.fuelTypeIn.join(","));
  if (f.drivetrainIn.length > 0) sp.set("drivetrain", f.drivetrainIn.join(","));
  if (f.conditionIn.length > 0) sp.set("condition", f.conditionIn.join(","));
  if (f.yearMin) sp.set("yearMin", f.yearMin);
  if (f.yearMax) sp.set("yearMax", f.yearMax);
  if (f.mileageMin) sp.set("mileageMin", f.mileageMin);
  if (f.mileageMax) sp.set("mileageMax", f.mileageMax);
  if (f.priceMin) sp.set("priceMin", f.priceMin);
  if (f.priceMax) sp.set("priceMax", f.priceMax);
  return sp;
}

// "Active filter count" — number of filter DIMENSIONS that are currently
// constraining results (excludes default-status + sort, which are baseline).
function countActiveFilters(f: UiFilters): number {
  let n = 0;
  if (f.searchText) n++;
  if (f.bodyStyleIn.length > 0) n++;
  if (f.makeIn.length > 0) n++;
  if (f.transmissionIn.length > 0) n++;
  if (f.fuelTypeIn.length > 0) n++;
  if (f.drivetrainIn.length > 0) n++;
  if (f.conditionIn.length > 0) n++;
  if (f.yearMin || f.yearMax) n++;
  if (f.mileageMin || f.mileageMax) n++;
  if (f.priceMin || f.priceMax) n++;
  return n;
}

function parseNumOrUndefined(s: string): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function FilterChipRow({
  label,
  options,
  selected,
  onToggle,
  emptyHint,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  emptyHint?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">
        {label}:
      </span>
      {options.length === 0 && emptyHint ? (
        <span className="text-xs text-muted-foreground italic">{emptyHint}</span>
      ) : (
        options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onToggle(o)}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              selected.includes(o)
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted"
            }`}
            aria-pressed={selected.includes(o)}
          >
            {humanize(o)}
          </button>
        ))
      )}
    </div>
  );
}

function RangeFilter({
  label,
  min,
  max,
  onMinChange,
  onMaxChange,
  placeholder,
}: {
  label: string;
  min: string;
  max: string;
  onMinChange: (v: string) => void;
  onMaxChange: (v: string) => void;
  placeholder: [string, string];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">
        {label}:
      </span>
      <Input
        type="number"
        inputMode="numeric"
        placeholder={`Min (${placeholder[0]})`}
        value={min}
        onChange={(e) => onMinChange(e.target.value)}
        className="w-36 h-8 text-xs"
        aria-label={`${label} minimum`}
      />
      <span className="text-xs text-muted-foreground">to</span>
      <Input
        type="number"
        inputMode="numeric"
        placeholder={`Max (${placeholder[1]})`}
        value={max}
        onChange={(e) => onMaxChange(e.target.value)}
        className="w-36 h-8 text-xs"
        aria-label={`${label} maximum`}
      />
    </div>
  );
}

function VehiclesTab() {
  // KAN-1219 Slice C — Hydrate filter state from URL on mount.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read URL once; state is the source of truth thereafter (URL is mirrored
  // back via router.replace on every change). Avoids re-reading on every
  // searchParams identity change (which Next would force).
  const [filters, setFilters] = useState<UiFilters>(() =>
    decodeFilters(
      new URLSearchParams(searchParams ? searchParams.toString() : ""),
    ),
  );
  const [pages, setPages] = useState<CursorPage<VehicleListItem>[]>([]);
  // KAN-1219 fix-forward v3 — explicit cursor state decouples pagination
  // from the query-input feedback loop. Cursor advances ONLY via the Load
  // More button click (operator intent), not silently via setPages updates.
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<VehicleListItem | null>(null);
  const [scrapeOpen, setScrapeOpen] = useState(false);
  const [activeCrawlJobId, setActiveCrawlJobId] = useState<string | null>(null);

  // Sync URL on filter change (replace — no history pollution). Also mirror
  // the filter querystring into sessionStorage so the Slice E detail page can
  // restore the operator's filter view on "Back to inventory".
  //
  // KAN-1219 fix-forward — track last-emitted querystring in a ref and skip
  // the replace when filters genuinely haven't changed. Without this guard
  // the useEffect re-fires on pathname-only dep changes (e.g. during in-flight
  // `<Link>` navigation), and the `router.replace(${pathname}?${qs})` races
  // against the Link's `router.push(<new>)` — left-click silently no-ops
  // while right-click ("Open in new tab") still works because it uses the
  // href directly. The ref-skip eliminates the race.
  const lastQsRef = useRef<string | null>(null);
  useEffect(() => {
    const sp = encodeFilters(filters);
    const qs = sp.toString();
    if (lastQsRef.current === qs) return;
    lastQsRef.current = qs;
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(
          "kan-1219-inventory-filter-querystring",
          qs,
        );
      } catch {
        // sessionStorage may be unavailable in some sandboxes; safe fallback.
      }
    }
  }, [filters, router, pathname]);

  // KAN-1219 Slice E — consume ?edit=<vehicleId> from the URL (used by the
  // detail page's Edit button). When present, fetch the row and open the
  // edit modal; then strip the param from the URL so a refresh doesn't
  // re-trigger.
  useEffect(() => {
    if (!searchParams) return;
    const editId = searchParams.get("edit");
    if (!editId || editing) return;
    void vehiclesApi
      .get(editId, true)
      .then((vehicle) => {
        setEditing(vehicle);
        const next = new URLSearchParams(searchParams.toString());
        next.delete("edit");
        const qs = next.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname);
      })
      .catch(() => {
        // Quietly drop: vehicle may not exist, tenant mismatch, etc.
      });
  }, [searchParams, editing, router, pathname]);

  // KAN-1219 fix-forward v3 — Option L cascade fix.
  //
  // Prior shape coupled `currentCursor = pages[pages.length - 1]?.nextCursor`
  // into the query input. Every successful fetch fired setPages → cursor
  // advanced → query re-ran for next page → setPages → repeat until
  // nextCursor=null. With 134 vehicles + 50/page = 3 auto-fetches that look
  // like a refetch loop in DevTools Network. The cascading re-renders
  // interrupted in-flight <Link> click navigation — operator left-click
  // never landed despite the visual-clickable parity fix from PR #378.
  //
  // Fix: explicit `cursor` state. Cursor only advances when the operator
  // clicks Load More (or the filter resets to null). Query refires only
  // on operator-triggered state change.
  //
  // Reset cursor + paged accumulator when filter shape changes.
  useEffect(() => {
    setPages([]);
    setCursor(null);
  }, [
    filters.searchText,
    filters.sort,
    filters.statusFilter,
    filters.bodyStyleIn,
    filters.makeIn,
    filters.transmissionIn,
    filters.fuelTypeIn,
    filters.drivetrainIn,
    filters.conditionIn,
    filters.yearMin,
    filters.yearMax,
    filters.mileageMin,
    filters.mileageMax,
    filters.priceMin,
    filters.priceMax,
  ]);

  const includeArchived = filters.statusFilter.includes("archived");
  const onlyOneStatusSelected =
    filters.statusFilter.length === 1 ? filters.statusFilter[0] : undefined;

  // useMemo so the queryInput object identity is stable across re-renders
  // when filter values are unchanged — prevents the queryKey from churning
  // and triggering unrelated refetches.
  const queryInput = useMemo<VehicleListInput>(() => ({
    limit: 50,
    includeArchived,
    ...(onlyOneStatusSelected ? { status: onlyOneStatusSelected } : {}),
    ...(cursor ? { cursor } : {}),
    sort: filters.sort,
    ...(filters.searchText ? { searchText: filters.searchText } : {}),
    ...(filters.bodyStyleIn.length > 0 ? { bodyStyleIn: filters.bodyStyleIn } : {}),
    ...(filters.makeIn.length > 0 ? { makeIn: filters.makeIn } : {}),
    ...(filters.transmissionIn.length > 0 ? { transmissionIn: filters.transmissionIn } : {}),
    ...(filters.fuelTypeIn.length > 0 ? { fuelTypeIn: filters.fuelTypeIn } : {}),
    ...(filters.drivetrainIn.length > 0 ? { drivetrainIn: filters.drivetrainIn } : {}),
    ...(filters.conditionIn.length > 0 ? { conditionIn: filters.conditionIn } : {}),
    ...(parseNumOrUndefined(filters.yearMin) !== undefined
      ? { yearMin: parseNumOrUndefined(filters.yearMin) }
      : {}),
    ...(parseNumOrUndefined(filters.yearMax) !== undefined
      ? { yearMax: parseNumOrUndefined(filters.yearMax) }
      : {}),
    ...(parseNumOrUndefined(filters.mileageMin) !== undefined
      ? { mileageMin: parseNumOrUndefined(filters.mileageMin) }
      : {}),
    ...(parseNumOrUndefined(filters.mileageMax) !== undefined
      ? { mileageMax: parseNumOrUndefined(filters.mileageMax) }
      : {}),
    ...(parseNumOrUndefined(filters.priceMin) !== undefined
      ? { priceMin: parseNumOrUndefined(filters.priceMin) }
      : {}),
    ...(parseNumOrUndefined(filters.priceMax) !== undefined
      ? { priceMax: parseNumOrUndefined(filters.priceMax) }
      : {}),
  }), [
    includeArchived,
    onlyOneStatusSelected,
    cursor,
    filters.sort,
    filters.searchText,
    filters.bodyStyleIn,
    filters.makeIn,
    filters.transmissionIn,
    filters.fuelTypeIn,
    filters.drivetrainIn,
    filters.conditionIn,
    filters.yearMin,
    filters.yearMax,
    filters.mileageMin,
    filters.mileageMax,
    filters.priceMin,
    filters.priceMax,
  ]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<VehicleListItem>
  >({
    queryKey: ["vehicles", "list", queryInput],
    queryFn: () => vehiclesApi.list(queryInput),
    staleTime: 30_000,
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

  // Client-side filter: server applies single-status filter; if multiple
  // non-archived statuses selected, narrow client-side.
  const allItems = pages.flatMap((p) => p.items);
  const items = allItems.filter((v) => filters.statusFilter.includes(v.status));
  const hasMore =
    (pages[pages.length - 1]?.nextCursor ?? data?.nextCursor) != null;

  // Distinct makes derived from current page set (no extra API surface).
  const distinctMakes = useMemo(() => {
    const set = new Set<string>();
    for (const v of allItems) set.add(v.make);
    return [...set].sort();
  }, [allItems]);

  const activeFilterCount = countActiveFilters(filters);

  function toggleStatusChip(s: VehicleStatus): void {
    setFilters((prev) => {
      if (prev.statusFilter.includes(s)) {
        if (prev.statusFilter.length === 1) return prev;
        return {
          ...prev,
          statusFilter: prev.statusFilter.filter((x) => x !== s),
        };
      }
      return { ...prev, statusFilter: [...prev.statusFilter, s] };
    });
  }

  function toggleArrayFilter(key: keyof UiFilters, v: string): void {
    setFilters((prev) => {
      const arr = prev[key] as string[];
      const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
      return { ...prev, [key]: next };
    });
  }

  function clearAllFilters(): void {
    setFilters({ ...EMPTY_FILTERS, statusFilter: filters.statusFilter });
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
      setCursor(null);
      void refetch();
    } catch (e) {
      // KAN-1290 Slice 6 — Memo 19/42 affordance-honesty at the mutation
      // error boundary. Surface an actionable retry that re-fires the same
      // mutation; the second confirm is intentionally skipped (operator
      // already consented; this is a transient infra retry).
      toast.error((e as Error)?.message ?? "Failed to archive vehicle", {
        action: {
          label: "Retry",
          onClick: () => {
            void (async () => {
              try {
                await vehiclesApi.archive(v.id);
                toast.success("Vehicle archived");
                setPages([]);
                setCursor(null);
                void refetch();
              } catch (retryErr) {
                toast.error(
                  (retryErr as Error)?.message ?? "Retry failed",
                );
              }
            })();
          },
        },
      });
    }
  }

  return (
    <div className="space-y-4">
      {/* KAN-1219 Slice C — Top bar: search + sort + more-filters + actions. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[260px]">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search make, model, VIN, stock #"
              value={filters.searchText}
              onChange={(e) =>
                setFilters((f) => ({ ...f, searchText: e.target.value }))
              }
              className="pl-8"
              aria-label="Search inventory"
            />
          </div>
          <select
            value={filters.sort}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                sort: e.target.value as VehicleListSort,
              }))
            }
            className="px-3 py-1.5 text-xs border rounded-md bg-background"
            aria-label="Sort vehicles"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMoreFiltersOpen((x) => !x)}
            aria-expanded={moreFiltersOpen}
            aria-controls="vehicle-more-filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            More filters
            {activeFilterCount > 0 && (
              <Badge variant="default" className="ml-1 text-xs px-1.5">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
          {activeFilterCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAllFilters}
              aria-label="Clear all filters"
            >
              <X className="h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* KAN-1219 Slice F2 — Manual dealer-feed sync. Operator fallback
              for when the daily GH Actions cron is broken OR for empirical
              probing of whether Cloud Run egress can reach the dealer feed
              (4mkauto CAPTCHA-blocks the Cloud Run IP range; the daily
              cron uses a GH-hosted runner IP). Failure surfaces a
              "wait-for-the-cron" message to keep operator-affordance
              honesty (Memo 19/42). Distinct from "Scrape inventory" which
              crawls the HTML listing — this one consumes the dealer JSON
              feed and writes lifecycle columns. */}
          <SyncNowButton />
          {/* KAN-1219 (Slice 5 of KAN-1211 epic) — Full-inventory crawler
              trigger. Replaces the Slice-3 affordance-honesty placeholder
              (was disabled with "Available after KAN-1216 Slice 4 merge"
              tooltip). Disabled while a crawl is active to honor the
              one-at-a-time Q4 lock at server side; tooltip surfaces the
              concurrent-prevention reason to the operator. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setScrapeOpen(true)}
            disabled={activeCrawlJobId !== null}
            title={
              activeCrawlJobId
                ? "A crawl is already running"
                : "Crawl your inventory listing page"
            }
            aria-label="Scrape inventory"
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

      {/* Status + body style chip rows — always visible. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Status:</span>
        {STATUS_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => toggleStatusChip(opt.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
              filters.statusFilter.includes(opt.value)
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted"
            }`}
            aria-pressed={filters.statusFilter.includes(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Body:</span>
        {BODY_STYLES.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => toggleArrayFilter("bodyStyleIn", b)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
              filters.bodyStyleIn.includes(b)
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted"
            }`}
            aria-pressed={filters.bodyStyleIn.includes(b)}
          >
            {humanize(b)}
          </button>
        ))}
      </div>

      {/* Collapsible "More filters" panel. */}
      {moreFiltersOpen && (
        <Card id="vehicle-more-filters" className="border-dashed">
          <CardContent className="space-y-4 pt-6">
            <FilterChipRow
              label="Make"
              options={distinctMakes}
              selected={filters.makeIn}
              onToggle={(v) => toggleArrayFilter("makeIn", v)}
              emptyHint="No makes in current inventory yet"
            />
            <FilterChipRow
              label="Transmission"
              options={[...TRANSMISSIONS]}
              selected={filters.transmissionIn}
              onToggle={(v) => toggleArrayFilter("transmissionIn", v)}
            />
            <FilterChipRow
              label="Fuel type"
              options={[...FUEL_TYPES]}
              selected={filters.fuelTypeIn}
              onToggle={(v) => toggleArrayFilter("fuelTypeIn", v)}
            />
            <FilterChipRow
              label="Drivetrain"
              options={[...DRIVETRAINS]}
              selected={filters.drivetrainIn}
              onToggle={(v) => toggleArrayFilter("drivetrainIn", v)}
            />
            <FilterChipRow
              label="Condition"
              options={[...VEHICLE_CONDITIONS]}
              selected={filters.conditionIn}
              onToggle={(v) => toggleArrayFilter("conditionIn", v)}
            />
            <RangeFilter
              label="Year"
              min={filters.yearMin}
              max={filters.yearMax}
              onMinChange={(v) => setFilters((f) => ({ ...f, yearMin: v }))}
              onMaxChange={(v) => setFilters((f) => ({ ...f, yearMax: v }))}
              placeholder={["1900", "2028"]}
            />
            <RangeFilter
              label="Mileage"
              min={filters.mileageMin}
              max={filters.mileageMax}
              onMinChange={(v) => setFilters((f) => ({ ...f, mileageMin: v }))}
              onMaxChange={(v) => setFilters((f) => ({ ...f, mileageMax: v }))}
              placeholder={["0", "999,999"]}
            />
            <RangeFilter
              label="Price ($)"
              min={filters.priceMin}
              max={filters.priceMax}
              onMinChange={(v) => setFilters((f) => ({ ...f, priceMin: v }))}
              onMaxChange={(v) => setFilters((f) => ({ ...f, priceMax: v }))}
              placeholder={["0", "9,999,999"]}
            />
          </CardContent>
        </Card>
      )}

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
        // Q5 — inline <Card border-dashed> empty state. KAN-1219 Slice C
        // branches copy based on whether filters are active.
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Car className="h-10 w-10 text-muted-foreground/50" />
            {activeFilterCount > 0 ? (
              <div>
                <p className="text-sm font-medium">
                  No vehicles match current filters
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Adjust or clear filters to see more results
                </p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={clearAllFilters}
                  className="mt-2"
                >
                  Clear all filters
                </Button>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium">
                  No vehicles in inventory yet
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Click Create vehicle to add your first vehicle
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {items.map((v) => {
          const label = `${v.year} ${v.make} ${v.model}`;
          const trimSuffix = v.trim ? ` ${v.trim}` : "";
          // KAN-1219 fix-forward v2 — the <Link> wraps the ENTIRE card so the
          // padding / border area is part of the clickable surface. The prior
          // shape (Link around inner content only) left the visible card edges
          // unclickable — operators naturally click anywhere on the styled
          // bordered card and got no response, while right-click "Open in new
          // tab" worked when targeted at the inner text. Memo 19/42
          // affordance-honesty extension — visual interactive area must match
          // the actual clickable interactive area.
          //
          // The Edit / Archive buttons inside use e.preventDefault() +
          // e.stopPropagation() to prevent the Link's left-click navigation
          // when their own onClick fires. button-inside-a is non-standard per
          // HTML spec but handled consistently by all major browsers when the
          // descendant button stops the click event.
          return (
            <Link
              key={v.id}
              href={`/settings/inventory/${v.id}`}
              aria-label={`Open ${label} detail`}
              className="block rounded-lg border bg-card hover:border-primary transition-colors"
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
                      {v.price != null && (
                        <span className="text-xs font-medium tabular-nums">
                          ${v.price.toLocaleString()}
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
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditing(v);
                    }}
                    aria-label={`Edit ${label}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {v.status !== "archived" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleArchive(v);
                      }}
                      aria-label={`Archive ${label}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // KAN-1219 fix-forward v3 — operator-explicit cursor advance.
              // Setting cursor changes the memoized queryInput identity →
              // useQuery re-fires for the next page. No silent cascade.
              const nextCursor = pages[pages.length - 1]?.nextCursor ?? data?.nextCursor ?? null;
              if (nextCursor) setCursor(nextCursor);
            }}
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
          setFilters((f) => ({ ...f, statusFilter: DEFAULT_STATUS_FILTER }));
          setPages([]);
          setCursor(null);
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
          setFilters((f) => ({ ...f, statusFilter: DEFAULT_STATUS_FILTER }));
          setPages([]);
          setCursor(null);
          void refetch();
        }}
      />

      {/* KAN-1219 — ScrapeInventoryModal triggers vehicles.startCrawl.
          On success, sets activeCrawlJobId so CrawlJobProgressCard mounts
          and polls. */}
      <ScrapeInventoryModal
        open={scrapeOpen}
        onOpenChange={setScrapeOpen}
        onStarted={(jobId) => {
          setScrapeOpen(false);
          setActiveCrawlJobId(jobId);
        }}
      />

      {/* KAN-1219 — CrawlJobProgressCard polls vehicles.crawlStatus every
          2000ms (Memo 32 — UI polling precedent imports/[id]:105-117 used
          1500ms; 2000ms here aligns with the crawler pacing interval).
          On terminal status, refetches the vehicle list (newly-extracted
          rows surface) + clears activeCrawlJobId. */}
      {activeCrawlJobId && (
        <CrawlJobProgressCard
          crawlJobId={activeCrawlJobId}
          onTerminal={() => {
            setActiveCrawlJobId(null);
            setPages([]);
            setCursor(null);
            void refetch();
          }}
          onDismiss={() => setActiveCrawlJobId(null)}
        />
      )}
    </div>
  );
}

/* ── SyncNowButton — KAN-1219 Slice F2 ───────────────────────────────── */

function SyncNowButton() {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await vehiclesApi.triggerManualSync();
      const moved =
        result.createdCount + result.updatedCount + result.removedCount;
      if (moved === 0 && result.parsedEntries > 0) {
        toast.success(
          `Inventory in sync (${result.unchangedCount} unchanged, ${result.skippedEntries} skipped)`,
        );
      } else {
        toast.success(
          `Synced: ${result.createdCount} new · ${result.updatedCount} updated · ${result.removedCount} removed`,
        );
      }
      // Refetch list — query keys are cache-managed elsewhere; manual
      // refresh via location.reload is intentional KISS until the slice
      // closes (operator-empirical signal: did the new rows appear?).
      window.setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Manual sync failed";
      toast.error(message, { duration: 8000 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={busy}
      title="Re-fetch the dealer JSON feed and reconcile inventory now"
      aria-label="Sync now"
    >
      <RefreshCw
        className={`h-4 w-4 ${busy ? "animate-spin" : ""}`}
      />
      {busy ? "Syncing…" : "Sync now"}
    </Button>
  );
}

/* ── ScrapeInventoryModal — KAN-1219 ─────────────────────────────────── */

function ScrapeInventoryModal({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (crawlJobId: string) => void;
}) {
  const [listingUrl, setListingUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setListingUrl("");
      setSubmitting(false);
    }
  }, [open]);

  async function handleSubmit(): Promise<void> {
    const trimmed = listingUrl.trim();
    if (!trimmed) {
      toast.error("Listing URL is required");
      return;
    }
    // Lightweight client-side URL validation; server-side authoritative
    // via z.string().url() at vehicles.startCrawl.
    try {
      new URL(trimmed);
    } catch {
      toast.error("Invalid URL");
      return;
    }
    setSubmitting(true);
    try {
      const result = await vehiclesApi.startCrawl(trimmed);
      toast.success("Crawl started");
      onStarted(result.crawlJob.id);
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to start crawl");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scrape inventory</DialogTitle>
          <DialogDescription>
            Paste your dealer&apos;s inventory listing URL. The crawler will
            walk each VDP, extract vehicle details, and skip any VIN already
            in your inventory. You can cancel at any time.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="scrape-listing-url">Listing URL</Label>
          <Input
            id="scrape-listing-url"
            value={listingUrl}
            onChange={(e) => setListingUrl(e.target.value)}
            placeholder="https://dealer.example.com/inventory"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Must match your configured marketing domain.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Starting..." : "Start crawl"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── CrawlJobProgressCard — KAN-1219 polling progress UI ─────────────── */

const TERMINAL_CRAWL_STATUSES: ReadonlySet<CrawlJobStatus> = new Set([
  "completed",
  "completed_with_errors",
  "cancelled",
  "failed",
]);

function crawlStatusLabel(s: CrawlJobStatus): string {
  switch (s) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "completed_with_errors":
      return "Completed with errors";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
  }
}

function crawlStatusVariant(
  s: CrawlJobStatus,
): "muted" | "green" | "rose" | "amber" {
  if (s === "completed") return "green";
  if (s === "completed_with_errors") return "amber";
  if (s === "failed" || s === "cancelled") return "rose";
  return "muted";
}

function CrawlJobProgressCard({
  crawlJobId,
  onTerminal,
  onDismiss,
}: {
  crawlJobId: string;
  onTerminal: () => void;
  onDismiss: () => void;
}) {
  const { data: job } = useQuery<CrawlJobRecord>({
    queryKey: ["vehicles", "crawlStatus", crawlJobId],
    queryFn: () => vehiclesApi.crawlStatus(crawlJobId),
    // Memo 32 — UI polling precedent at imports/[id]:105-117. 2000ms here
    // aligns with crawler pacing interval; stops on terminal status.
    refetchInterval: (data) => {
      const next = data as unknown as CrawlJobRecord | undefined;
      if (!next) return 2000;
      return TERMINAL_CRAWL_STATUSES.has(next.status) ? false : 2000;
    },
  });

  // Fire onTerminal when status transitions to terminal.
  useEffect(() => {
    if (job && TERMINAL_CRAWL_STATUSES.has(job.status)) {
      // Defer so the user can still see the terminal counters before the
      // parent refetches the vehicle list.
      const t = setTimeout(onTerminal, 1500);
      return () => clearTimeout(t);
    }
  }, [job, onTerminal]);

  async function handleCancel(): Promise<void> {
    if (!confirm("Cancel this crawl? Already-extracted vehicles are kept.")) {
      return;
    }
    try {
      await vehiclesApi.cancelCrawl(crawlJobId);
      toast.success("Crawl cancelled");
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to cancel crawl");
    }
  }

  if (!job) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm">Crawl starting...</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  const isTerminal = TERMINAL_CRAWL_STATUSES.has(job.status);
  const isRunning = job.status === "running" || job.status === "pending";
  const progressPct =
    job.discoveredCount > 0
      ? Math.round(
          ((job.extractedCount + job.failedCount + job.skippedVinDuplicateCount) /
            job.discoveredCount) *
            100,
        )
      : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            Inventory crawl
            <Badge
              variant={crawlStatusVariant(job.status)}
              className="text-xs"
            >
              {crawlStatusLabel(job.status)}
            </Badge>
          </CardTitle>
          {isTerminal && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onDismiss}
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground break-all">
          {job.listingUrl}
        </div>
        {job.discoveredCount > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span>
                {job.extractedCount + job.failedCount + job.skippedVinDuplicateCount}
                {" / "}
                {job.discoveredCount} URLs
              </span>
              <span className="tabular-nums">{progressPct}%</span>
            </div>
            <div className="h-2 bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Discovered</div>
            <div className="font-medium tabular-nums">
              {job.discoveredCount}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Extracted</div>
            <div className="font-medium tabular-nums text-green-600">
              {job.extractedCount}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">VIN-skipped</div>
            <div className="font-medium tabular-nums">
              {job.skippedVinDuplicateCount}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Failed</div>
            <div className="font-medium tabular-nums text-red-600">
              {job.failedCount}
            </div>
          </div>
        </div>
        {isRunning && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={handleCancel}>
              Cancel crawl
            </Button>
          </div>
        )}
        {job.cancelReason && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Reason: </span>
            {job.cancelReason}
          </div>
        )}
        {/* KAN-1219 fix-forward — Memo 57 anchor #5 + Memo 42 affordance-
            honesty. When publish_infrastructure_gap fires (Pub/Sub publish
            failed because the topic is unprovisioned or otherwise NOT_FOUND),
            surface the underlying message so the operator + on-call can
            diagnose without round-tripping to logs. Other failure variants
            already surface counters; this one has no per-URL extract phase
            because the worker never started. */}
        {job.status === "failed" &&
          job.cancelReason === "publish_infrastructure_gap" &&
          job.errorSamples?.[0]?.message && (
            <div className="text-xs text-red-600 break-words">
              <span className="font-medium">Publish failed: </span>
              {job.errorSamples[0].message}
            </div>
          )}
      </CardContent>
    </Card>
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
