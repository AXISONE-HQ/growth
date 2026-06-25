"use client";

/**
 * KAN-1229 — destination-view Target section.
 *
 * After a vehicle campaign commits, the operator needs to see WHICH vehicles
 * they're marketing from the destination view (/campaigns/[id]). This renders
 * the descriptor summary + the ACTUAL committed vehicles (resolved by id via
 * vehicles.getByIds — Memo 19/42: show the real committed VINs, not just the
 * descriptor). Product-mode campaigns keep their existing display (this returns
 * null for them).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { vehiclesApi } from "@/lib/api";

const COLLAPSE_AT = 5;

function descriptorSummary(proposedPlan: unknown, count: number): string {
  const d = (
    proposedPlan as { vehicleTargetDescriptor?: Record<string, unknown> } | null
  )?.vehicleTargetDescriptor;
  const parts: string[] = [`${count} vehicle${count === 1 ? "" : "s"}`];
  if (typeof d?.condition === "string") parts.push(`condition: ${d.condition}`);
  if (typeof d?.make === "string") parts.push(`make: ${d.make}`);
  if (typeof d?.bodyStyle === "string") parts.push(`body: ${d.bodyStyle}`);
  return parts.join(" · ");
}

export interface TargetSectionProps {
  targetEntityType: "product" | "vehicle" | null;
  targetEntityIds: string[];
  proposedPlan: unknown;
}

export function TargetSection({
  targetEntityType,
  targetEntityIds,
  proposedPlan,
}: TargetSectionProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const isVehicle = targetEntityType === "vehicle" && targetEntityIds.length > 0;

  const query = useQuery({
    queryKey: ["campaign-target-vehicles", targetEntityIds],
    queryFn: () => vehiclesApi.getByIds(targetEntityIds),
    enabled: isVehicle,
  });

  // Product-mode (and untargeted) campaigns keep their existing display.
  if (targetEntityType !== "vehicle") return null;

  const vehicles = query.data?.entities ?? [];
  const shown = expanded ? vehicles : vehicles.slice(0, COLLAPSE_AT);

  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      aria-label="Campaign target"
    >
      <h2 className="text-xs uppercase tracking-wide text-muted-foreground">Target</h2>
      <p className="mt-1 text-sm font-medium text-foreground">
        {descriptorSummary(proposedPlan, targetEntityIds.length)}
      </p>

      {query.isLoading && (
        <p className="mt-3 text-xs text-muted-foreground">Loading vehicles…</p>
      )}
      {query.isError && (
        <p className="mt-3 text-xs text-muted-foreground">
          Couldn&apos;t load the targeted vehicles.
        </p>
      )}
      {!query.isLoading && !query.isError && vehicles.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {shown.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="text-foreground">
                {v.year} {v.make} {v.model}
                {v.trim ? ` ${v.trim}` : ""}
                {v.vin && (
                  <span className="ml-2 text-xs text-muted-foreground">{v.vin}</span>
                )}
                {v.removedAt && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                    Removed
                  </span>
                )}
              </span>
              {v.price != null && (
                <span className="shrink-0 text-sm text-muted-foreground">
                  ${v.price.toLocaleString("en-US")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {vehicles.length > COLLAPSE_AT && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 text-xs text-primary hover:underline"
        >
          {expanded ? "Show fewer" : `View all ${vehicles.length}`}
        </button>
      )}
    </section>
  );
}
