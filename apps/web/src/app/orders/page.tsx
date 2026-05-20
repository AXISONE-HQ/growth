'use client';

/**
 * KAN-884 — /orders list page (read-only).
 *
 * Mirrors /companies list pattern (Tailwind, cursor pagination via Load
 * More button, TanStack Query). Sort is `placedAt DESC` server-side —
 * cursor encodes placedAt rather than createdAt (handled by the shared
 * _pagination helper from KAN-883).
 */

import { Loader2, Plus, Receipt, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ordersApi, type OrderListItem, type CursorPage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
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
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [accumulatedItems, setAccumulatedItems] = useState<OrderListItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setAccumulatedItems([]);
    setCursor(undefined);
  }, [searchDebounced, statusFilter]);

  const queryInput: Parameters<typeof ordersApi.list>[0] = {
    limit: 50,
    ...(searchDebounced ? { search: searchDebounced } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(cursor ? { cursor } : {}),
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<OrderListItem>
  >({
    queryKey: ['orders', 'list', queryInput],
    queryFn: () => ordersApi.list(queryInput),
    onSuccess: (page) => {
      setAccumulatedItems((prev) =>
        cursor ? [...prev, ...page.items] : page.items,
      );
    },
  });

  const totalCount = data?.totalCount ?? 0;
  const nextCursor = data?.nextCursor ?? null;
  const isInitialLoad = isLoading && accumulatedItems.length === 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <Receipt className="w-6 h-6 text-gray-500" />
              Orders
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Transactional outcomes — payments, refunds, fulfillment status.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* KAN-945 — Sub-cohort 3.4 "+ New Order" entry point */}
            <Link
              href="/orders/new"
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border"
              style={{
                backgroundColor: 'var(--ds-violet-600)',
                borderColor: 'var(--ds-violet-600)',
                color: '#fff',
              }}
            >
              <Plus className="w-4 h-4" />
              New order
            </Link>
            <button
              onClick={() => {
                setAccumulatedItems([]);
                setCursor(undefined);
                void refetch();
              }}
              disabled={isFetching}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </button>
          </div>
        </div>

        <div className="mb-4 relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by order number..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div className="mb-6 flex flex-wrap gap-2">
          {STATUS_FILTER_OPTIONS.map((opt) => {
            const active = statusFilter === opt.value;
            return (
              <button
                key={opt.value ?? 'all'}
                onClick={() => setStatusFilter(opt.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {isError ? (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 text-sm">
            <p className="font-medium text-red-800">Failed to load orders</p>
            <p className="text-red-700 mt-1">{(error as Error)?.message ?? 'Unknown error'}</p>
            <button
              onClick={() => void refetch()}
              className="mt-2 text-red-700 underline text-xs"
            >
              Retry
            </button>
          </div>
        ) : isInitialLoad ? (
          <SkeletonTable />
        ) : accumulatedItems.length === 0 ? (
          <EmptyState
            icon={Receipt}
            heading="No orders yet"
            body="Orders will appear here when conversions happen. The ingestion layer or payment-provider webhooks (coming soon) will create order records."
          />
        ) : (
          <>
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3">Order #</th>
                    <th className="px-4 py-3">Contact</th>
                    <th className="px-4 py-3">Company</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3">Placed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {accumulatedItems.map((o) => (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link href={`/orders/${o.id}`} className="font-medium text-gray-900 hover:text-indigo-700">
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{contactName(o.contact)}</td>
                      <td className="px-4 py-3 text-gray-700">
                        {o.company ? (
                          <Link href={`/companies/${o.company.id}`} className="text-indigo-600 hover:underline">
                            {o.company.name}
                          </Link>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge kind="order-status" value={o.status} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                        <MoneyDisplay value={o.grandTotal} currency={o.currency} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{relativeTime(o.placedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-gray-500">
                Showing {accumulatedItems.length} of {totalCount}
              </p>
              {nextCursor ? (
                <button
                  onClick={() => setCursor(nextCursor)}
                  disabled={isFetching}
                  className="px-4 py-2 text-sm font-medium text-indigo-700 bg-white border border-indigo-200 rounded-md hover:bg-indigo-50 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Load more
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="px-4 py-4 border-b border-gray-100 last:border-b-0 flex items-center gap-4">
          <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
          <div className="h-4 w-24 bg-gray-100 rounded animate-pulse" />
          <div className="h-4 w-16 bg-gray-200 rounded-full animate-pulse" />
          <div className="h-4 w-16 bg-gray-200 rounded animate-pulse ml-auto" />
          <div className="h-3 w-16 bg-gray-200 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}
