"use client";

/**
 * KAN-1219 Slice G2 — TargetEntityPanel
 *
 * Container component the operator uses to confirm campaign targets after
 * the LLM proposes a (entityType, filter spec) tuple. Switches between
 * product and vehicle modes based on `entityType`; renders a
 * search/filter input + a result list with TargetCard components +
 * "Selected: N / matching: M" affordances.
 *
 * # SPO 5-decision locks applied
 *
 * - Q1 — `entityType` prop is required; the panel CANNOT render in
 *   ambiguous state. G3 only mounts this once the operator has confirmed
 *   the entity type via the orchestrator.
 * - Q2 — entities are lazy-loaded via `searchForCampaignTarget`; no
 *   metadata snapshot.
 * - Q5 — multi-select via `selectedIds` set; the parent reads it back
 *   for the Confirm action that writes Campaign.targetEntityIds.
 *
 * # KAN-1230 B2.3 — auto-prefill from vehicleTargetDescriptor
 *
 * In vehicle mode the LLM-proposed `vehicleTargetDescriptor`
 * ({condition,bodyStyle,make,model,year,priceMin/Max,maxCount}) is passed via
 * `vehicleDescriptor`. The panel translates it to the API's array filters
 * (descriptorToVehicleSearch), shows removable filter CHIPS, seeds the search
 * box with make/model, and drives a cardinality affordance off `maxCount`
 * (auto-select matching, warn when matching ≠ requested — Memo 19/42 honesty).
 *
 * # Memo 19/42 affordance-honesty
 *
 * "Selected: N / matching: M" counts are explicit. The "Select all
 * matching" affordance is bounded by the API limit (200) and surfaces an
 * honest message when the result set is truncated. Cardinality mismatches
 * (fewer matching than requested) are surfaced, never silently auto-fixed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, CheckSquare, Square, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  productsApi,
  vehiclesApi,
  type ProductListItem,
  type VehicleListItem,
} from "@/lib/api";
import { ProductTargetCard } from "./ProductTargetCard";
import { VehicleTargetCard } from "./VehicleTargetCard";
import {
  descriptorToVehicleSearch,
  chipsToFilterSpec,
  type DescriptorFilterChip,
} from "./vehicleTargetDescriptor";

export type TargetEntityType = "product" | "vehicle";

// KAN-1235c — when a descriptor drives auto-select ("all matching" or a maxCount
// pick), fetch up to this many rows so the selection covers the full matching
// set, not just the first visible page. Matches the router's max limit (200).
// INTERIM: KAN-1236 will replace this page-cap with a filter-vs-enumerated
// target-mode toggle so inventories >200 commit by filter instead of an
// enumerated id list.
const ALL_MATCH_LIMIT = 200;

export interface TargetEntityPanelProps {
  entityType: TargetEntityType;
  initialFilterSpec?: Record<string, unknown>;
  /**
   * KAN-1230 B2.3 — vehicle-mode LLM target descriptor. When present the panel
   * auto-applies its filters + drives the maxCount cardinality affordance.
   */
  vehicleDescriptor?: Record<string, unknown> | null;
  initialSelectedIds?: string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  onConfirm?: (selectedIds: string[]) => void;
  className?: string;
}

