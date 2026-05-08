// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge Sources admin page (KAN-829), reused by Sprint 12+ surfaces

/**
 * SourceList — admin list view for tenant knowledge sources.
 *
 * **Design System v1 compliance:**
 *  - All colors via `--ds-*` tokens (zero hardcoded hex)
 *  - Composes shadcn primitives (Button, Card, Table, Badge — DS-mapped)
 *  - Layout mirrors `mockup-brain-status.html` per-category card pattern
 *  - Sentence case throughout (verb + object button labels)
 *  - Borders not shadows (default DS treatment)
 *  - Color paired with text label/icon on every state (no color-only signals)
 *  - Audited against forbidden words (magic, simply, just, easily, seamlessly,
 *    revolutionary, cutting-edge, leverage, synergy) — none present
 *
 * **Polling contract:** TanStack Query `refetchInterval` returns 5000ms
 * while ANY source row has status='queued' or 'embedding'; otherwise false
 * (polling disabled). Function-form so it re-evaluates on each fetch.
 *
 * **KAN-830 hand-off:** the "Last used in N replies" column renders "—"
 * placeholder until KAN-830 wires the chunk_retrieved audit aggregation.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusPill, type StatusPillStatus } from "@/components/ui/knowledge/status-pill";
import { CategoryBadge, type Category } from "@/components/ui/knowledge/category-badge";
import { AddSourceDialog } from "./add-source-dialog";
import { SourceDetailDialog } from "./source-detail-dialog";
import { DeleteSourceConfirm } from "./delete-source-confirm";
import { CategoryTabs } from "./category-tabs";
import { FaqList } from "./faq-list";
import { ServiceList } from "./service-list";
import {
  UpgradePromptDialog,
  type UpgradeReason,
  type LockedFeature,
} from "./upgrade-prompt-dialog";
import { isKnownTier, type Tier } from "@/lib/tier-labels";
import { API_BASE, buildHeaders } from "@/lib/api";

interface KnowledgeSource {
  id: string;
  sourceType: "pdf" | "paste_text" | "faq" | "website" | "spreadsheet" | "social";
  category: Category;
  title: string | null;
  status: StatusPillStatus;
  fileName: string | null;
  fileSizeBytes: number | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
  chunkCount: number;
}

interface TierLimitsResponse {
  planTier: string;
  limits: {
    maxSources: number;
    maxPdfMB: number;
    allowsPdf: boolean;
    allowedCategories: string[];
  };
  currentSourceCount: number;
  remaining: number;
}

// Category filter options. `'all'` is the unfiltered sentinel — the
// SourceList ↔ CategoryTabs boundary maps it to/from the internal
// `null`-state convention (null means "no category filter applied").
//
// `'faq'` (KAN-849) and `'services'` (KAN-XXX) are render-mode switches —
// they mount FaqList / ServiceList instead of filtering the source table.
// All other tabs filter knowledge_source rows by category.
const CATEGORY_TABS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "faq", label: "FAQ" },
  { value: "services", label: "Services" },
  { value: "inventory", label: "Inventory" },
  { value: "warranty", label: "Warranty" },
  { value: "pricing", label: "Pricing" },
  { value: "other", label: "Other" },
];

export function SourceList(): React.ReactElement {
  const [categoryFilter, setCategoryFilter] = React.useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = React.useState(false);
  const [selectedDetailId, setSelectedDetailId] = React.useState<string | null>(null);
  const [selectedDeleteId, setSelectedDeleteId] = React.useState<string | null>(null);
  const [selectedDeleteTitle, setSelectedDeleteTitle] = React.useState<string | null>(null);
  // KAN-829 sub-cohort 6 — upgrade prompt state. Driven by Add CTA at-limit
  // interception OR by AddSourceDialog tier-locked card clicks (which call
  // onTierLocked → triggers feature-locked variant + closes the add dialog).
  const [upgradePrompt, setUpgradePrompt] = React.useState<
    | { reason: UpgradeReason; feature?: LockedFeature }
    | null
  >(null);

  // KAN-849/XXX — when the FAQ or Services tab is active, treat the sources
  // query as unfiltered (FAQ entries / Services don't live in knowledge_source).
  // The body renders FaqList / ServiceList in those modes regardless of this
  // query's data, so the request is just precaching for when the user
  // switches back.
  const sourceCategoryFilter =
    categoryFilter === "faq" || categoryFilter === "services"
      ? null
      : categoryFilter;
  const sourcesQuery = useQuery<{ sources: KnowledgeSource[] }>({
    queryKey: ["knowledge", "sources", { category: sourceCategoryFilter }],
    queryFn: async () => {
      const path = sourceCategoryFilter
        ? `/api/knowledge/sources?category=${sourceCategoryFilter}`
        : "/api/knowledge/sources";
      const res = await fetch(`${API_BASE}${path}`, { headers: await buildHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { sources: KnowledgeSource[] };
    },
    // Conditional polling — 5s while any source is in-flight; off otherwise.
    // TanStack Query v4 signature: refetchInterval receives (data, query).
    refetchInterval: (data: { sources: KnowledgeSource[] } | undefined): number | false => {
      const sources = data?.sources ?? [];
      const hasInFlight = sources.some(
        (s) => s.status === "queued" || s.status === "embedding",
      );
      return hasInFlight ? 5000 : false;
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

  const sources = sourcesQuery.data?.sources ?? [];
  const tierData = tierQuery.data;
  const currentTier: Tier = isKnownTier(tierData?.planTier ?? "")
    ? (tierData!.planTier as Tier)
    : "free";

  /**
   * Add CTA pre-flight: if the operator is already at the source cap, swap
   * the Add Source dialog for the upgrade prompt with `count-at-limit`.
   * Tier-data still loading → fall through (server enforces 403 on POST as
   * the backstop; better than a slow-query lockout).
   */
  const handleAddClick = React.useCallback(() => {
    if (tierData && tierData.currentSourceCount >= tierData.limits.maxSources) {
      setUpgradePrompt({ reason: "count-at-limit" });
      return;
    }
    setIsAddDialogOpen(true);
  }, [tierData]);

  const handleTierLocked = React.useCallback((feature: LockedFeature) => {
    setIsAddDialogOpen(false);
    setUpgradePrompt({ reason: "feature-locked", feature });
  }, []);

  // KAN-849/XXX — FAQ + Services tabs are render-mode switches, NOT category
  // filters. Each lives in its own table and owns its own Add CTA, empty
  // state, and table layout. The tier-limit pill applies to KnowledgeSource
  // rows only (FAQ + Services are unlimited per cohort decision) — hidden
  // when either custom-entity tab is active.
  const isFaqTab = categoryFilter === "faq";
  const isServicesTab = categoryFilter === "services";
  const isCustomEntityTab = isFaqTab || isServicesTab;

  return (
    <div className="flex flex-col gap-4">
      {/* Source-tab header — hidden in custom-entity modes (FaqList /
       * ServiceList render their own Add CTA). */}
      {!isCustomEntityTab ? (
        <div className="flex items-center justify-between">
          {tierData ? <TierLimitPill tier={tierData} /> : <span aria-hidden="true" />}
          <Button onClick={handleAddClick} aria-label="Add knowledge source">
            Add knowledge source
          </Button>
        </div>
      ) : null}

      {/* Category filter — underline tabs (was filter chips pre-cohort).
       * null↔'all' boundary mapper: SourceList stores `categoryFilter`
       * as `string | null` (null = no filter), CategoryTabs uses 'all'
       * as the unfiltered sentinel value. */}
      <CategoryTabs
        categories={CATEGORY_TABS}
        selectedCategory={categoryFilter ?? "all"}
        onCategoryChange={(next) => setCategoryFilter(next === "all" ? null : next)}
      />

      {/* Body — FaqList / ServiceList in their respective modes, else the
       * source table flow. */}
      <div className="mt-2">
        {isFaqTab ? (
          <FaqList />
        ) : isServicesTab ? (
          <ServiceList />
        ) : sourcesQuery.isLoading ? (
          <SkeletonTable />
        ) : sourcesQuery.isError ? (
          <ErrorState onRetry={() => void sourcesQuery.refetch()} />
        ) : sources.length === 0 ? (
          <EmptyState onAdd={handleAddClick} />
        ) : (
          <SourceTable
            sources={sources}
            onViewDetails={(id) => setSelectedDetailId(id)}
            onRequestDelete={(id, title) => {
              setSelectedDeleteId(id);
              setSelectedDeleteTitle(title);
            }}
          />
        )}
      </div>

      <AddSourceDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        onTierLocked={handleTierLocked}
      />

      <UpgradePromptDialog
        open={upgradePrompt !== null}
        onOpenChange={(next) => {
          if (!next) setUpgradePrompt(null);
        }}
        reason={upgradePrompt?.reason ?? "count-at-limit"}
        currentTier={currentTier}
        feature={upgradePrompt?.feature}
      />

      <SourceDetailDialog
        sourceId={selectedDetailId}
        open={selectedDetailId !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedDetailId(null);
        }}
        onRequestDelete={(id) => {
          const target = sources.find((s) => s.id === id) ?? null;
          setSelectedDetailId(null);
          setSelectedDeleteId(id);
          setSelectedDeleteTitle(target?.title ?? target?.fileName ?? null);
        }}
      />

      <DeleteSourceConfirm
        sourceId={selectedDeleteId}
        sourceTitle={selectedDeleteTitle}
        open={selectedDeleteId !== null}
        onOpenChange={(next) => {
          if (!next) {
            setSelectedDeleteId(null);
            setSelectedDeleteTitle(null);
          }
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// TierLimitPill — verbatim DS v1 token mapping; switches to warning at 80%.
// ─────────────────────────────────────────────

function TierLimitPill({ tier }: { tier: TierLimitsResponse }): React.ReactElement {
  const ratio = tier.limits.maxSources === 0 ? 0 : tier.currentSourceCount / tier.limits.maxSources;
  const isWarning = ratio >= 0.8;

  const styles = isWarning
    ? {
        backgroundColor: "var(--ds-warning-soft)",
        color: "var(--ds-warning-text)",
        borderColor: "color-mix(in srgb, var(--ds-warning) 30%, transparent)",
      }
    : {
        backgroundColor: "var(--ds-surface-sunken)",
        color: "var(--ds-ink-secondary)",
        borderColor: "var(--ds-border-default)",
      };

  const label = `${tier.currentSourceCount} of ${tier.limits.maxSources} sources used`;

  return (
    <div
      role="status"
      aria-label={`Source limit: ${label}${isWarning ? " — approaching limit" : ""}`}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border mb-4"
      style={styles}
    >
      {label}
    </div>
  );
}

// ─────────────────────────────────────────────
// EmptyState — verbatim DS v1 + Knowledge Center vision copy
// ─────────────────────────────────────────────

function EmptyState({ onAdd }: { onAdd: () => void }): React.ReactElement {
  // Three-part empty state per spec docs/design-system/v1.md Part 4:
  //   1. Why it's empty (heading)
  //   2. When it will populate (body)
  //   3. What the user can do (CTA)
  return (
    <div
      className="flex flex-col items-center text-center py-16 px-6 rounded-lg border"
      style={{
        backgroundColor: "var(--ds-surface-raised)",
        borderColor: "var(--ds-border-subtle)",
      }}
    >
      <h3
        className="text-h3 mb-2"
        style={{ color: "var(--ds-ink-primary)" }}
      >
        No knowledge sources yet.
      </h3>
      <p
        className="text-body max-w-md mb-6"
        style={{ color: "var(--ds-ink-secondary)" }}
      >
        Sources appear here as you add them. The AI uses them to answer customer questions specifically — not generically.
      </p>
      <Button onClick={onAdd} aria-label="Add knowledge source">
        Add knowledge source
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// SkeletonTable — loading state per spec Part 4 (400ms-3s window).
// Surface-sunken bg, no shimmer, matches final shape.
// ─────────────────────────────────────────────

function SkeletonTable(): React.ReactElement {
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: "var(--ds-border-subtle)" }}
      aria-label="Loading knowledge sources"
      role="status"
    >
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-4 border-b last:border-0"
          style={{ borderColor: "var(--ds-border-subtle)" }}
        >
          <div
            className="rounded h-4 flex-[2]"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
          <div
            className="rounded h-4 flex-1"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
          <div
            className="rounded h-4 flex-1"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
          <div
            className="rounded h-4 w-20"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// ErrorState — distinguish user-fixable from system-retriable per spec Part 4.
// This one is system-retriable: retry hits the same query, no user action needed.
// ─────────────────────────────────────────────

function ErrorState({ onRetry }: { onRetry: () => void }): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-col items-center text-center py-12 px-6 rounded-lg border"
      style={{
        backgroundColor: "var(--ds-danger-soft)",
        borderColor: "var(--ds-danger)",
        color: "var(--ds-danger-text)",
      }}
    >
      <p className="text-body mb-4">
        We couldn&apos;t load your knowledge sources. Try again.
      </p>
      <Button
        variant="outline"
        onClick={onRetry}
        aria-label="Retry loading knowledge sources"
      >
        Try again
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// SourceTable — composed shadcn Table; status pill + category badge per row
// ─────────────────────────────────────────────

function SourceTable({
  sources,
  onViewDetails,
  onRequestDelete,
}: {
  sources: KnowledgeSource[];
  onViewDetails: (id: string) => void;
  onRequestDelete: (id: string, title: string | null) => void;
}): React.ReactElement {
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: "var(--ds-border-subtle)" }}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Chunks</TableHead>
            <TableHead>Last used in N replies (last 7 days)</TableHead>
            <TableHead aria-label="Row actions"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((s) => {
            const rowTitle = s.title ?? s.fileName ?? null;
            return (
              <TableRow key={s.id} data-source-id={s.id}>
                <TableCell className="font-medium">
                  {rowTitle ?? "(untitled)"}
                </TableCell>
                <TableCell>
                  <CategoryBadge category={s.category} />
                </TableCell>
                <TableCell style={{ color: "var(--ds-ink-tertiary)" }}>
                  {sourceTypeLabel(s.sourceType)}
                </TableCell>
                <TableCell>
                  <StatusPill status={s.status} />
                </TableCell>
                <TableCell style={{ color: "var(--ds-ink-tertiary)" }}>{s.chunkCount}</TableCell>
                <TableCell
                  style={{ color: "var(--ds-ink-tertiary)" }}
                  data-kan830-placeholder="true"
                  title="KAN-830 will wire chunk_retrieved audit aggregation per source"
                >
                  {/* TODO(KAN-830): wire chunk_retrieved audit aggregation per source over last 7 days */}
                  —
                </TableCell>
                <TableCell>
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onViewDetails(s.id)}
                      aria-label={`View details for ${rowTitle ?? "source"}`}
                    >
                      View details
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRequestDelete(s.id, rowTitle)}
                      aria-label={`Delete source ${rowTitle ?? ""}`.trim()}
                    >
                      Delete source
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function sourceTypeLabel(t: KnowledgeSource["sourceType"]): string {
  switch (t) {
    case "pdf":
      return "PDF";
    case "paste_text":
      return "Paste text";
    case "faq":
      return "FAQ";
    case "website":
      return "Website";
    case "spreadsheet":
      return "Spreadsheet";
    case "social":
      return "Social media";
  }
}
