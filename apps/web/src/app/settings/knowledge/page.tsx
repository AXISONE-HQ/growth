/**
 * /settings/knowledge — Knowledge Center admin route.
 *
 * DS v1 alignment cohort: hero + MetricStrip + section header + SourceList.
 *
 * Spec layout (docs/design-system/v1.md Part 1 §Layout grid + Part 3 §8):
 *   ┌────────────────────────────────────────────┐
 *   │ Knowledge Center           (text-display)  │
 *   │ Documents the AI uses…    (text-body)     │
 *   ├────────────────────────────────────────────┤
 *   │ MetricStrip — 4 cells                      │
 *   ├────────────────────────────────────────────┤
 *   │ Sources                  (text-h2)         │
 *   │ <SourceList />                             │
 *   └────────────────────────────────────────────┘
 *
 * Both queries (tier-limits + sources) live here AND inside SourceList. Same
 * TanStack Query keys → cache-deduped to a single round-trip per resource.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { SourceList } from "@/components/knowledge/source-list";
import { MetricStrip, humanizeBytes } from "@/components/growth/metric-strip";
import { API_BASE, buildHeaders } from "@/lib/api";
import { relativeTime } from "@/lib/relative-time";

interface KnowledgeSourceRow {
  id: string;
  createdAt: string;
  fileSizeBytes: number | null;
  chunkCount: number;
}

interface TierLimitsResponse {
  currentSourceCount: number;
}

export default function KnowledgeSourcesPage(): React.ReactElement {
  const sourcesQuery = useQuery<{ sources: KnowledgeSourceRow[] }>({
    queryKey: ["knowledge", "sources", { category: null }],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/knowledge/sources`, {
        headers: await buildHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { sources: KnowledgeSourceRow[] };
    },
  });

  const tierQuery = useQuery<TierLimitsResponse>({
    queryKey: ["knowledge", "tier-limits"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/knowledge/tier-limits`, {
        headers: await buildHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as TierLimitsResponse;
    },
  });

  const isLoading = sourcesQuery.isLoading || tierQuery.isLoading;
  const sources = sourcesQuery.data?.sources ?? [];
  const totalSources = tierQuery.data?.currentSourceCount ?? sources.length;
  const chunksIndexed = sources.reduce((sum, s) => sum + (s.chunkCount ?? 0), 0);
  const storageBytes = sources.reduce((sum, s) => sum + (s.fileSizeBytes ?? 0), 0);
  const lastAdded = sources.length
    ? relativeTime(
        new Date(
          sources.reduce(
            (latest, s) =>
              new Date(s.createdAt).getTime() > latest ? new Date(s.createdAt).getTime() : latest,
            0,
          ),
        ),
      )
    : "—";

  return (
    <div className="px-6 py-8 max-w-6xl mx-auto">
      {/* Hero — text-display heading + descriptive subtitle */}
      <header className="mb-8">
        <h1 className="text-display" style={{ color: "var(--ds-ink-primary)" }}>
          Knowledge Center
        </h1>
        <p
          className="text-body mt-2"
          style={{ color: "var(--ds-ink-secondary)" }}
        >
          Documents the AI uses to answer customer questions specifically — not generically.
        </p>
      </header>

      {/* MetricStrip — 4 cells derived from existing queries (no new endpoint) */}
      <section className="mb-8" aria-label="Knowledge center summary">
        <MetricStrip
          loading={isLoading}
          metrics={[
            { label: "Total sources", value: totalSources },
            { label: "Chunks indexed", value: chunksIndexed },
            { label: "Storage used", value: humanizeBytes(storageBytes) },
            { label: "Last source added", value: lastAdded },
          ]}
        />
      </section>

      {/* Section header above the source list */}
      <h2 className="text-h2 mb-4" style={{ color: "var(--ds-ink-primary)" }}>
        Sources
      </h2>

      <SourceList />
    </div>
  );
}
