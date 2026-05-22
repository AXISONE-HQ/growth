'use client';

/**
 * KAN-884 — /orders list page (read-only).
 * KAN-988 Phase C.4 — refactored to consume shared <DataTable<T>> from
 * KAN-980. Behavior preserved: search debounced 300ms, status chip
 * filter, cursor pagination, row → /orders/[id].
 */

import { Plus, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ordersApi, type OrderListItem, type CursorPage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn, type DataTableFilter } from '@/components/ui/data-table';
import { ORDER_STATUS_LABELS } from '@/lib/enum-labels';

const STATUS_FILTER_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  ...Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label })),
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

function contactName(c: OrderListItem['contact']): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown';
}

export default function OrdersPage() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [pages, setPages] = useState<CursorPage<OrderListItem>[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPages([]);
  }, [searchDebounced, statusFilter]);

  const currentCursor = pages.length > 0 ? pages[pages.length - 1]?.nextCursor : null;

  const queryInput = useMemo<Parameters<typeof ordersApi.list>[0]>(
    () => ({
      limit: 50,
      ...(searchDebounced ? { search: searchDebounced } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(currentCursor ? { cursor: currentCursor } : {}),
    }),
    [searchDebounced, statusFilter, currentCursor],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<OrderListItem>
  >({
    queryKey: ['orders', 'list', queryInput],
    queryFn: () => ordersApi.list(queryInput),
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

  const columns: DataTableColumn<OrderListItem>[] = [
    {
      id: 'orderNumber',
      header: 'Order #',
      sortable: true,
      sortAccessor: (o) => o.orderNumber,
      cell: (o) => <span className="font-medium">{o.orderNumber}</span>,
    },
    {
      id: 'contact',
      header: 'Contact',
      cell: (o) => <span>{contactName(o.contact)}</span>,
    },
    {
      id: 'company',
      header: 'Company',
      cell: (o) =>
        o.company ? (
          <Link
            href={`/companies/${o.company.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[var(--ds-violet-500)] hover:underline"
          >
            {o.company.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (o) => <StatusBadge kind="order-status" value={o.status} />,
    },
    {
      id: 'grandTotal',
      header: 'Total',
      sortable: true,
      sortAccessor: (o) => Number(o.grandTotal),
      cellClassName: 'text-right tabular-nums',
      headerClassName: 'text-right',
      cell: (o) => <MoneyDisplay value={o.grandTotal} currency={o.currency} />,
    },
    {
      id: 'placedAt',
      header: 'Placed',
      sortable: true,
      sortAccessor: (o) => new Date(o.placedAt).getTime(),
      cell: (o) => <span className="text-xs text-muted-foreground">{relativeTime(o.placedAt)}</span>,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <DataTable
        title="Orders"
        headerAction={
          <Button asChild variant="gradient" size="sm">
            <Link href="/orders/new">
              <Plus className="h-4 w-4" />
              New order
            </Link>
          </Button>
        }
        columns={columns}
        data={items}
        getRowKey={(o) => o.id}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder="Search by order number..."
        filters={filters}
        filterValues={{ status: statusFilter }}
        onFilterChange={(id, v) => {
          if (id === 'status') setStatusFilter(v);
        }}
        initialSort={{ id: 'placedAt', desc: true }}
        hasMore={hasMore}
        onLoadMore={() => void refetch()}
        isFetchingMore={isFetching && pages.length > 0}
        onRowClick={(o) => router.push(`/orders/${o.id}`)}
        loading={isLoading}
        error={isError ? (error as Error) : null}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={Receipt}
            heading="No orders yet"
            body="Orders will appear here when conversions happen. The ingestion layer or payment-provider webhooks (coming soon) will create order records."
          />
        }
        totalCount={totalCount}
      />
    </div>
  );
}
