'use client';

/**
 * KAN-886 — All Deals tab view.
 * KAN-988 Phase C.4 — refactored to consume shared <DataTable<T>> from
 * KAN-980. Behavior preserved: status filter chips (All/Open/Won/Lost),
 * search by deal name, cursor pagination, row → /opportunities/[id].
 * Company link inside the row stopPropagation so it doesn't trigger row
 * nav.
 */

import { Plus, Target } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dealsApi, type DealListItem, type CursorPage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn, type DataTableFilter } from '@/components/ui/data-table';
import { DEAL_STATUS_LABELS } from '@/lib/enum-labels';

const STATUS_FILTER_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  ...Object.entries(DEAL_STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

function contactName(c: DealListItem['contact']): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown';
}

// KAN-cohort-3.5 — TZ off-by-one fix carried over from KAN-943 (detail
// pages were patched; this list view rendered yyyy-mm-dd values in the
// caller's locale TZ, which shifted "2026-09-30T00:00:00Z" to 9/29 in
// America/Toronto). UTC anchoring keeps list + detail in sync.
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { timeZone: 'UTC' });
}

export function AllDealsView() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [pages, setPages] = useState<CursorPage<DealListItem>[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPages([]);
  }, [searchDebounced, statusFilter]);

  const currentCursor = pages.length > 0 ? pages[pages.length - 1]?.nextCursor : null;

  const queryInput = useMemo<Parameters<typeof dealsApi.list>[0]>(
    () => ({
      limit: 50,
      ...(searchDebounced ? { search: searchDebounced } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(currentCursor ? { cursor: currentCursor } : {}),
    }),
    [searchDebounced, statusFilter, currentCursor],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<DealListItem>
  >({
    queryKey: ['deals', 'list', queryInput],
    queryFn: () => dealsApi.list(queryInput),
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
  const hasMore = (pages[pages.length - 1]?.nextCursor ?? data?.nextCursor) != null;

  const filters: DataTableFilter[] = [
    { id: 'status', label: 'Status', options: STATUS_FILTER_OPTIONS },
  ];

  const columns: DataTableColumn<DealListItem>[] = [
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      sortAccessor: (d) => d.name.toLowerCase(),
      cell: (d) => <span className="font-medium">{d.name}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (d) => <StatusBadge kind="deal-status" value={d.status} />,
    },
    {
      id: 'value',
      header: 'Value',
      sortable: true,
      sortAccessor: (d) => Number(d.value),
      cellClassName: 'text-right tabular-nums',
      headerClassName: 'text-right',
      cell: (d) => <MoneyDisplay value={d.value} currency={d.currency} />,
    },
    {
      id: 'contact',
      header: 'Contact',
      cell: (d) => <span>{contactName(d.contact)}</span>,
    },
    {
      id: 'company',
      header: 'Company',
      cell: (d) =>
        d.company ? (
          <Link
            href={`/companies/${d.company.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[var(--ds-violet-500)] hover:underline"
          >
            {d.company.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'expectedCloseDate',
      header: 'Expected close',
      sortable: true,
      sortAccessor: (d) => (d.expectedCloseDate ? new Date(d.expectedCloseDate).getTime() : 0),
      cell: (d) => <span className="text-xs text-muted-foreground">{fmtDate(d.expectedCloseDate)}</span>,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <DataTable
        title="All deals"
        headerAction={
          <Button asChild variant="gradient" size="sm">
            <Link href="/opportunities/new">
              <Plus className="h-4 w-4" />
              New deal
            </Link>
          </Button>
        }
        columns={columns}
        data={items}
        getRowKey={(d) => d.id}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder="Search by deal name..."
        filters={filters}
        filterValues={{ status: statusFilter }}
        onFilterChange={(id, v) => {
          if (id === 'status') setStatusFilter(v);
        }}
        initialSort={{ id: 'name', desc: false }}
        hasMore={hasMore}
        onLoadMore={() => void refetch()}
        isFetchingMore={isFetching && pages.length > 0}
        onRowClick={(d) => router.push(`/opportunities/${d.id}`)}
        loading={isLoading}
        error={isError ? (error as Error) : null}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={Target}
            heading="No deals yet"
            body="Deals will appear here as the AI works your pipeline."
          />
        }
        totalCount={totalCount}
      />
    </div>
  );
}
