'use client';

/**
 * KAN-886 — /customers DS v1 redesign (Cohort 1 PR 3 of 3).
 *
 * Replaces the KAN-718 card-grid layout with a 7-column sortable table.
 * Migrates from useState+useEffect to TanStack Query useQuery (matches
 * KAN-884 pattern). Drops the inline LIFECYCLE_COLORS map in favor of
 * the shared StatusBadge primitive (KAN-884) + enum-labels source.
 *
 * Consumes the extended `contactsApi.list` shape from KAN-883/884:
 * `companyId`, `companyName`, `company` relation, address fields. The
 * Company column links into /companies/[id] when companyId is populated.
 *
 * Row click navigates to /customers/[id] (KAN-887). mailto + company
 * link inside the row stopPropagation so cell-level interactions don't
 * trigger the row nav.
 *
 * Pagination stays on offset/limit — convergence to cursor is KAN-882.
 */

import { Loader2, Plus, RefreshCw, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { contactsApi, type ContactListItem } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  CONTACT_SOURCE_LABELS,
  LIFECYCLE_STAGE_LABELS,
} from '@/lib/enum-labels';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;

const LIFECYCLE_FILTER_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  ...Object.entries(LIFECYCLE_STAGE_LABELS).map(([value, label]) => ({ value, label })),
];

const SOURCE_FILTER_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  ...Object.entries(CONTACT_SOURCE_LABELS).map(([value, label]) => ({ value, label })),
];

function displayName(c: ContactListItem): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown contact';
}

function avatarFor(c: ContactListItem): string {
  const f = (c.firstName ?? '').charAt(0);
  const l = (c.lastName ?? '').charAt(0);
  const initials = (f + l).toUpperCase();
  if (initials) return initials;
  if (c.email) return c.email.charAt(0).toUpperCase();
  return '??';
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

export default function CustomersPage() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  // Debounce search to avoid hammering the backend on every keystroke.
  // Phone is intentionally not in the OR clause server-side (KAN-889
  // follow-up filed); placeholder reflects that.
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const queryInput: Parameters<typeof contactsApi.list>[0] = {
    limit: 50,
    ...(searchDebounced ? { search: searchDebounced } : {}),
    ...(lifecycleFilter ? { lifecycleStage: lifecycleFilter } : {}),
    ...(sourceFilter ? { source: sourceFilter } : {}),
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<{
    items: ContactListItem[];
    total: number;
    limit: number;
    offset: number;
  }>({
    queryKey: ['contacts', 'list', queryInput],
    queryFn: () => contactsApi.list(queryInput),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" style={SECTION_HEADER_STYLE}>
            <Users className="w-6 h-6 text-gray-500" />
            Customers
          </h1>
          <p className="text-sm mt-1" style={MUTED_STYLE}>
            Contacts the AI is working with — leads, qualified prospects, customers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* KAN-934 — Cohort 3.1 "+ New Customer" entry point */}
          <Link
            href="/customers/new"
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border"
            style={{
              backgroundColor: 'var(--ds-violet-600)',
              borderColor: 'var(--ds-violet-600)',
              color: '#fff',
            }}
          >
            <Plus className="w-4 h-4" />
            New customer
          </Link>
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border disabled:opacity-50"
            style={{
              backgroundColor: 'var(--ds-surface-default)',
              borderColor: 'var(--ds-border-default)',
              color: 'var(--ds-ink-secondary)',
            }}
          >
            {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="mb-4 relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={MUTED_STYLE} />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name or email..."
          className="w-full pl-9 pr-3 py-2 text-sm rounded-md border focus:outline-none focus:ring-2 focus:ring-indigo-500"
          style={{
            backgroundColor: 'var(--ds-surface-default)',
            borderColor: 'var(--ds-border-default)',
            color: 'var(--ds-ink-primary)',
          }}
        />
      </div>

      {/* Lifecycle chips */}
      <div className="mb-3">
        <div className="text-xs uppercase tracking-wide mb-2" style={MUTED_STYLE}>
          Filter by lifecycle
        </div>
        <div className="flex flex-wrap gap-2">
          {LIFECYCLE_FILTER_OPTIONS.map((opt) => {
            const active = lifecycleFilter === opt.value;
            return (
              <button
                key={`lifecycle-${opt.value ?? 'all'}`}
                onClick={() => setLifecycleFilter(opt.value)}
                aria-label={`Lifecycle: ${opt.label}`}
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
      </div>

      {/* Source chips */}
      <div className="mb-6">
        <div className="text-xs uppercase tracking-wide mb-2" style={MUTED_STYLE}>
          Filter by source
        </div>
        <div className="flex flex-wrap gap-2">
          {SOURCE_FILTER_OPTIONS.map((opt) => {
            const active = sourceFilter === opt.value;
            return (
              <button
                key={`source-${opt.value ?? 'all'}`}
                onClick={() => setSourceFilter(opt.value)}
                aria-label={`Source: ${opt.label}`}
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
      </div>

      {/* States */}
      {isError ? (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-sm">
          <p className="font-medium text-red-800">Failed to load contacts</p>
          <p className="text-red-700 mt-1">{(error as Error)?.message ?? 'Unknown error'}</p>
          <button onClick={() => void refetch()} className="mt-2 text-red-700 underline text-xs">
            Retry
          </button>
        </div>
      ) : isLoading ? (
        <SkeletonTable />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Users}
          heading="No contacts yet"
          body="Contacts will appear here as they come in via email inbox, forms, or ingestion."
        />
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-xs font-medium uppercase tracking-wider" style={MUTED_STYLE}>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Lifecycle</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {items.map((c) => (
                  <tr
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => router.push(`/customers/${c.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') router.push(`/customers/${c.id}`);
                    }}
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    {/* Contact (initials + name) */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-700 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                          {avatarFor(c)}
                        </div>
                        <span className="font-medium text-gray-900">{displayName(c)}</span>
                      </div>
                    </td>
                    {/* Email */}
                    <td className="px-4 py-3 text-gray-700">
                      {c.email ? (
                        <a
                          href={`mailto:${c.email}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-indigo-600 hover:underline"
                        >
                          {c.email}
                        </a>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    {/* Phone */}
                    <td className="px-4 py-3 text-xs" style={MUTED_STYLE}>
                      {c.phone || '—'}
                    </td>
                    {/* Company */}
                    <td className="px-4 py-3">
                      {c.company ? (
                        <Link
                          href={`/companies/${c.company.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-indigo-600 hover:underline"
                        >
                          {c.company.name}
                        </Link>
                      ) : c.companyName ? (
                        <span className="text-gray-700">{c.companyName}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    {/* Lifecycle */}
                    <td className="px-4 py-3">
                      <StatusBadge kind="contact-lifecycle" value={c.lifecycleStage} />
                    </td>
                    {/* Source */}
                    <td className="px-4 py-3">
                      {c.source ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                          {CONTACT_SOURCE_LABELS[c.source] ?? c.source}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    {/* Created */}
                    <td className="px-4 py-3 text-xs" style={MUTED_STYLE}>
                      {relativeTime(c.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4">
            <p className="text-xs" style={MUTED_STYLE}>
              Showing {items.length} of {total}
            </p>
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
          <div className="w-8 h-8 bg-gray-200 rounded-full animate-pulse" />
          <div className="h-4 w-40 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
          <div className="h-4 w-20 bg-gray-100 rounded animate-pulse" />
          <div className="h-4 w-16 bg-gray-200 rounded-full animate-pulse ml-auto" />
          <div className="h-4 w-16 bg-gray-200 rounded animate-pulse" />
          <div className="h-3 w-16 bg-gray-200 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}
