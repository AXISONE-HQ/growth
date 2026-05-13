'use client';

/**
 * KAN-901 — /imports list page (Ingestion Cohort 2.1b).
 *
 * Lists ImportJob rows from the KAN-896 backend. 5-column read-only
 * table (Created-by column dropped for V1 — see KAN-902 follow-up).
 *
 * "New Upload" CTA opens the UploadModal which drives the full
 * createUploadUrl → XHR PUT → confirmUpload → router.push flow.
 * After modal closes on success, this page's TanStack Query will
 * refetch on next focus / mount and the new row appears.
 *
 * Row click → /imports/[id] detail page (cursor + keyboard a11y per
 * KAN-887 row-click pattern).
 */

import { Loader2, RefreshCw, Upload, FileSpreadsheet, FileText } from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { importJobsApi, type CursorPage, type ImportJobListItem, type ImportStatus } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import {
  IMPORT_FILE_TYPE_LABELS,
  IMPORT_MODE_LABELS,
  IMPORT_STATUS_LABELS,
  enumLabel,
} from '@/lib/enum-labels';
import { UploadModal } from '@/components/imports/upload-modal';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;

const STATUS_FILTER_OPTIONS: Array<{ value: ImportStatus | null; label: string }> = [
  { value: null, label: 'All' },
  ...(Object.entries(IMPORT_STATUS_LABELS) as Array<[ImportStatus, string]>).map(
    ([value, label]) => ({ value, label }),
  ),
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function FileTypeIcon({ type }: { type: string | null }) {
  if (type === 'csv') return <FileText className="w-4 h-4 text-gray-500" />;
  if (type === 'xlsx') return <FileSpreadsheet className="w-4 h-4 text-emerald-600" />;
  return <FileText className="w-4 h-4 text-gray-400" />;
}

export default function ImportsPage() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<ImportStatus | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const queryInput = {
    limit: 50,
    ...(statusFilter ? { status: statusFilter } : {}),
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    CursorPage<ImportJobListItem>
  >({
    queryKey: ['importJobs', 'list', queryInput],
    queryFn: () => importJobsApi.list(queryInput),
  });

  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1
            className="text-2xl font-semibold flex items-center gap-2"
            style={SECTION_HEADER_STYLE}
          >
            <Upload className="w-6 h-6 text-gray-500" />
            Data Imports
          </h1>
          <p className="text-sm mt-1" style={MUTED_STYLE}>
            Upload CSV or XLSX files to ingest contacts, companies, deals, or orders.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            {isFetching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Refresh
          </button>
          <Button onClick={() => setModalOpen(true)} className="inline-flex items-center gap-2">
            <Upload className="w-4 h-4" /> New Upload
          </Button>
        </div>
      </div>

      {/* Status filter chips */}
      <div className="mb-6 flex flex-wrap gap-2">
        {STATUS_FILTER_OPTIONS.map((opt) => {
          const active = statusFilter === opt.value;
          return (
            <button
              key={opt.value ?? 'all'}
              onClick={() => setStatusFilter(opt.value)}
              aria-label={`Status: ${opt.label}`}
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
          <p className="font-medium text-red-800">Failed to load imports</p>
          <p className="text-red-700 mt-1">{(error as Error)?.message ?? 'Unknown error'}</p>
          <button
            onClick={() => void refetch()}
            className="mt-2 text-red-700 underline text-xs"
          >
            Retry
          </button>
        </div>
      ) : isLoading ? (
        <SkeletonTable />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Upload}
          heading="No imports yet"
          body="Upload your first CSV or XLSX to get started. We'll detect what's in it and guide you through bringing it into growth."
          action={
            <Button onClick={() => setModalOpen(true)} className="inline-flex items-center gap-2">
              <Upload className="w-4 h-4" /> New Upload
            </Button>
          }
        />
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr
                  className="text-left text-xs font-medium uppercase tracking-wider"
                  style={MUTED_STYLE}
                >
                  <th className="px-4 py-3">File</th>
                  <th className="px-4 py-3">Mode</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Rows</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {items.map((job) => (
                  <tr
                    key={job.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => router.push(`/imports/${job.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') router.push(`/imports/${job.id}`);
                    }}
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    {/* File */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileTypeIcon type={job.detectedFileType} />
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 truncate max-w-xs">
                            {job.fileName}
                          </div>
                          <div className="text-xs" style={MUTED_STYLE}>
                            {formatBytes(job.fileSize)}
                            {job.detectedFileType
                              ? ` · ${enumLabel(IMPORT_FILE_TYPE_LABELS, job.detectedFileType)}`
                              : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    {/* Mode */}
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                        {enumLabel(IMPORT_MODE_LABELS, job.mode)}
                      </span>
                    </td>
                    {/* Status */}
                    <td className="px-4 py-3">
                      <StatusBadge kind="import-status" value={job.status} />
                    </td>
                    {/* Rows */}
                    <td
                      className="px-4 py-3 text-right tabular-nums"
                      style={{ color: 'var(--ds-ink-secondary)' }}
                    >
                      {job.detectedRowCount != null ? job.detectedRowCount.toLocaleString() : '—'}
                    </td>
                    {/* Created */}
                    <td className="px-4 py-3 text-xs" style={MUTED_STYLE}>
                      {relativeTime(job.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4">
            <p className="text-xs" style={MUTED_STYLE}>
              Showing {items.length} of {totalCount}
            </p>
          </div>
        </>
      )}

      <UploadModal open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="px-4 py-4 border-b border-gray-100 last:border-b-0 flex items-center gap-4"
        >
          <div className="w-4 h-4 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-40 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-20 bg-gray-100 rounded-full animate-pulse" />
          <div className="h-4 w-16 bg-gray-200 rounded-full animate-pulse" />
          <div className="h-4 w-12 bg-gray-100 rounded animate-pulse ml-auto" />
          <div className="h-3 w-16 bg-gray-200 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}
