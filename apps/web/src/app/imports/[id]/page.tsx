'use client';

/**
 * KAN-901 — /imports/[id] ImportJob detail page (Ingestion Cohort 2.1b).
 *
 * 5 stacked cards consuming the KAN-896 `importJobs.get` response:
 *   1. File info       (always)
 *   2. Inspection      (only when status='inspected')
 *   3. Timestamps      (always)
 *   4. Error           (only when status='failed')
 *   5. Next steps      (always — guides to mapping in PR 5)
 *
 * NOT_FOUND state renders a friendly error per KAN-895 finding (the
 * sibling KAN-887/888 pages were sitting in skeleton on NOT_FOUND
 * pre-KAN-895; this page does it right from day 1).
 */

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  FileSpreadsheet,
  FileText,
  Loader2,
  Upload,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { importJobsApi, type ImportJobDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  IMPORT_FILE_TYPE_LABELS,
  IMPORT_MODE_LABELS,
  enumLabel,
} from '@/lib/enum-labels';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;
const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function fileTypeIcon(type: string | null) {
  if (type === 'csv') return <FileText className="w-5 h-5 text-gray-500" />;
  if (type === 'xlsx') return <FileSpreadsheet className="w-5 h-5 text-emerald-600" />;
  return <FileText className="w-5 h-5 text-gray-400" />;
}

