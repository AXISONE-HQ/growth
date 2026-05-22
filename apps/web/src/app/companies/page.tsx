'use client';

/**
 * KAN-884 — /companies list page (read-only).
 * KAN-988 Phase C.4 — refactored to consume shared <DataTable<T>> from
 * KAN-980 (proven on Customers). ~130 LOC of duplication dropped vs the
 * pre-C.4 bespoke implementation. Behavior preserved: search debounced
 * 300ms, lifecycle chip filter, cursor pagination via Load More, row →
 * /companies/[id] navigation.
 */

import { Building2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { companiesApi, type CompanyListItem, type CursorPage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn, type DataTableFilter } from '@/components/ui/data-table';
import { COMPANY_LIFECYCLE_STAGE_LABELS } from '@/lib/enum-labels';

const LIFECYCLE_FILTER_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  ...Object.entries(COMPANY_LIFECYCLE_STAGE_LABELS).map(([value, label]) => ({ value, label })),
];

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

export default function CompaniesPage() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<string | null>(null);
  const [pages, setPages] = useState<CursorPage<CompanyListItem>[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPages([]);
  }, [searchDebounced, lifecycleFilter]);

  const currentCursor = pages.length > 0 ? pages[pages.length - 1]?.nextCursor : null;

  const queryInput = useMemo<Parameters<typeof companiesApi.list>[0]>(
    () => ({
      limit: 50,
      ...(searchDebounced ? { search: searchDebounced } : {}),
      ...(lifecycleFilter ? { lifecycleStage: lifecycleFilter } : {}),
      ...(currentCursor ? { cursor: currentCursor } : {}),
    }),
    [searchDebounced, lifecycleFilter, currentCursor],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<CompanyListItem>
  >({
    queryKey: ['companies', 'list', queryInput],
    queryFn: () => companiesApi.list(queryInput),
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
    { id: 'lifecycle', label: 'Lifecycle', options: LIFECYCLE_FILTER_OPTIONS },
  ];

  const columns: DataTableColumn<CompanyListItem>[] = [
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      sortAccessor: (c) => c.name.toLowerCase(),
      cell: (c) => (
        <div>
          <div className="font-medium">{c.name}</div>
          {c.domain ? (
            <div className="mt-0.5 text-xs text-muted-foreground">{c.domain}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'lifecycle',
      header: 'Lifecycle',
      cell: (c) => <StatusBadge kind="company-lifecycle" value={c.lifecycleStage} />,
    },
    {
      id: 'contacts',
      header: 'Contacts',
      sortable: true,
      sortAccessor: (c) => c._count.contacts,
      cellClassName: 'text-right tabular-nums',
      headerClassName: 'text-right',
      cell: (c) => c._count.contacts,
    },
    {
      id: 'deals',
      header: 'Deals',
      sortable: true,
      sortAccessor: (c) => c._count.deals,
      cellClassName: 'text-right tabular-nums',
      headerClassName: 'text-right',
      cell: (c) => c._count.deals,
    },
    {
      id: 'orders',
      header: 'Orders',
      sortable: true,
      sortAccessor: (c) => c._count.orders,
      cellClassName: 'text-right tabular-nums',
      headerClassName: 'text-right',
      cell: (c) => c._count.orders,
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      sortable: true,
      sortAccessor: (c) => new Date(c.updatedAt).getTime(),
      cell: (c) => <span className="text-xs text-muted-foreground">{relativeTime(c.updatedAt)}</span>,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <DataTable
        title="Companies"
        headerAction={
          <Button asChild variant="gradient" size="sm">
            <Link href="/companies/new">
              <Plus className="h-4 w-4" />
              New company
            </Link>
          </Button>
        }
        columns={columns}
        data={items}
        getRowKey={(c) => c.id}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder="Search by name or domain..."
        filters={filters}
        filterValues={{ lifecycle: lifecycleFilter }}
        onFilterChange={(id, v) => {
          if (id === 'lifecycle') setLifecycleFilter(v);
        }}
        initialSort={{ id: 'updatedAt', desc: true }}
        hasMore={hasMore}
        onLoadMore={() => void refetch()}
        isFetchingMore={isFetching && pages.length > 0}
        onRowClick={(c) => router.push(`/companies/${c.id}`)}
        loading={isLoading}
        error={isError ? (error as Error) : null}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={Building2}
            heading="No companies yet"
            body="Companies will appear here once your tenant data is loaded. The ingestion layer (coming soon) will create company records automatically from imported files."
          />
        }
        totalCount={totalCount}
      />
    </div>
  );
}