export function TargetEntityPanel({
  entityType,
  initialFilterSpec,
  vehicleDescriptor,
  initialSelectedIds,
  onSelectionChange,
  onConfirm,
  className,
}: TargetEntityPanelProps): JSX.Element {
  const isVehicle = entityType === "vehicle";

  // KAN-1230 B2.3 — derive chips / search seed / maxCount from the descriptor.
  const derived = useMemo(
    () => descriptorToVehicleSearch(isVehicle ? vehicleDescriptor : undefined),
    [isVehicle, vehicleDescriptor],
  );
  const maxCount = derived.maxCount;
  // KAN-1235 — a descriptor signals an LLM-proposed target → the panel
  // auto-selects (all matching when no maxCount, first maxCount otherwise).
  // Without a descriptor the panel is a manual browser (no auto-select).
  const hasDescriptor = isVehicle && vehicleDescriptor != null;

  const [activeChips, setActiveChips] = useState<DescriptorFilterChip[]>(
    derived.chips,
  );
  const [searchText, setSearchText] = useState<string>(
    isVehicle
      ? derived.searchSeed
      : typeof initialFilterSpec?.searchText === "string"
        ? (initialFilterSpec.searchText as string)
        : "",
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(initialSelectedIds ?? []),
  );

  // Re-seed when the descriptor changes (operator re-engaged chat → new
  // proposal). Edge case 3 — re-applies the proposed filters.
  useEffect(() => {
    if (!isVehicle) return;
    setActiveChips(derived.chips);
    setSearchText(derived.searchSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived]);

  const queryInput = useMemo<Record<string, unknown>>(() => {
    if (isVehicle) {
      // KAN-1235c — descriptor-driven selection needs the full matching set
      // (up to ALL_MATCH_LIMIT), not just the first page, or "all matching"
      // would silently commit only the first 50.
      const limit = hasDescriptor ? ALL_MATCH_LIMIT : 50;
      return { ...chipsToFilterSpec(activeChips, searchText), limit };
    }
    const base: Record<string, unknown> = { ...initialFilterSpec, limit: 50 };
    if (searchText) base.searchText = searchText;
    else delete base.searchText;
    return base;
  }, [isVehicle, hasDescriptor, activeChips, searchText, initialFilterSpec]);

  const productQuery = useQuery({
    queryKey: ["campaigns", "target-search", "product", queryInput],
    queryFn: () =>
      productsApi.searchForCampaignTarget(queryInput as Parameters<
        typeof productsApi.searchForCampaignTarget
      >[0]),
    enabled: entityType === "product",
  });
  const vehicleQuery = useQuery({
    queryKey: ["campaigns", "target-search", "vehicle", queryInput],
    queryFn: () =>
      vehiclesApi.searchForCampaignTarget(queryInput as Parameters<
        typeof vehiclesApi.searchForCampaignTarget
      >[0]),
    enabled: entityType === "vehicle",
  });

  const active = entityType === "product" ? productQuery : vehicleQuery;
  const isLoading = active.isLoading;
  const isError = active.isError;
  const totalCount = active.data?.totalCount ?? 0;
  const entities = (active.data?.entities ?? []) as Array<
    ProductListItem | VehicleListItem
  >;

  function notifySelection(next: Set<string>): void {
    setSelectedIds(next);
    onSelectionChange?.(Array.from(next));
  }

  // KAN-1230 B2.3 / KAN-1235 — auto-select from an LLM-proposed descriptor.
  // Once per distinct query result: no maxCount (goal-context / "target all") →
  // pre-select ALL matching for max reach; maxCount set (explicit pick) → first
  // maxCount. Manual edits persist (the key guard skips re-firing); a filter
  // change produces a new key → re-applies. No-descriptor panels don't auto-
  // select (manual browse).
  const autoSelectedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasDescriptor) return;
    if (isLoading || isError || !active.data) return;
    const key = JSON.stringify(queryInput);
    if (autoSelectedKeyRef.current === key) return;
    autoSelectedKeyRef.current = key;
    const ids =
      maxCount === undefined
        ? entities.map((e) => e.id)
        : entities.slice(0, maxCount).map((e) => e.id);
    notifySelection(new Set(ids));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDescriptor, maxCount, active.data, isLoading, isError, queryInput]);

  function toggleOne(id: string, nextSelected: boolean): void {
    const next = new Set(selectedIds);
    if (nextSelected) next.add(id);
    else next.delete(id);
    notifySelection(next);
  }

  function selectAllMatching(): void {
    const next = new Set(selectedIds);
    for (const e of entities) next.add(e.id);
    notifySelection(next);
  }

  function clearSelection(): void {
    notifySelection(new Set());
  }

  function removeChip(key: string): void {
    // Reset the auto-select guard so the new (broader) result re-applies.
    autoSelectedKeyRef.current = null;
    setActiveChips((prev) => prev.filter((c) => c.key !== key));
  }

  const allShownSelected =
    entities.length > 0 && entities.every((e) => selectedIds.has(e.id));

  // KAN-1230 B2.3 / KAN-1235 — cardinality message (Memo 19/42 — honest).
  const cardinality = useMemo<
    { tone: "amber" | "info" | "ok"; text: string } | null
  >(() => {
    if (!hasDescriptor || isLoading || isError || !active.data) return null;
    if (totalCount === 0) return null;
    // KAN-1235 — no maxCount → targeting ALL matching inventory (max reach).
    if (maxCount === undefined) {
      // KAN-1235c — honest cap disclosure (Memo 19/42). We can only select up
      // to ALL_MATCH_LIMIT; beyond that, say so rather than claim "all".
      if (totalCount > ALL_MATCH_LIMIT) {
        return {
          tone: "amber",
          text: `${ALL_MATCH_LIMIT} of ${totalCount} matching selected — narrow the filter to include all.`,
        };
      }
      return {
        tone: "info",
        text: `${totalCount} selected (all matching) — refine the filter to narrow.`,
      };
    }
    if (totalCount < maxCount) {
      return {
        tone: "amber",
        text: `${maxCount} requested, ${totalCount} matching — confirm ${totalCount}?`,
      };
    }
    if (totalCount > maxCount) {
      return {
        tone: "info",
        text: `${maxCount} requested; ${totalCount} match. First ${maxCount} selected — use "Select all matching" or refine the filter.`,
      };
    }
    return { tone: "ok", text: `${maxCount} of ${totalCount} matching selected.` };
  }, [hasDescriptor, maxCount, isLoading, isError, active.data, totalCount]);

  return (
    <Card className={className} aria-label="Campaign target selection panel">
      <CardContent className="space-y-3 p-4">
        {/* Header with counts + entity label */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-semibold capitalize">{entityType} targets</div>
            <div className="text-xs text-muted-foreground">
              Selected: {selectedIds.size} / matching: {totalCount}
              {totalCount > entities.length && entities.length === 50 && (
                <span className="ml-1 text-amber-700">
                  (showing first 50 — narrow filter to see more)
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={allShownSelected ? clearSelection : selectAllMatching}
              disabled={entities.length === 0}
            >
              {allShownSelected ? (
                <Square className="h-4 w-4" />
              ) : (
                <CheckSquare className="h-4 w-4" />
              )}
              {allShownSelected ? "Clear" : "Select all matching"}
            </Button>
            {onConfirm && (
              <Button
                size="sm"
                onClick={() => onConfirm(Array.from(selectedIds))}
                disabled={selectedIds.size === 0}
              >
                Confirm ({selectedIds.size})
              </Button>
            )}
          </div>
        </div>

        {/* KAN-1230 B2.3 — auto-applied filter chips (removable) */}
        {activeChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
            {activeChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 rounded-[var(--ds-radius-pill)] bg-muted px-2.5 py-1 text-xs text-foreground"
              >
                {chip.label}
                <button
                  type="button"
                  onClick={() => removeChip(chip.key)}
                  aria-label={`Remove filter ${chip.label}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* KAN-1230 B2.3 — cardinality affordance */}
        {cardinality && (
          <div
            role="status"
            className={`rounded-md px-3 py-2 text-xs ${
              cardinality.tone === "amber"
                ? "border border-amber-300 bg-amber-50 text-amber-900"
                : cardinality.tone === "info"
                  ? "border border-border bg-muted/40 text-muted-foreground"
                  : "border border-emerald-300 bg-emerald-50 text-emerald-900"
            }`}
          >
            {cardinality.text}
          </div>
        )}

        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={`Search ${entityType}s…`}
            className="pl-8"
            aria-label={`Search ${entityType}s`}
          />
        </div>

        {/* Result list */}
        {isLoading && (
          <div className="text-sm text-muted-foreground p-4 text-center">
            Loading {entityType}s…
          </div>
        )}
        {isError && (
          <div className="text-sm text-destructive p-4 text-center">
            Failed to load {entityType}s. Try again.
          </div>
        )}
        {!isLoading && !isError && entities.length === 0 && (
          <div className="text-sm text-muted-foreground p-4 text-center border border-dashed rounded-md">
            No {entityType}s match the current filters.
          </div>
        )}
        {!isLoading && !isError && entities.length > 0 && (
          <div className="space-y-2 max-h-[480px] overflow-y-auto">
            {entityType === "product"
              ? (entities as ProductListItem[]).map((p) => (
                  <ProductTargetCard
                    key={p.id}
                    product={p}
                    selected={selectedIds.has(p.id)}
                    onToggle={toggleOne}
                  />
                ))
              : (entities as VehicleListItem[]).map((v) => (
                  <VehicleTargetCard
                    key={v.id}
                    vehicle={v}
                    selected={selectedIds.has(v.id)}
                    onToggle={toggleOne}
                  />
                ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
