'use client';

/**
 * KAN-884 — /companies list page (read-only).
 *
 * Mirrors the /customers Tailwind pattern. Cursor pagination via Load More
 * (button-based, NOT infinite scroll — V1 keeps it explicit). TanStack
 * Query handles loading / error / refetch on filter change.
 *
 * Companies + Orders are zero-row in PROD today (no ingestion yet). Empty
 * state is the dominant initial render; tested explicitly.
 */

import { Building2, Loader2, Plus, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { companiesApi, type CompanyListItem, type CursorPage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
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
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<string | null>(null);
  const [accumulatedItems, setAccumulatedItems] = useState<CompanyListItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  // Debounce search to avoid hammering the backend on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset accumulated items + cursor whenever filters change. Without this,
  // changing the lifecycle chip would APPEND filtered results to a list
  // that may include stale unfiltered rows.
  useEffect(() => {
    setAccumulatedItems([]);
    setCursor(undefined);
  }, [searchDebounced, lifecycleFilter]);

  const queryInput: Parameters<typeof companiesApi.list>[0] = {
    limit: 50,
    ...(searchDebounced ? { search: searchDebounced } : {}),
    ...(lifecycleFilter ? { lifecycleStage: lifecycleFilter } : {}),
    ...(cursor ? { cursor } : {}),
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<CompanyListItem>
  >({
    queryKey: ['companies', 'list', queryInput],
    queryFn: () => companiesApi.list(queryInput),
    // Append new pages to the accumulator on success.
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
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <Building2 className="w-6 h-6 text-gray-500" />
              Companies
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Organizations the AI tracks for deals, contacts, and orders.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* KAN-937 — Sub-cohort 3.2 "+ New Company" entry point */}
            <Link
              href="/companies/new"
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border"
              style={{
                backgroundColor: 'var(--ds-violet-600)',
                borderColor: 'var(--ds-violet-600)',
                color: '#fff',
              }}
            >
              <Plus className="w-4 h-4" />
              New company
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

        {/* Search */}
        <div className="mb-4 relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name or domain..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        {/* Lifecycle filter chips */}
        <div className="mb-6 flex flex-wrap gap-2">
          {LIFECYCLE_FILTER_OPTIONS.map((opt) => {
            const active = lifecycleFilter === opt.value;
            return (
              <button
                key={opt.value ?? 'all'}
                onClick={() => setLifecycleFilter(opt.value)}
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
            <p className="font-medium text-red-800">Failed to load companies</p>
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
            icon={Building2}
            heading="No companies yet"
            body="Companies will appear here once your tenant data is loaded. The ingestion layer (coming soon) will create company records automatically from imported files."
          />
        ) : (
          <>
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Lifecycle</th>
                    <th className="px-4 py-3 text-right">Contacts</th>
                    <th className="px-4 py-3 text-right">Deals</th>
                    <th className="px-4 py-3 text-right">Orders</th>
                    <th className="px-4 py-3">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {accumulatedItems.map((c) => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link href={`/companies/${c.id}`} className="block">
                          <div className="font-medium text-gray-900">{c.name}</div>
                          {c.domain ? (
                            <div className="text-xs text-gray-500 mt-0.5">{c.domain}</div>
                          ) : null}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge kind="company-lifecycle" value={c.lifecycleStage} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">{c._count.contacts}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">{c._count.deals}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">{c._count.orders}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{relativeTime(c.updatedAt)}</td>
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
          <div className="h-4 w-40 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-20 bg-gray-200 rounded-full animate-pulse" />
          <div className="h-4 w-12 bg-gray-200 rounded animate-pulse ml-auto" />
          <div className="h-4 w-12 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-12 bg-gray-200 rounded animate-pulse" />
          <div className="h-3 w-16 bg-gray-200 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}
