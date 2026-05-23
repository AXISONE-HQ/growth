'use client';

/**
 * KAN-980 Phase B.5 — Customers page refactor to DataTable + cursor.
 *
 * First consumer of the shared <DataTable<T>> primitive. Drops the bespoke
 * table + filter chip + offset-pagination code (~210 LOC of duplication)
 * in favor of the columns-config-driven shape that Phase C will migrate
 * the other 3 list pages onto.
 *
 * Behavior preserved:
 *   - Search debounced 300ms on firstName / lastName / email
 *   - Lifecycle + Source filter chips
 *   - Row click → /customers/[id]
 *   - "+ New contact" header action (KAN-991 D.1 — display label
 *     Customers→Contacts; route /customers stays)
 *   - Empty / loading / error states
 *
 * Behavior changed (KAN-882 convergence):
 *   - Pagination: offset/limit → cursor. "Showing N of T" footer plus
 *     a "Load more" button when nextCursor is set. Pages accumulate
 *     client-side so sort + display see the full loaded set.
 *
 * Sort: client-side via TanStack on the loaded pages. Server-driven sort
 * is a separate ticket (no sort params on contacts.list backend yet).
 */
import { Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { contactsApi, type ContactListItem, type CursorPage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn, type DataTableFilter } from '@/components/ui/data-table';
import {
  CONTACT_SOURCE_LABELS,
  LIFECYCLE_STAGE_LABELS,
} from '@/lib/enum-labels';

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
  // KAN-980 — cursor pages accumulate client-side so sort/filter operate
  // on the full loaded set. Reset on filter/search change (useEffect below).
  const [pages, setPages] = useState<CursorPage<ContactListItem>[]>([]);

  // Debounce search to avoid hammering the backend on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset the accumulated pages when search or filters change.
  useEffect(() => {
    setPages([]);
  }, [searchDebounced, lifecycleFilter, sourceFilter]);

  const currentCursor = pages.length > 0 ? pages[pages.length - 1]?.nextCursor : null;

  const queryInput = useMemo<Parameters<typeof contactsApi.list>[0]>(
    () => ({
      limit: 50,
      ...(searchDebounced ? { search: searchDebounced } : {}),
      ...(lifecycleFilter ? { lifecycleStage: lifecycleFilter } : {}),
      ...(sourceFilter ? { source: sourceFilter } : {}),
      // After first page lands, fetch the next via the most recent cursor.
      ...(currentCursor ? { cursor: currentCursor } : {}),
    }),
    [searchDebounced, lifecycleFilter, sourceFilter, currentCursor],
  );

  const { data, isLoading, isError, error, refetch, isFetching } =
    useQuery<CursorPage<ContactListItem>>({
      queryKey: ['contacts', 'list', queryInput],
      queryFn: () => contactsApi.list(queryInput),
    });

  // Append fresh pages as they arrive. The useQuery cache keys on queryInput
  // so resetting pages + changing inputs triggers a re-fetch; we then
  // hydrate `pages` from `data`.
  useEffect(() => {
    if (!data) return;
    setPages((prev) => {
      // Reset case: first fetch after filter/search change.
      if (prev.length === 0) return [data];
      // Avoid duplicate appends on re-render.
      const last = prev[prev.length - 1];
      if (last && last.nextCursor === data.nextCursor) return prev;
      return [...prev, data];
    });
  }, [data]);

  // Flatten accumulated pages.
  const items = pages.flatMap((p) => p.items);
  const totalCount = pages[0]?.totalCount ?? data?.totalCount ?? 0;
  const hasMore = (pages[pages.length - 1]?.nextCursor ?? data?.nextCursor) != null;

  const filters: DataTableFilter[] = [
    { id: 'lifecycle', label: 'Lifecycle', options: LIFECYCLE_FILTER_OPTIONS },
    { id: 'source', label: 'Source', options: SOURCE_FILTER_OPTIONS },
  ];

  const columns: DataTableColumn<ContactListItem>[] = [
    {
      id: 'contact',
      header: 'Contact',
      sortable: true,
      sortAccessor: (c) => displayName(c).toLowerCase(),
      cell: (c) => (
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-violet-100)] text-xs font-semibold text-[var(--ds-violet-500)]">
            {avatarFor(c)}
          </div>
          <span className="font-medium">{displayName(c)}</span>
        </div>
      ),
    },
    {
      id: 'email',
      header: 'Email',
      cell: (c) =>
        c.email ? (
          <a
            href={`mailto:${c.email}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[var(--ds-violet-500)] hover:underline"
          >
            {c.email}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'phone',
      header: 'Phone',
      cell: (c) =>
        c.phone ? (
          <span className="text-xs text-muted-foreground">{c.phone}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'company',
      header: 'Company',
      cell: (c) =>
        c.company ? (
          <Link
            href={`/companies/${c.company.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[var(--ds-violet-500)] hover:underline"
          >
            {c.company.name}
          </Link>
        ) : c.companyName ? (
          <span>{c.companyName}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'lifecycle',
      header: 'Lifecycle',
      cell: (c) => <StatusBadge kind="contact-lifecycle" value={c.lifecycleStage} />,
    },
    {
      id: 'source',
      header: 'Source',
      cell: (c) =>
        c.source ? (
          <span className="inline-flex items-center rounded-[var(--ds-radius-pill)] bg-[var(--ds-surface-sunken)] px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {CONTACT_SOURCE_LABELS[c.source] ?? c.source}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'createdAt',
      header: 'Created',
      sortable: true,
      sortAccessor: (c) => new Date(c.createdAt).getTime(),
      cell: (c) => (
        <span className="text-xs text-muted-foreground">{relativeTime(c.createdAt)}</span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <DataTable
        title="Contacts"
        headerAction={
          <Button asChild variant="gradient" size="sm">
            <Link href="/customers/new">
              <Plus className="h-4 w-4" />
              New contact
            </Link>
          </Button>
        }
        columns={columns}
        data={items}
        getRowKey={(c) => c.id}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder="Search by name or email..."
        filters={filters}
        filterValues={{ lifecycle: lifecycleFilter, source: sourceFilter }}
        onFilterChange={(id, v) => {
          if (id === 'lifecycle') setLifecycleFilter(v);
          if (id === 'source') setSourceFilter(v);
        }}
        initialSort={{ id: 'createdAt', desc: true }}
        hasMore={hasMore}
        onLoadMore={() => void refetch()}
        isFetchingMore={isFetching && pages.length > 0}
        onRowClick={(c) => router.push(`/customers/${c.id}`)}
        loading={isLoading}
        error={isError ? (error as Error) : null}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState
            icon={Users}
            heading="No contacts yet"
            body="Contacts will appear here as they come in via email inbox, forms, or ingestion."
          />
        }
        totalCount={totalCount}
      />
    </div>
  );
}
