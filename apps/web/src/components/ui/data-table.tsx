/**
 * KAN-980 Phase B.5 — DataTable<T>.
 *
 * Shared list-page primitive for the 4 entity lists (Customers/Contacts,
 * Companies, Leads/Opportunities, Orders). Wraps TanStack Table headless
 * (@tanstack/react-table) for column-config + sort rendering; everything
 * else (search input, filter chips, cursor pagination, empty/loading/error
 * states) is styled with Phase A+B.1 tokens.
 *
 * Sort posture (intentional):
 *   - Client-side via TanStack's getSortedRowModel. Sorts the currently-
 *     loaded page set (which grows via Load More). Server-driven sort would
 *     require adding sort params to each backend endpoint — separate ticket.
 *
 * Filter / search / pagination posture:
 *   - Server-driven. Parent owns useState for searchValue + filterValues +
 *     cursor; DataTable just wires the UI controls to the parent's handlers.
 *
 * Tenant isolation:
 *   - DataTable is a pure client primitive. It consumes whatever the parent's
 *     useQuery returns. Tenant-scoping lives at the backend trpc procedure
 *     layer (every entity router's `list` includes `where: { tenantId, ... }`).
 *     This component never touches Prisma or raw SQL.
 *
 * Phase C consumers: /opportunities, /companies, /orders migrate to this
 * in subsequent PRs.
 */
"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DataTableColumn<T> {
  /** Unique column id; also the default `sortKey`. */
  id: string;
  /** Header label shown in the table head. */
  header: string;
  /** Cell renderer — receives the row, returns React. */
  cell: (row: T) => React.ReactNode;
  /** Client-side sort enabled for this column. */
  sortable?: boolean;
  /** Accessor for sort comparison; defaults to `cell(row)` casted to string. */
  sortAccessor?: (row: T) => string | number | Date | null | undefined;
  /** Optional class on the <td> for width/alignment tweaks. */
  cellClassName?: string;
  /** Optional class on the <th>. */
  headerClassName?: string;
}

export interface DataTableFilter {
  id: string;
  label: string;
  options: Array<{ value: string | null; label: string }>;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  /** Unique key per row (id or composite). */
  getRowKey: (row: T) => string;
  /** Controlled search input. Empty string means no search. */
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  /** Optional filter-chip groups. Selected value is null for "All". */
  filters?: DataTableFilter[];
  filterValues?: Record<string, string | null>;
  onFilterChange?: (filterId: string, value: string | null) => void;
  /** Initial sort. Subsequent changes are tracked internally. */
  initialSort?: { id: string; desc?: boolean };
  /** Cursor-pagination signals. */
  hasMore: boolean;
  onLoadMore: () => void;
  isFetchingMore?: boolean;
  /** Row click handler — fires only on row cells, not on links/buttons inside cells. */
  onRowClick?: (row: T) => void;
  /** Loading state — DataTable renders the skeleton. */
  loading?: boolean;
  /** Error state — DataTable renders the error block + retry. */
  error?: Error | null;
  onRetry?: () => void;
  /** Empty state — DataTable renders whatever you pass when data is []. */
  emptyState?: React.ReactNode;
  /** Header CTA slot (typically "+ New <entity>"). */
  headerAction?: React.ReactNode;
  /** Title rendered above the search bar. */
  title?: string;
  /** Footer total — defaults to `Showing N` from data.length. */
  totalCount?: number;
  className?: string;
}

