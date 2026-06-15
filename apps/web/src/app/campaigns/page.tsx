'use client';

/**
 * KAN-1183 — /campaigns list view (replaces Slice 2 propose-preview).
 *
 * Canonical list-page pattern: DataTable<CampaignListItem> + CursorPage<T>
 * cursor pagination + debounced 300ms search + status filter chip strip.
 * Mirrors companies / customers / deals / orders list pages so operator
 * mental-model stays consistent across entities (KAN-1183 Q-ADD A2).
 *
 * The Slice 2 propose-preview that used to live here (KAN-1000) shipped as
 * a flag-gated "Internal Preview" surface to test text-to-segment audience
 * filter parsing in PROD. The conversational builder at /campaigns/new
 * (KAN-1187/KAN-1188) supersedes it — operators describe intent
 * conversationally; AI proposes Action Plan; multi-Pipeline materialization
 * via campaigns.commitActionPlan (KAN-1190). Until that lands, the
 * [+ New Campaign] CTA is intentionally disabled with a tooltip pointing
 * to KAN-1188.
 *
 * Q-ADD F lock: Always-On Campaigns (Campaign.isAlwaysOn=true) are hidden
 * from this list by default. campaignsApi.list({ includeAlwaysOn: true })
 * is the debug escape — not surfaced in operator UI.
 */

import { Megaphone, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  campaignsApi,
  type CampaignListItem,
  type CursorPage,
} from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
  type DataTableFilter,
} from '@/components/ui/data-table';

const STATUS_FILTER_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'committed', label: 'Committed' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];

const STATUS_LABEL: Record<CampaignListItem['status'], string> = {
  draft: 'Draft',
  committed: 'Committed',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
};

function statusBadgeVariant(
  status: CampaignListItem['status'],
): 'muted' | 'ai' | 'green' | 'amber' | 'rose' | 'positive' {
  switch (status) {
    case 'active':
      return 'green';
    case 'committed':
      return 'ai';
    case 'paused':
      return 'amber';
    case 'archived':
      return 'rose';
    case 'completed':
      return 'positive';
    case 'draft':
    default:
      return 'muted';
  }
}

const ACHIEVABILITY_LABEL: Record<
  Exclude<CampaignListItem['achievability'], null>,
  string
> = {
  feasible: 'Feasible',
  stretch: 'Stretch',
  unrealistic: 'Unrealistic',
};

function counselChip(item: CampaignListItem): React.ReactNode {
  if (!item.feasibilityAnalysisKind) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (item.feasibilityAnalysisKind === 'cold_start_counsel') {
    return (
      <Badge variant="muted" className="text-xs">
        Needs data
      </Badge>
    );
  }
  if (item.feasibilityAnalysisKind === 'analyzer_unavailable') {
    return (
      <Badge variant="amber" className="text-xs">
        Retry needed
      </Badge>
    );
  }
  if (!item.achievability) return <span className="text-xs text-muted-foreground">—</span>;
  const variant: 'green' | 'amber' | 'rose' =
    item.achievability === 'feasible'
      ? 'green'
      : item.achievability === 'stretch'
        ? 'amber'
        : 'rose';
  return (
    <Badge variant={variant} className="text-xs">
      {ACHIEVABILITY_LABEL[item.achievability]}
    </Badge>
  );
}

function goalSummary(item: CampaignListItem): string {
  if (item.goalType && item.goalTarget != null) {
    return `${item.goalTarget.toLocaleString()} ${item.goalType}`;
  }
  if (item.goalDescription) {
    return item.goalDescription.length > 50
      ? `${item.goalDescription.slice(0, 47)}…`
      : item.goalDescription;
  }
  return '—';
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function CampaignsPage() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [pages, setPages] = useState<CursorPage<CampaignListItem>[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPages([]);
  }, [searchDebounced, statusFilter]);

  const currentCursor =
    pages.length > 0 ? pages[pages.length - 1]?.nextCursor : null;

  const queryInput = useMemo<Parameters<typeof campaignsApi.list>[0]>(
    () => ({
      limit: 50,
      ...(searchDebounced ? { search: searchDebounced } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(currentCursor ? { cursor: currentCursor } : {}),
    }),
    [searchDebounced, statusFilter, currentCursor],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<CampaignListItem>
  >({
    queryKey: ['campaigns', 'list', queryInput],
    queryFn: () => campaignsApi.list(queryInput),
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

  const items = pages.flatMap((p) => p.items);
  const totalCount = pages[0]?.totalCount ?? data?.totalCount ?? 0;
  const hasMore =
    (pages[pages.length - 1]?.nextCursor ?? data?.nextCursor) != null;

  const filters: DataTableFilter[] = [
    { id: 'status', label: 'Status', options: STATUS_FILTER_OPTIONS },
  ];

  const columns: DataTableColumn<CampaignListItem>[] = [
    {
      id: 'name',
      header: 'Campaign',
      sortable: true,
      sortAccessor: (c) => c.name.toLowerCase(),
      cell: (c) => (
        <div>
          <div className="font-medium">{c.name}</div>
          {c.goalDescription ? (
            <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {c.goalDescription}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (c) => (
        <Badge variant={statusBadgeVariant(c.status)}>
          {STATUS_LABEL[c.status]}
        </Badge>
      ),
    },
    {
      id: 'goal',
      header: 'Goal',
      cell: (c) => (
        <span className="text-sm tabular-nums">{goalSummary(c)}</span>
      ),
    },
    {
      id: 'counsel',
      header: 'AI counsel',
      cell: counselChip,
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      sortable: true,
      sortAccessor: (c) => new Date(c.updatedAt).getTime(),
      cell: (c) => (
        <span className="text-xs text-muted-foreground">
          {relativeTime(c.updatedAt)}
        </span>
      ),
    },
  ];

  // [+ New Campaign] CTA — KAN-1187 enables; navigates to the conversational
  // builder at /campaigns/new (chat substrate that talks operators through the
  // 4 dimensions Product → Objectives → Timeline → Audience).
  const newCampaignCta = (
    <Button
      variant="gradient"
      size="sm"
      onClick={() => router.push('/campaigns/new')}
    >
      <Plus className="h-4 w-4" />
      New Campaign
    </Button>
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <DataTable
        title="Campaigns"
        headerAction={newCampaignCta}
        columns={columns}
        data={items}
        getRowKey={(c) => c.id}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder="Search by name or goal..."
        filters={filters}
        filterValues={{ status: statusFilter }}
        onFilterChange={(id, v) => {
          if (id === 'status') setStatusFilter(v);
        }}
        initialSort={{ id: 'updatedAt', desc: true }}
        hasMore={hasMore}
        onLoadMore={() => void refetch()}
        isFetchingMore={isFetching && pages.length > 0}
        onRowClick={(c) =>
          // KAN-1189 H4 — draft Campaigns resume the conversational builder;
          // non-drafts open the existing /campaigns/[id] chat surface.
          router.push(
            c.status === 'draft'
              ? `/campaigns/new?campaignId=${c.id}`
              : `/campaigns/${c.id}`,
          )
        }
        loading={isLoading}
        error={isError ? (error as Error) : null}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={Megaphone}
            heading="Create your first Campaign"
            body="Tell growth what you want to accomplish."
          />
        }
        totalCount={totalCount}
      />
    </div>
  );
}