function truncateCell(value: unknown, maxLen = 40): string {
  if (value === null || value === undefined) return '—';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

export default function ImportDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { data: job, isLoading, isError, error } = useQuery<ImportJobDetail>({
    queryKey: ['importJobs', 'get', id],
    queryFn: () => importJobsApi.get(id as string),
    enabled: !!id,
    // Poll while status is in-flight states (caller landed on the page
    // mid-inspection). Once status is terminal (inspected/failed), stop.
    // TanStack Query v4 callback receives data directly.
    refetchInterval: (data) => {
      if (!data) return false;
      const terminal = data.status === 'inspected' || data.status === 'failed';
      return terminal ? false : 1500;
    },
  });

  useEffect(() => {
    if (job) document.title = `${job.fileName} · Imports`;
  }, [job]);

  if (!id) return null;
  if (isLoading) return <SkeletonCards />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href="/imports"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Imports
        </Link>
        <div className="bg-white border rounded-lg p-12 text-center">
          <Upload className="w-8 h-8 mx-auto text-gray-300" />
          <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
            {isNotFound ? 'Import not found' : 'Failed to load import'}
          </h2>
          <p className="text-sm mt-1" style={MUTED_STYLE}>
            {message}
          </p>
        </div>
      </div>
    );
  }

  if (!job) return null;

  const headers = Array.isArray(job.detectedHeaders) ? job.detectedHeaders : [];
  const sampleRows = Array.isArray(job.sampleRows) ? job.sampleRows : [];
  const showInspection = job.status === 'inspected';
  const showError = job.status === 'failed';

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <Link
        href="/imports"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Imports
      </Link>

      {/* Card 1 — File info */}
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-shrink-0">{fileTypeIcon(job.detectedFileType)}</div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold truncate" style={SECTION_HEADER_STYLE}>
                {job.fileName}
              </h1>
              <p className="text-xs mt-0.5" style={MUTED_STYLE}>
                Import ID: {job.id}
              </p>
            </div>
          </div>
          <StatusBadge kind="import-status" value={job.status} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="Size" value={formatBytes(job.fileSize)} />
          <Field
            label="Detected type"
            value={
              job.detectedFileType
                ? enumLabel(IMPORT_FILE_TYPE_LABELS, job.detectedFileType)
                : null
            }
          />
          <Field
            label="Mode"
            value={
              <span className="inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                {enumLabel(IMPORT_MODE_LABELS, job.mode)}
              </span>
            }
          />
          <Field
            label="MIME type"
            value={<span className="font-mono text-xs">{job.fileMimeType}</span>}
          />
        </div>
      </section>

      {/* Card 2 — Inspection results (only when status=inspected) */}
      {showInspection ? (
        <section className="bg-white border rounded-lg p-6">
          <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
            Inspection results
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm mb-4">
            <Field
              label="Total rows"
              value={
                job.detectedRowCount != null ? job.detectedRowCount.toLocaleString() : null
              }
            />
            <Field
              label="Total columns"
              value={
                job.detectedColumnCount != null
                  ? job.detectedColumnCount.toLocaleString()
                  : null
              }
            />
          </div>

          {/* Detected headers as chips */}
          <div className="mb-4">
            <div className="text-xs mb-2" style={MUTED_STYLE}>
              Detected headers
            </div>
            {headers.length === 0 ? (
              <p className="text-sm" style={MUTED_STYLE}>
                No headers detected.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {headers.map((h, i) => (
                  <span
                    key={`${i}-${h}`}
                    className="inline-flex items-center px-2 py-0.5 text-xs font-mono rounded-md bg-gray-50 text-gray-700 border border-gray-200"
                  >
                    {h}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Sample rows table */}
          <div>
            <div className="text-xs mb-2" style={MUTED_STYLE}>
              Sample rows (first 5)
            </div>
            {sampleRows.length === 0 || headers.length === 0 ? (
              <p className="text-sm" style={MUTED_STYLE}>
                No sample rows available.
              </p>
            ) : (
              <div className="overflow-x-auto border rounded-md">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr className="text-left" style={MUTED_STYLE}>
                      {headers.map((h, i) => (
                        <th
                          key={`${i}-${h}`}
                          className="px-3 py-2 font-medium uppercase tracking-wider whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {sampleRows.map((row, ri) => (
                      <tr key={ri}>
                        {headers.map((h, ci) => {
                          const raw = (row as Record<string, unknown>)[h];
                          const display = truncateCell(raw);
                          const full =
                            raw === null || raw === undefined
                              ? ''
                              : typeof raw === 'string'
                                ? raw
                                : JSON.stringify(raw);
                          return (
                            <td
                              key={`${ri}-${ci}`}
                              className="px-3 py-2 whitespace-nowrap"
                              style={LABEL_STYLE}
                              title={full}
                            >
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {/* Card 3 — Timestamps */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Timestamps
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field
            label="Created"
            value={
              <span title={fmtDateTime(job.createdAt)}>{relativeTime(job.createdAt)}</span>
            }
          />
          <Field
            label="Upload confirmed"
            value={
              job.uploadConfirmedAt ? (
                <span title={fmtDateTime(job.uploadConfirmedAt)}>
                  {relativeTime(job.uploadConfirmedAt)}
                </span>
              ) : null
            }
          />
          <Field
            label="Inspection started"
            value={
              job.inspectionStartedAt ? (
                <span title={fmtDateTime(job.inspectionStartedAt)}>
                  {relativeTime(job.inspectionStartedAt)}
                </span>
              ) : null
            }
          />
          <Field
            label="Inspection completed"
            value={
              job.inspectionCompletedAt ? (
                <span title={fmtDateTime(job.inspectionCompletedAt)}>
                  {relativeTime(job.inspectionCompletedAt)}
                </span>
              ) : null
            }
          />
        </div>
      </section>

      {/* Card 4 — Error (only when status=failed) */}
      {showError ? (
        <section className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-red-800">Inspection failed</h2>
              <p className="text-sm mt-1 text-red-700 whitespace-pre-wrap">
                {job.errorMessage ?? 'No error message recorded.'}
              </p>
              <p className="text-xs mt-2" style={MUTED_STYLE} title={fmtDateTime(job.errorAt)}>
                {relativeTime(job.errorAt)}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* Card 5 — Next steps (always) */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Next steps
        </h2>
        {job.status === 'inspected' ? (
          <div className="space-y-2">
            <p className="text-sm" style={LABEL_STYLE}>
              File is ready. The next phase — field mapping — ships in a later release.
            </p>
            <Button disabled variant="outline">
              Continue to mapping (coming soon)
            </Button>
          </div>
        ) : job.status === 'failed' ? (
          <div className="space-y-2">
            <p className="text-sm" style={LABEL_STYLE}>
              Inspection failed. Upload a different file or fix the source data and try again.
            </p>
            <Link href="/imports">
              <Button variant="outline">Back to Imports</Button>
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm" style={LABEL_STYLE}>
            <Loader2 className="w-4 h-4 animate-spin" />
            Inspection in progress…
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode | null | undefined;
}) {
  const display = value === null || value === undefined || value === '' ? '—' : value;
  return (
    <div>
      <div className="text-xs" style={MUTED_STYLE}>
        {label}
      </div>
      <div className="mt-0.5" style={LABEL_STYLE}>
        {display}
      </div>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-white border rounded-lg p-6 space-y-3">
          <div className="h-5 w-1/3 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-2/3 bg-gray-100 rounded animate-pulse" />
          <div className="h-4 w-1/2 bg-gray-100 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}