export function DataTable<T>({
  columns,
  data,
  getRowKey,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search…",
  filters,
  filterValues = {},
  onFilterChange,
  initialSort,
  hasMore,
  onLoadMore,
  isFetchingMore = false,
  onRowClick,
  loading = false,
  error,
  onRetry,
  emptyState,
  headerAction,
  title,
  totalCount,
  className,
}: DataTableProps<T>) {
  const [sorting, setSorting] = React.useState<SortingState>(
    initialSort ? [{ id: initialSort.id, desc: initialSort.desc ?? false }] : [],
  );

  // Map our column config → TanStack ColumnDef.
  const tableColumns = React.useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((col) => ({
        id: col.id,
        accessorFn: col.sortAccessor
          ? (row: T) => col.sortAccessor!(row) ?? ""
          : undefined,
        cell: (info) => col.cell(info.row.original),
        enableSorting: col.sortable ?? false,
        header: col.header,
      })),
    [columns],
  );

  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className={cn("space-y-4", className)}>
      {/* Header — title + action slot */}
      {(title || headerAction) && (
        <div className="flex items-start justify-between gap-3">
          {title ? (
            <h1 className="text-h2 text-foreground">{title}</h1>
          ) : (
            <span />
          )}
          {headerAction}
        </div>
      )}

      {/* Toolbar — search + filter chips */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[230px] max-w-[330px] flex-1 items-center gap-2 rounded-[var(--ds-radius-pill)] border border-border bg-[var(--ds-surface-sunken)] px-3.5 py-2 transition-all focus-within:border-ring focus-within:bg-card focus-within:ring-[3px] focus-within:ring-ring/10">
          <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        {filters?.length ? (
          <div className="flex flex-wrap items-center gap-2">
            {filters.map((f) => (
              <FilterChipGroup
                key={f.id}
                filter={f}
                value={filterValues[f.id] ?? null}
                onChange={(v) => onFilterChange?.(f.id, v)}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* Body */}
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading && data.length === 0 ? (
        <SkeletonTable />
      ) : data.length === 0 ? (
        emptyState ?? <DefaultEmpty />
      ) : (
        <>
          <div className="overflow-hidden rounded-[var(--ds-radius-card)] border border-border bg-card shadow-[var(--ds-shadow-card)]">
            <table className="w-full">
              <thead className="border-b border-border bg-[var(--ds-surface-sunken)]">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => {
                      const canSort = h.column.getCanSort();
                      const dir = h.column.getIsSorted();
                      const col = columns.find((c) => c.id === h.id);
                      return (
                        <th
                          key={h.id}
                          className={cn(
                            "px-[18px] py-[13px] text-left text-[11px] font-medium uppercase tracking-[0.4px]",
                            canSort && "cursor-pointer select-none",
                            col?.headerClassName,
                          )}
                          style={{ color: "var(--ds-ink-tertiary)" }}
                          onClick={
                            canSort
                              ? () => h.column.toggleSorting(dir === "asc")
                              : undefined
                          }
                          aria-sort={
                            dir === "asc"
                              ? "ascending"
                              : dir === "desc"
                                ? "descending"
                                : canSort
                                  ? "none"
                                  : undefined
                          }
                        >
                          <span className="inline-flex items-center gap-1">
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {canSort ? <SortGlyph dir={dir || "none"} /> : null}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={getRowKey(row.original)}
                    className={cn(
                      "border-b border-border last:border-b-0 transition-colors hover:bg-[#FAFAFE]",
                      onRowClick && "cursor-pointer",
                    )}
                    onClick={
                      onRowClick
                        ? (e: React.MouseEvent<HTMLTableRowElement>) => {
                            // KAN-988 visual smoke caught: per-cell
                            // `onClick={(e) => e.stopPropagation()}` on
                            // Next.js <Link> doesn't reliably halt the
                            // row-level click — both navigations fire and the
                            // row's push wins (deal page instead of company).
                            // Defense lives here: skip row nav when the click
                            // originated inside any interactive descendant.
                            const t = e.target as HTMLElement;
                            if (
                              t.closest(
                                'a, button, input, select, textarea, label, [role="button"], [role="link"]',
                              )
                            ) {
                              return;
                            }
                            onRowClick(row.original);
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => {
                      const col = columns.find((c) => c.id === cell.column.id);
                      return (
                        <td
                          key={cell.id}
                          className={cn(
                            "px-[18px] py-[14px] text-sm text-foreground",
                            col?.cellClassName,
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer — total + load more */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Showing {data.length}
              {totalCount != null && ` of ${totalCount}`}
            </p>
            {hasMore ? (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isFetchingMore}
                className="inline-flex items-center gap-2 rounded-[var(--ds-radius-pill)] border border-border bg-card px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                {isFetchingMore ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </>
                ) : (
                  "Load more"
                )}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function FilterChipGroup({
  filter,
  value,
  onChange,
}: {
  filter: DataTableFilter;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Filter by ${filter.label}`}>
      {filter.options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={`${filter.id}-${opt.value ?? "all"}`}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            // KAN-980 — per-chip aria-label keeps the prior accessibility
            // contract: each chip is uniquely identifiable as
            // "{filter.label}: {opt.label}" so tests (and screen readers)
            // can disambiguate "All" chips across groups.
            aria-label={`${filter.label}: ${opt.label}`}
            className={cn(
              "rounded-[var(--ds-radius-pill)] px-[13px] py-1.5 text-xs font-medium transition-colors",
              active
                ? "[background-image:var(--ds-accent-gradient)] text-primary-foreground"
                : "bg-[var(--ds-surface-sunken)] text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SortGlyph({ dir }: { dir: "asc" | "desc" | "none" | false }) {
  if (dir === "asc")
    return <ArrowUp className="h-3 w-3" style={{ color: "var(--ds-violet-500)" }} />;
  if (dir === "desc")
    return <ArrowDown className="h-3 w-3" style={{ color: "var(--ds-violet-500)" }} />;
  return <ArrowUpDown className="h-3 w-3 opacity-40" />;
}

function SkeletonTable() {
  return (
    <div className="overflow-hidden rounded-[var(--ds-radius-card)] border border-border bg-card">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border px-[18px] py-4 last:border-b-0"
        >
          <div
            className="h-4 w-40 animate-pulse rounded"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
          />
          <div
            className="h-4 w-32 animate-pulse rounded"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
          />
          <div
            className="h-4 w-20 animate-pulse rounded"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
          />
        </div>
      ))}
    </div>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  error: Error;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-[var(--ds-radius-card)] border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] p-4 text-sm"
    >
      <p className="font-medium" style={{ color: "var(--ds-danger-text)" }}>
        Failed to load
      </p>
      <p className="mt-1" style={{ color: "var(--ds-danger-text)" }}>
        {error.message || "Unknown error"}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs underline"
          style={{ color: "var(--ds-danger-text)" }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function DefaultEmpty() {
  return (
    <div className="rounded-[var(--ds-radius-card)] border border-dashed border-border bg-card p-16 text-center text-sm text-muted-foreground">
      No data.
    </div>
  );
}
