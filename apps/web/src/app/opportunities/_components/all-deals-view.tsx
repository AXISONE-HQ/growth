'use client';

/**
 * KAN-886 — All Deals tab view.
 *
 * Flat enumeration of every Deal row from the canonical KAN-879 schema,
 * surfacing the KAN-883 `deals.list` tRPC route. Distinct from AI Segments
 * (which groups Contacts by signal pattern): this is "the rows in the
 * deals table, paginated."
 *
 * 6-column read-only table. Cursor-paginated via Load More button.
 * Status filter chips (All/Open/Won/Lost). Search by deal name.
 * Row click is intentionally a no-op for V1 — Deal detail page deferred
 * (KAN-888 / Cohort 1 follow-up).
 */

import { Loader2, RefreshCw, Search, Target } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dealsApi, type DealListItem, type CursorPage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { DEAL_STATUS_LABELS } from '@/lib/enum-labels';

const STATUS_FILTER_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  ...Object.entries(DEAL_STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

function contactName(c: DealListItem['contact']): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function AllDealsView() {
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [accumulatedItems, setAccumulatedItems] = useState<DealListItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Filter change resets accumulator + cursor — otherwise stale rows
  // leak into the new filter's result list.
  useEffect(() => {
    setAccumulatedItems([]);
    setCursor(undefined);
  }, [searchDebounced, statusFilter]);

  const queryInput: Parameters<typeof dealsApi.list>[0] = {
    limit: 50,
    ...(searchDebounced ? { search: searchDebounced } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(cursor ? { cursor } : {}),
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<DealListItem>
  >({
    queryKey: ['deals', 'list', queryInput],
    queryFn: () => dealsApi.list(queryInput),
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
    <div className="max-w-6xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Target className="w-5 h-5 text-gray-500" />
            All deals
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Every Deal in the pipeline. Filter by status, search by name.
          </p>
        </div>
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

      {/* Search */}
      <div className="mb-3 relative max-w-md">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by deal name..."
          className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>

      {/* Status chips */}
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

      {/* States */}
      {isError ? (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-sm">
          <p className="font-medium text-red-800">Failed to load deals</p>
          <p className="text-red-700 mt-1">{(error as Error)?.message ?? 'Unknown error'}</p>
          <button onClick={() => void refetch()} className="mt-2 text-red-700 underline text-xs">
            Retry
          </button>
        </div>
      ) : isInitialLoad ? (
        <SkeletonTable />
      ) : accumulatedItems.length === 0 ? (
        <EmptyState
          icon={Target}
          heading="No deals yet"
          body="Deals will appear here as the AI works your pipeline."
        />
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Value</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Expected close</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {accumulatedItems.map((d) => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{d.name}</td>
                    <td className="px-4 py-3">
                      <StatusBadge kind="deal-status" value={d.status} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      <MoneyDisplay value={d.value} currency={d.currency} />
                    </td>
                    <td className="px-4 py-3 text-gray-700">{contactName(d.contact)}</td>
                    <td className="px-4 py-3 text-gray-700">
                      {d.company ? (
                        <Link href={`/companies/${d.company.id}`} className="text-indigo-600 hover:underline">
                          {d.company.name}
                        </Link>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(d.expectedCloseDate)}</td>
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
  );
}

function SkeletonTable() {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="px-4 py-4 border-b border-gray-100 last:border-b-0 flex items-center gap-4">
          <div className="h-4 w-40 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-16 bg-gray-200 rounded-full animate-pulse" />
          <div className="h-4 w-16 bg-gray-200 rounded animate-pulse ml-auto" />
          <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
          <div className="h-4 w-24 bg-gray-100 rounded animate-pulse" />
          <div className="h-3 w-20 bg-gray-200 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}
