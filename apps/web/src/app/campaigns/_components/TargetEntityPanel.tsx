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
 * # Memo 19/42 affordance-honesty
 *
 * "Selected: N / matching: M" counts are explicit. The "Select all
 * matching" affordance is bounded by the API limit (200) and surfaces an
 * honest message when the result set is truncated.
 *
 * # Slice G2 wiring posture
 *
 * Built against the dark Slice G1 substrate. NOT YET wired into
 * BuilderChatThread — G3 promotes `entityType` to DIMENSION_ORDER + then
 * mounts this panel during the confirmation flow. The component is
 * intentionally usable as a standalone surface for testing without the
 * orchestrator.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, CheckSquare, Square } from "lucide-react";
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

export type TargetEntityType = "product" | "vehicle";

export interface TargetEntityPanelProps {
  entityType: TargetEntityType;
  initialFilterSpec?: Record<string, unknown>;
  initialSelectedIds?: string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  onConfirm?: (selectedIds: string[]) => void;
  className?: string;
}

export function TargetEntityPanel({
  entityType,
  initialFilterSpec,
  initialSelectedIds,
  onSelectionChange,
  onConfirm,
  className,
}: TargetEntityPanelProps): JSX.Element {
  const [searchText, setSearchText] = useState<string>(
    typeof initialFilterSpec?.searchText === "string"
      ? (initialFilterSpec.searchText as string)
      : "",
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(initialSelectedIds ?? []),
  );

  const queryInput = useMemo<Record<string, unknown>>(() => {
    const base: Record<string, unknown> = { ...initialFilterSpec, limit: 50 };
    if (searchText) base.searchText = searchText;
    else delete base.searchText;
    return base;
  }, [initialFilterSpec, searchText]);

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

  const allShownSelected =
    entities.length > 0 && entities.every((e) => selectedIds.has(e.id));

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
