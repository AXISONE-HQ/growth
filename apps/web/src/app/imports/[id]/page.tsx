'use client';

/**
 * KAN-901 — /imports/[id] ImportJob detail page (Ingestion Cohort 2.1b).
 * KAN-904 — adds Card 3 (AI Detection) between Inspection + Timestamps.
 * KAN-905 — adds Card 4 (Field Mapping) after AI Detection.
 * KAN-907 — inserts Card 4 (Row Classification) between AI Detection
 *           and Field Mapping; Field Mapping card becomes gated on
 *           rowClassificationConfirmedAt.
 *
 * 8 stacked cards consuming the `importJobs.get` response:
 *   1. File info            (always)
 *   2. Inspection           (only when status='inspected')
 *   3. AI Detection         (only when status='inspected'; 3-state) — KAN-904
 *   4. Row Classification   (only when detection complete; 4-state) — KAN-907
 *   5. Field Mapping        (gated on classification confirmation; 4-state) — KAN-905
 *   6. Timestamps           (always)
 *   7. Error                (only when status='failed' — inspection-side)
 *   8. Next steps           (always — final CTA gating)
 *
 * NOT_FOUND state renders a friendly error per KAN-895 finding.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Columns3,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  ListChecks,
  PlayCircle,
  Scan,
  Sparkles,
  Upload,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { importJobsApi, type ImportJobDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { ConfidenceBadge } from '@/components/growth/confidence-badge';
import {
  DETECTED_ENTITY_TYPE_LABELS,
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
  const queryClient = useQueryClient();

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

  // KAN-904 — AI entity detection. Mutation blocks until Haiku responds
  // (~1-3s typical). On success we refetch the ImportJob to re-render
  // Card 3 (AI Detection) with the populated detectedEntityType +
  // confidence + reasoning fields.
  const detectionMutation = useMutation<ImportJobDetail, Error, string>({
    mutationFn: (importJobId) => importJobsApi.runDetection(importJobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['importJobs', 'get', id] });
    },
    onError: (err) => {
      toast.error(err.message || 'Detection failed', {
        description: 'See the AI Detection card for details.',
      });
      void queryClient.invalidateQueries({ queryKey: ['importJobs', 'get', id] });
    },
  });

  // KAN-907 — row-level classification. Hybrid heuristic + LLM pipeline.
  // Latency 5-30s for mixed files (depends on row count); single-entity
  // files are heuristic-only and complete in <1s.
  const rowClassifyMutation = useMutation<ImportJobDetail, Error, string>({
    mutationFn: (importJobId) => importJobsApi.runRowClassification(importJobId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['importJobs', 'get', id], updated);
    },
    onError: (err) => {
      toast.error(err.message || 'Row classification failed', {
        description: 'See the Row Classification card for details.',
      });
      void queryClient.invalidateQueries({ queryKey: ['importJobs', 'get', id] });
    },
  });

  // KAN-907 — operator confirmation. Idempotent; sets the
  // confirmation timestamp + unblocks the Field Mapping card.
  const confirmClassifyMutation = useMutation<ImportJobDetail, Error, string>({
    mutationFn: (importJobId) => importJobsApi.confirmRowClassification(importJobId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['importJobs', 'get', id], updated);
      toast.success('Row classification confirmed.');
    },
    onError: (err) => {
      toast.error(err.message || 'Confirm failed');
    },
  });

  // KAN-913 — Cohort 2.7 commit. Synchronous; blocks for up to 30-60s
  // on 10K-row files in V1. Result state determines the Card 7 render.
  const runCommitMutation = useMutation<ImportJobDetail, Error, string>({
    mutationFn: (importJobId) => importJobsApi.runCommit(importJobId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['importJobs', 'get', id], updated);
      const ok = updated.committedRowCount;
      const failed = updated.failedRowCount;
      if (updated.commitStatus === 'succeeded') {
        toast.success(`Commit complete — ${ok} row${ok === 1 ? '' : 's'} written.`);
      } else if (updated.commitStatus === 'partial') {
        toast.warning(
          `Commit partial — ${ok} succeeded, ${failed} failed.`,
          { description: 'Download the error CSV from Card 7 to triage.' },
        );
      } else {
        toast.error(
          `Commit failed — ${failed} row${failed === 1 ? '' : 's'} with errors.`,
        );
      }
    },
    onError: (err) => {
      toast.error(err.message || 'Commit failed', {
        description: 'See the Commit card for details.',
      });
      void queryClient.invalidateQueries({ queryKey: ['importJobs', 'get', id] });
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

      {/* Card 3 — AI Detection (KAN-904) — only when inspection done */}
      {showInspection ? (
        <DetectionCard
          job={job}
          isRunning={detectionMutation.isPending}
          onRun={() => detectionMutation.mutate(job.id)}
        />
      ) : null}

      {/* Card 4 — Row Classification (KAN-907) — only when detection complete */}
      {showInspection && job.detectedEntityType ? (
        <RowClassificationCard
          job={job}
          isRunning={rowClassifyMutation.isPending}
          isConfirming={confirmClassifyMutation.isPending}
          onRun={() => rowClassifyMutation.mutate(job.id)}
          onConfirm={() => confirmClassifyMutation.mutate(job.id)}
        />
      ) : null}

      {/* Card 5 — Field Mapping (KAN-905) — gated on classification confirmation (KAN-907) */}
      {showInspection && job.detectedEntityType ? (
        <MappingCard job={job} />
      ) : null}

      {/* Card 6 — Duplicate Detection (KAN-911) — gated on field mapping confirmation */}
      {showInspection && job.detectedEntityType && job.fieldMappingConfirmedAt ? (
        <DuplicateDetectionCard job={job} />
      ) : null}

      {/* Card 7 — Commit (KAN-913) — gated on dedup confirmation */}
      {showInspection && job.detectedEntityType && job.dedupConfirmedAt ? (
        <CommitCard
          job={job}
          isRunning={runCommitMutation.isPending}
          onRun={() => runCommitMutation.mutate(job.id)}
        />
      ) : null}

      {/* Card 8 — Timestamps */}
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

      {/* Card 7 — Next steps (always) — KAN-905 gates on mapping confirmation */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Next steps
        </h2>
        {job.status === 'inspected' ? (
          job.detectedEntityType == null ? (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                File is ready. Run AI detection (Card 3) to classify what kind of data
                this contains before continuing.
              </p>
              <Button disabled variant="outline" title="Run AI detection first">
                Continue to staging
              </Button>
            </div>
          ) : job.detectedEntityType === 'unknown' || job.detectedEntityType === 'mixed' ? (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                {job.detectedEntityType === 'mixed'
                  ? 'Mixed-entity files require row-level classification, which ships in a later release.'
                  : 'AI classification confidence was low. Manual entity-type selection ships in a later release.'}
              </p>
              <div
                className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-md border"
                style={{
                  backgroundColor: 'var(--ds-warning-soft)',
                  color: 'var(--ds-warning-text)',
                  borderColor: 'var(--ds-warning)',
                }}
              >
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                <span>
                  {job.detectedEntityType === 'mixed'
                    ? 'Mixed-entity files not supported in this release.'
                    : 'Low confidence — re-run detection or upload a single-entity file.'}
                </span>
              </div>
              <Button disabled variant="outline">
                Continue to staging
              </Button>
            </div>
          ) : !job.fieldMappingConfirmedAt ? (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                File classified as{' '}
                <strong>
                  {enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)}
                </strong>
                . Complete column mapping (Card 5) before continuing to staging.
              </p>
              <Button disabled variant="outline" title="Complete and save column mapping first">
                Continue to staging
              </Button>
            </div>
          ) : !job.dedupConfirmedAt ? (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                File classified as{' '}
                <strong>
                  {enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)}
                </strong>
                . Review and confirm duplicate detection (Card 6) before continuing
                to commit.
              </p>
              <Link href={`/imports/${job.id}/duplicates`}>
                <Button variant="default">
                  <Scan className="w-4 h-4 mr-1.5" aria-hidden /> Review duplicates
                </Button>
              </Link>
            </div>
          ) : job.commitStatus === 'succeeded' ? (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                Import complete —{' '}
                <strong>{job.committedRowCount.toLocaleString()}</strong> row
                {job.committedRowCount === 1 ? '' : 's'} written to your canonical
                tables.
              </p>
              <div className="flex gap-2">
                <Link href="/contacts">
                  <Button variant="outline" size="sm">View Contacts</Button>
                </Link>
                <Link href="/companies">
                  <Button variant="outline" size="sm">View Companies</Button>
                </Link>
                <Link href="/imports">
                  <Button variant="outline" size="sm">Back to Imports</Button>
                </Link>
              </div>
            </div>
          ) : job.commitStatus === 'partial' ? (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                Commit partial —{' '}
                <strong>{job.committedRowCount.toLocaleString()}</strong> succeeded,{' '}
                <strong>{job.failedRowCount.toLocaleString()}</strong> failed.
                Download the error CSV from Card 7 to fix and re-import.
              </p>
            </div>
          ) : job.commitStatus === 'failed' ? (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                Commit failed. See Card 7 for the per-row failure breakdown.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                File classified as{' '}
                <strong>
                  {enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)}
                </strong>
                , column mappings are saved, and duplicates are resolved. Click
                Commit (Card 7) to write rows to your canonical tables.
              </p>
            </div>
          )
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

// ─────────────────────────────────────────────
// KAN-904 — AI Detection card subcomponent.
//
// Three mutually-exclusive states:
//   (a) idle    — no detection run yet AND no prior error
//   (b) done    — detectedEntityType populated (success path; coercion to
//                 'unknown' for low-confidence is still a "done" state)
//   (c) error   — detectionError populated AND detectedEntityType null
//                 (either a fresh run that failed, or a prior failure
//                  that hasn't been retried)
// ─────────────────────────────────────────────

function DetectionCard({
  job,
  isRunning,
  onRun,
}: {
  job: ImportJobDetail;
  isRunning: boolean;
  onRun: () => void;
}) {
  if (isRunning) {
    return (
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          AI Detection
        </h2>
        <div className="flex items-center gap-2 text-sm" style={LABEL_STYLE}>
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          Analyzing your file…
        </div>
      </section>
    );
  }

  // (c) Error state — prior run failed and hasn't been retried.
  if (job.detectionError && job.detectedEntityType == null) {
    return (
      <section className="bg-red-50 border border-red-200 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <XCircle
            className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5"
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-red-800">
              AI Detection — Failed
            </h2>
            <p className="text-sm mt-1 text-red-700 whitespace-pre-wrap break-words">
              {job.detectionError}
            </p>
            <p
              className="text-xs mt-2"
              style={MUTED_STYLE}
              title={fmtDateTime(job.detectionErrorAt)}
            >
              Failed {relativeTime(job.detectionErrorAt)}
            </p>
            <div className="mt-3">
              <Button onClick={onRun} variant="default">
                <Sparkles className="w-4 h-4 mr-1.5" aria-hidden /> Retry
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // (b) Done state — detection result populated.
  if (job.detectedEntityType != null) {
    const startedMs = job.detectionStartedAt
      ? new Date(job.detectionStartedAt).getTime()
      : null;
    const completedMs = job.detectionCompletedAt
      ? new Date(job.detectionCompletedAt).getTime()
      : null;
    const durationSec =
      startedMs != null && completedMs != null
        ? ((completedMs - startedMs) / 1000).toFixed(1)
        : null;
    const inTok = job.detectionInputTokens ?? 0;
    const outTok = job.detectionOutputTokens ?? 0;

    return (
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-sm font-semibold" style={SECTION_HEADER_STYLE}>
            AI Detection
          </h2>
          <Button onClick={onRun} variant="outline" size="sm">
            <Sparkles className="w-3.5 h-3.5 mr-1.5" aria-hidden /> Re-run detection
          </Button>
        </div>

        {/* Hero row — entity type + confidence badge */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="text-lg font-semibold" style={SECTION_HEADER_STYLE}>
            {enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)}
          </span>
          {job.detectionConfidence != null ? (
            <ConfidenceBadge value={job.detectionConfidence} />
          ) : null}
        </div>

        {/* Reasoning — always visible */}
        <div className="mb-3">
          <div className="text-xs mb-1" style={MUTED_STYLE}>
            Why?
          </div>
          <p
            className="text-sm whitespace-pre-wrap break-words"
            style={LABEL_STYLE}
          >
            {job.detectionReasoning ?? '—'}
          </p>
        </div>

        {/* Footer — model + tokens + duration */}
        <div className="text-xs mt-4 pt-3 border-t border-gray-100" style={MUTED_STYLE}>
          {job.detectionLlmModel ? (
            <>
              Model: <span className="font-mono">{job.detectionLlmModel}</span>
            </>
          ) : null}
          {job.detectionLlmModel ? ' · ' : null}
          Tokens: {inTok.toLocaleString()}+{outTok.toLocaleString()}
          {durationSec != null ? ` · Duration: ${durationSec}s` : null}
        </div>
      </section>
    );
  }

  // (a) Idle state — never run.
  return (
    <section className="bg-white border rounded-lg p-6">
      <h2 className="text-sm font-semibold mb-2" style={SECTION_HEADER_STYLE}>
        Detect entity type
      </h2>
      <p className="text-sm mb-4" style={LABEL_STYLE}>
        Use AI to identify what kind of data is in this file (Contacts, Companies,
        Deals, Orders, or Mixed).
      </p>
      <Button onClick={onRun} variant="default">
        <Sparkles className="w-4 h-4 mr-1.5" aria-hidden /> Run detection
      </Button>
    </section>
  );
}

// ─────────────────────────────────────────────
// KAN-905 — Field Mapping card subcomponent.
//
// Five states (mutually exclusive):
//   (a) detection not supported (entity = mixed/unknown) → muted CTA
//       pointing to a future release
//   (b) detection done + entity supported + fieldMappings null + no error
//       → "Map columns" CTA → deep-link to /imports/[id]/mapping
//   (c) fieldMappings present + fieldMappingConfirmedAt null
//       → "AI mapped {N} columns. Review and save."
//   (d) fieldMappingConfirmedAt populated → green check + summary +
//       "Edit mappings"
//   (e) fieldMappingError populated + no fieldMappings → error + retry
//
// Links to /imports/[id]/mapping for state changes; this card is
// read-only (no mutations fire here).
// ─────────────────────────────────────────────

const MAPPING_SUPPORTED_ENTITIES = new Set([
  'contacts',
  'companies',
  'deals',
  'orders',
]);

function MappingCard({ job }: { job: ImportJobDetail }) {
  const supported = job.detectedEntityType
    ? MAPPING_SUPPORTED_ENTITIES.has(job.detectedEntityType)
    : false;

  // (a) Unsupported entity (mixed). KAN-907 follow-up #1 will add
  // per-entity mapping for mixed files. For now, show explicit
  // disabled state with a forward-looking tooltip.
  if (job.detectedEntityType === 'mixed') {
    return (
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-2" style={SECTION_HEADER_STYLE}>
          Field Mapping
        </h2>
        <p className="text-sm mb-3" style={LABEL_STYLE}>
          Mixed-entity files have rows split across multiple staging tables.
          Per-entity field mapping ships in a follow-up cohort.
        </p>
        <Button
          disabled
          variant="outline"
          title="Mixed-file mapping coming in a follow-up cohort"
        >
          Map columns (coming soon)
        </Button>
      </section>
    );
  }

  if (!supported) {
    return (
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-2" style={SECTION_HEADER_STYLE}>
          Field Mapping
        </h2>
        <p className="text-sm" style={LABEL_STYLE}>
          AI field mapping is only available for single-entity files
          (Contacts / Companies / Deals / Orders). Re-run detection or
          upload a single-entity file.
        </p>
      </section>
    );
  }

  // KAN-907 — gate on classification confirmation. Field Mapping is
  // unavailable until the operator clicks Confirm on Card 4.
  if (!job.rowClassificationConfirmedAt) {
    return (
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-2" style={SECTION_HEADER_STYLE}>
          Field Mapping
        </h2>
        <p className="text-sm mb-3" style={LABEL_STYLE}>
          Complete and confirm row classification (Card 4) before mapping columns.
        </p>
        <Button
          disabled
          variant="outline"
          title="Confirm row classification first"
        >
          Map columns
        </Button>
      </section>
    );
  }

  const mappings = job.fieldMappings ?? [];
  const totalCount = mappings.length;
  const skippedCount = mappings.filter((m) => m.targetField === 'skip').length;
  const mappedCount = totalCount - skippedCount;

  // (e) Error state — only when no fieldMappings AND error is set.
  if (job.fieldMappingError && totalCount === 0) {
    return (
      <section className="bg-red-50 border border-red-200 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" aria-hidden />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-red-800">
              Field Mapping — Failed
            </h2>
            <p className="text-sm mt-1 text-red-700 whitespace-pre-wrap break-words">
              {job.fieldMappingError}
            </p>
            <p
              className="text-xs mt-2"
              style={MUTED_STYLE}
              title={fmtDateTime(job.fieldMappingErrorAt)}
            >
              Failed {relativeTime(job.fieldMappingErrorAt)}
            </p>
            <div className="mt-3">
              <Link href={`/imports/${job.id}/mapping`}>
                <Button variant="default">
                  <Sparkles className="w-4 h-4 mr-1.5" /> Retry mapping
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // (d) Confirmed state.
  if (job.fieldMappingConfirmedAt) {
    return (
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-3 gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" aria-hidden />
            <h2 className="text-sm font-semibold" style={SECTION_HEADER_STYLE}>
              Field Mapping
            </h2>
          </div>
          <Link href={`/imports/${job.id}/mapping`}>
            <Button variant="outline" size="sm">
              <Columns3 className="w-3.5 h-3.5 mr-1.5" aria-hidden /> Edit mappings
            </Button>
          </Link>
        </div>
        <p className="text-sm" style={LABEL_STYLE}>
          <strong>{mappedCount}</strong> column{mappedCount === 1 ? '' : 's'} mapped
          {skippedCount > 0 ? <>, <strong>{skippedCount}</strong> skipped</> : null}.
        </p>
        <p
          className="text-xs mt-1"
          style={MUTED_STYLE}
          title={fmtDateTime(job.fieldMappingConfirmedAt)}
        >
          Confirmed {relativeTime(job.fieldMappingConfirmedAt)}
        </p>
      </section>
    );
  }

  // (c) AI mapping done, but not yet operator-confirmed.
  if (totalCount > 0) {
    return (
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-3 gap-3">
          <h2 className="text-sm font-semibold" style={SECTION_HEADER_STYLE}>
            Field Mapping
          </h2>
          <Link href={`/imports/${job.id}/mapping`}>
            <Button variant="default" size="sm">
              <Columns3 className="w-3.5 h-3.5 mr-1.5" aria-hidden /> Review mappings
            </Button>
          </Link>
        </div>
        <p className="text-sm" style={LABEL_STYLE}>
          AI mapped <strong>{mappedCount}</strong> of <strong>{totalCount}</strong>{' '}
          column{totalCount === 1 ? '' : 's'}. Review and save before continuing.
        </p>
        {job.fieldMappingConfidence != null ? (
          <p className="text-xs mt-1" style={MUTED_STYLE}>
            Overall confidence: {job.fieldMappingConfidence}%
          </p>
        ) : null}
      </section>
    );
  }

  // (b) Idle — never run.
  return (
    <section className="bg-white border rounded-lg p-6">
      <h2 className="text-sm font-semibold mb-2" style={SECTION_HEADER_STYLE}>
        Map columns
      </h2>
      <p className="text-sm mb-4" style={LABEL_STYLE}>
        Use AI to suggest how each source column should map to a target field
        on the canonical {enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)} schema.
      </p>
      <Link href={`/imports/${job.id}/mapping`}>
        <Button variant="default">
          <Columns3 className="w-4 h-4 mr-1.5" aria-hidden /> Map columns
        </Button>
      </Link>
    </section>
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

// ─────────────────────────────────────────────
// KAN-907 — Row Classification card subcomponent.
//
// Five states (mutually exclusive):
//   (a) detection not yet complete (entity null/unknown) → muted gate
//   (b) detection done + no counts + no error → "Classify rows" CTA
//   (c) running → spinner + "Classifying N rows..."
//   (d) counts populated + not yet confirmed → chips + Re-run + Confirm
//   (e) confirmed → counts + confirmation footer + Re-run (secondary)
//   (f) error → red panel + Retry
// ─────────────────────────────────────────────

const ENTITY_CHIP_TONES: Record<
  string,
  { bg: string; fg: string; border: string }
> = {
  contacts: { bg: 'bg-emerald-50', fg: 'text-emerald-700', border: 'border-emerald-200' },
  companies: { bg: 'bg-violet-50', fg: 'text-violet-700', border: 'border-violet-200' },
  deals: { bg: 'bg-amber-50', fg: 'text-amber-700', border: 'border-amber-200' },
  orders: { bg: 'bg-blue-50', fg: 'text-blue-700', border: 'border-blue-200' },
  skipped: { bg: 'bg-gray-100', fg: 'text-gray-600', border: 'border-gray-200' },
  unknown: { bg: 'bg-red-50', fg: 'text-red-700', border: 'border-red-200' },
};

function EntityChip({ label, count, kind }: { label: string; count: number; kind: keyof typeof ENTITY_CHIP_TONES }) {
  const t = ENTITY_CHIP_TONES[kind] ?? ENTITY_CHIP_TONES.unknown;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-sm font-medium rounded-full border ${t.bg} ${t.fg} ${t.border}`}
    >
      <strong>{count.toLocaleString()}</strong>
      <span>{label}</span>
    </span>
  );
}

function RowClassificationCard({
  job,
  isRunning,
  isConfirming,
  onRun,
  onConfirm,
}: {
  job: ImportJobDetail;
  isRunning: boolean;
  isConfirming: boolean;
  onRun: () => void;
  onConfirm: () => void;
}) {
  const counts = job.rowClassificationCounts;
  const hasCounts = counts != null;
  const isConfirmed = !!job.rowClassificationConfirmedAt;
  const hasError =
    !!job.rowClassificationError && !job.rowClassificationCompletedAt;
  const isMixed = job.detectedEntityType === 'mixed';

  if (isRunning) {
    return (
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Row Classification
        </h2>
        <div className="flex items-center gap-2 text-sm" style={LABEL_STYLE}>
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          {isMixed
            ? 'Classifying rows… (mixed files run heuristic + AI batches)'
            : 'Staging rows… (single-entity files complete quickly)'}
        </div>
      </section>
    );
  }

  // (f) Error state.
  if (hasError) {
    return (
      <section className="bg-red-50 border border-red-200 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" aria-hidden />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-red-800">
              Row Classification — Failed
            </h2>
            <p className="text-sm mt-1 text-red-700 whitespace-pre-wrap break-words">
              {job.rowClassificationError}
            </p>
            <p
              className="text-xs mt-2"
              style={MUTED_STYLE}
              title={fmtDateTime(job.rowClassificationErrorAt)}
            >
              Failed {relativeTime(job.rowClassificationErrorAt)}
            </p>
            <div className="mt-3">
              <Button onClick={onRun} variant="default">
                <ListChecks className="w-4 h-4 mr-1.5" aria-hidden /> Retry
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // (d) + (e) — counts populated.
  if (hasCounts) {
    const inTok = job.rowClassificationInputTokens ?? 0;
    const outTok = job.rowClassificationOutputTokens ?? 0;
    const startedMs = job.rowClassificationStartedAt
      ? new Date(job.rowClassificationStartedAt).getTime()
      : null;
    const completedMs = job.rowClassificationCompletedAt
      ? new Date(job.rowClassificationCompletedAt).getTime()
      : null;
    const durationSec =
      startedMs != null && completedMs != null
        ? ((completedMs - startedMs) / 1000).toFixed(1)
        : null;
    const heuristicPct =
      counts.total > 0
        ? Math.round((counts.bySource.heuristic / counts.total) * 100)
        : 0;
    const llmPct =
      counts.total > 0 ? Math.round((counts.bySource.llm / counts.total) * 100) : 0;

    return (
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {isConfirmed ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600" aria-hidden />
            ) : null}
            <h2 className="text-sm font-semibold" style={SECTION_HEADER_STYLE}>
              Row Classification{isConfirmed ? ' (confirmed)' : ''}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={onRun} variant="outline" size="sm" disabled={isConfirming}>
              <ListChecks className="w-3.5 h-3.5 mr-1.5" aria-hidden />
              Re-run
            </Button>
            {!isConfirmed ? (
              <Button onClick={onConfirm} variant="default" size="sm" disabled={isConfirming}>
                {isConfirming ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Confirming…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Confirm & continue
                  </>
                )}
              </Button>
            ) : null}
          </div>
        </div>

        <p className="text-sm mb-3" style={LABEL_STYLE}>
          Classified <strong>{counts.total.toLocaleString()}</strong> row
          {counts.total === 1 ? '' : 's'} into the matching staging tables.
        </p>

        <div className="flex flex-wrap gap-2 mb-3">
          {counts.byEntity.contacts > 0 ? (
            <EntityChip label="Contacts" count={counts.byEntity.contacts} kind="contacts" />
          ) : null}
          {counts.byEntity.companies > 0 ? (
            <EntityChip label="Companies" count={counts.byEntity.companies} kind="companies" />
          ) : null}
          {counts.byEntity.deals > 0 ? (
            <EntityChip label="Deals" count={counts.byEntity.deals} kind="deals" />
          ) : null}
          {counts.byEntity.orders > 0 ? (
            <EntityChip label="Orders" count={counts.byEntity.orders} kind="orders" />
          ) : null}
          {counts.byEntity.skipped > 0 ? (
            <EntityChip label="Skipped" count={counts.byEntity.skipped} kind="skipped" />
          ) : null}
          {counts.byEntity.unknown > 0 ? (
            <EntityChip label="Unknown" count={counts.byEntity.unknown} kind="unknown" />
          ) : null}
        </div>

        <p className="text-xs" style={MUTED_STYLE}>
          {counts.bySource.heuristic.toLocaleString()} classified by rules ({heuristicPct}%)
          {counts.bySource.llm > 0
            ? ` · ${counts.bySource.llm.toLocaleString()} classified by AI (${llmPct}%)`
            : null}
        </p>

        {counts.lowConfidenceFlags > 0 ? (
          <div
            className="flex items-center gap-2 mt-3 text-xs px-3 py-1.5 rounded-md border"
            style={{
              backgroundColor: 'var(--ds-warning-soft)',
              color: 'var(--ds-warning-text)',
              borderColor: 'var(--ds-warning)',
            }}
          >
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
            <span>
              <strong>{counts.lowConfidenceFlags.toLocaleString()}</strong>{' '}
              row{counts.lowConfidenceFlags === 1 ? '' : 's'} flagged for review (low confidence)
            </span>
          </div>
        ) : null}

        {isConfirmed ? (
          <p
            className="text-xs mt-3"
            style={MUTED_STYLE}
            title={fmtDateTime(job.rowClassificationConfirmedAt)}
          >
            Confirmed {relativeTime(job.rowClassificationConfirmedAt)}
          </p>
        ) : null}

        <div className="text-xs mt-3 pt-3 border-t border-gray-100" style={MUTED_STYLE}>
          {job.rowClassificationLlmModel ? (
            <>
              Model: <span className="font-mono">{job.rowClassificationLlmModel}</span> ·{' '}
            </>
          ) : null}
          {inTok > 0 || outTok > 0
            ? `Tokens: ${inTok.toLocaleString()}+${outTok.toLocaleString()}`
            : 'No LLM calls (heuristic-only)'}
          {durationSec != null ? ` · Duration: ${durationSec}s` : null}
        </div>
      </section>
    );
  }

  // (b) Idle — never run.
  return (
    <section className="bg-white border rounded-lg p-6">
      <h2 className="text-sm font-semibold mb-2" style={SECTION_HEADER_STYLE}>
        Classify rows
      </h2>
      <p className="text-sm mb-4" style={LABEL_STYLE}>
        {isMixed
          ? "Your file contains multiple entity types. We'll classify each row and stage them into the matching staging table. Heuristic-based pre-classification keeps cost low (~$0.25 per 10K rows for mixed files)."
          : `We'll stage each row into the ${enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)} staging table for the next phase. Single-entity files use heuristic-only classification (free).`}
      </p>
      <Button onClick={onRun} variant="default">
        <ListChecks className="w-4 h-4 mr-1.5" aria-hidden /> Classify rows
      </Button>
    </section>
  );
}

// ─────────────────────────────────────────────
// KAN-911 — Duplicate Detection card subcomponent.
//
// Four states (mutually exclusive):
//   (a) idle      — never run AND no error → "Scan for duplicates" CTA
//   (b) running   — handled by the page on the duplicates sub-route; this
//                   card never shows a spinner (the mutation lives there).
//                   Here, dedupStartedAt without dedupCompletedAt would
//                   only appear briefly during a re-run on the parent page,
//                   which we don't support yet — so we render it as
//                   "scanning…" without a button.
//   (c) reviewed  — dedupCompletedAt populated, no confirmation yet →
//                   summary counts + "Review duplicates" CTA
//   (d) confirmed — dedupConfirmedAt populated → green check + summary +
//                   "Review again" (read-only) CTA
//   (e) error     — dedupError populated AND no dedupCompletedAt → red
//                   panel + Retry (link to /duplicates which shows the
//                   retry button)
// ─────────────────────────────────────────────

function DuplicateDetectionCard({ job }: { job: ImportJobDetail }) {
  const counts = job.dedupCounts;
  const isConfirmed = !!job.dedupConfirmedAt;
  const hasCompleted = !!job.dedupCompletedAt;
  const isRunning = !!job.dedupStartedAt && !hasCompleted && !job.dedupError;
  const hasError = !!job.dedupError && !hasCompleted;

  if (isRunning) {
    return (
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Duplicate Detection
        </h2>
        <div className="flex items-center gap-2 text-sm" style={LABEL_STYLE}>
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          Scanning for duplicates…
        </div>
      </section>
    );
  }

  // (e) Error.
  if (hasError) {
    return (
      <section className="bg-red-50 border border-red-200 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" aria-hidden />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-red-800">
              Duplicate Detection — Failed
            </h2>
            <p className="text-sm mt-1 text-red-700 whitespace-pre-wrap break-words">
              {job.dedupError}
            </p>
            <p
              className="text-xs mt-2"
              style={MUTED_STYLE}
              title={fmtDateTime(job.dedupErrorAt)}
            >
              Failed {relativeTime(job.dedupErrorAt)}
            </p>
            <div className="mt-3">
              <Link href={`/imports/${job.id}/duplicates`}>
                <Button variant="default">
                  <Scan className="w-4 h-4 mr-1.5" aria-hidden /> Retry
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // (c) + (d) — reviewed / confirmed.
  if (hasCompleted && counts) {
    const totalRows =
      counts.byEntity.contacts.total +
      counts.byEntity.companies.total +
      counts.byEntity.deals.total +
      counts.byEntity.orders.total;
    const totalNeedsReview =
      counts.byEntity.contacts.needsReview +
      counts.byEntity.companies.needsReview +
      counts.byEntity.deals.needsReview +
      counts.byEntity.orders.needsReview;
    const totalExact =
      counts.byEntity.contacts.exactMatches +
      counts.byEntity.companies.exactMatches +
      counts.byEntity.deals.exactMatches +
      counts.byEntity.orders.exactMatches;
    const totalFuzzy =
      counts.byEntity.contacts.fuzzyMatches +
      counts.byEntity.companies.fuzzyMatches +
      counts.byEntity.deals.fuzzyMatches +
      counts.byEntity.orders.fuzzyMatches;
    const totalInsert =
      counts.byEntity.contacts.insertOnly +
      counts.byEntity.companies.insertOnly +
      counts.byEntity.deals.insertOnly +
      counts.byEntity.orders.insertOnly;
    const candidatesScanned =
      counts.candidatesScanned.contacts +
      counts.candidatesScanned.companies +
      counts.candidatesScanned.deals +
      counts.candidatesScanned.orders;
    const startedMs = job.dedupStartedAt
      ? new Date(job.dedupStartedAt).getTime()
      : null;
    const completedMs = job.dedupCompletedAt
      ? new Date(job.dedupCompletedAt).getTime()
      : null;
    const durationSec =
      startedMs != null && completedMs != null
        ? ((completedMs - startedMs) / 1000).toFixed(1)
        : null;

    return (
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {isConfirmed ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600" aria-hidden />
            ) : null}
            <h2 className="text-sm font-semibold" style={SECTION_HEADER_STYLE}>
              Duplicate Detection{isConfirmed ? ' (confirmed)' : ''}
            </h2>
          </div>
          <Link href={`/imports/${job.id}/duplicates`}>
            <Button variant={isConfirmed ? 'outline' : 'default'} size="sm">
              <Scan className="w-3.5 h-3.5 mr-1.5" aria-hidden />
              {isConfirmed ? 'Review again' : 'Review duplicates'}
            </Button>
          </Link>
        </div>

        <p className="text-sm mb-3" style={LABEL_STYLE}>
          Scanned <strong>{totalRows.toLocaleString()}</strong> staged row
          {totalRows === 1 ? '' : 's'} against{' '}
          <strong>{candidatesScanned.toLocaleString()}</strong> existing record
          {candidatesScanned === 1 ? '' : 's'}.
        </p>

        <div className="flex flex-wrap gap-2 mb-3">
          {totalExact > 0 ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-sm font-medium rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
              <strong>{totalExact.toLocaleString()}</strong>
              <span>exact</span>
            </span>
          ) : null}
          {totalFuzzy > 0 ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-sm font-medium rounded-full border bg-amber-50 text-amber-700 border-amber-200">
              <strong>{totalFuzzy.toLocaleString()}</strong>
              <span>fuzzy</span>
            </span>
          ) : null}
          {totalNeedsReview > 0 ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-sm font-medium rounded-full border bg-orange-50 text-orange-700 border-orange-200">
              <strong>{totalNeedsReview.toLocaleString()}</strong>
              <span>need review</span>
            </span>
          ) : null}
          {totalInsert > 0 ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-sm font-medium rounded-full border bg-gray-100 text-gray-700 border-gray-200">
              <strong>{totalInsert.toLocaleString()}</strong>
              <span>insert as new</span>
            </span>
          ) : null}
        </div>

        {totalNeedsReview > 0 && !isConfirmed ? (
          <div
            className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-md border"
            style={{
              backgroundColor: 'var(--ds-warning-soft)',
              color: 'var(--ds-warning-text)',
              borderColor: 'var(--ds-warning)',
            }}
          >
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
            <span>
              <strong>{totalNeedsReview.toLocaleString()}</strong> row
              {totalNeedsReview === 1 ? '' : 's'} need an explicit decision before
              you can confirm.
            </span>
          </div>
        ) : null}

        {isConfirmed ? (
          <p
            className="text-xs mt-3"
            style={MUTED_STYLE}
            title={fmtDateTime(job.dedupConfirmedAt)}
          >
            Confirmed {relativeTime(job.dedupConfirmedAt)}
          </p>
        ) : null}

        <div className="text-xs mt-3 pt-3 border-t border-gray-100" style={MUTED_STYLE}>
          Rule-based + Levenshtein (no LLM)
          {durationSec != null ? ` · Duration: ${durationSec}s` : null}
        </div>
      </section>
    );
  }

  // (a) Idle.
  return (
    <section className="bg-white border rounded-lg p-6">
      <h2 className="text-sm font-semibold mb-2" style={SECTION_HEADER_STYLE}>
        Scan for duplicates
      </h2>
      <p className="text-sm mb-4" style={LABEL_STYLE}>
        Compare each staged row against your existing contacts, companies, deals,
        and orders to flag potential duplicates. Rule-based + fuzzy name matching,
        no AI — fully deterministic.
      </p>
      <Link href={`/imports/${job.id}/duplicates`}>
        <Button variant="default">
          <Scan className="w-4 h-4 mr-1.5" aria-hidden /> Scan for duplicates
        </Button>
      </Link>
    </section>
  );
}

// ─────────────────────────────────────────────
// KAN-913 — Commit card subcomponent (Card 7).
//
// State machine driven by `job.commitStatus`:
//   pending   — never run → "Commit N rows" CTA + entity-type
//               sub-counts pulled from rowClassificationCounts
//   running   — should be transient (sync commit blocks the tRPC
//               mutation thread); covered by the parent's isRunning
//               prop on the spinner
//   succeeded — green check + per-entity counts + links to canonical
//               tables
//   partial   — yellow warning + counts + Download Error CSV button +
//               Retry button (re-runs commit on remaining pending/ready
//               rows; KAN-913 V1 is best-effort idempotent)
//   failed    — red panel + error counts + Download Error CSV +
//               Retry button
// ─────────────────────────────────────────────

function CommitCard({
  job,
  isRunning,
  onRun,
}: {
  job: ImportJobDetail;
  isRunning: boolean;
  onRun: () => void;
}) {
  const status = job.commitStatus;
  const committed = job.committedRowCount;
  const failed = job.failedRowCount;
  const rowClassCounts = job.rowClassificationCounts;
  const expectedTotalRows = rowClassCounts
    ? rowClassCounts.byEntity.contacts +
      rowClassCounts.byEntity.companies +
      rowClassCounts.byEntity.deals +
      rowClassCounts.byEntity.orders
    : null;

  if (isRunning || status === 'running') {
    return (
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Commit
        </h2>
        <div className="flex items-center gap-2 text-sm" style={LABEL_STYLE}>
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          Writing rows to canonical tables…
          {expectedTotalRows != null ? (
            <span className="ml-1" style={MUTED_STYLE}>
              ({expectedTotalRows.toLocaleString()} expected)
            </span>
          ) : null}
        </div>
        <p className="text-xs mt-3" style={MUTED_STYLE}>
          Synchronous V1 — this may take up to 30-60s for 10K+ row files.
        </p>
      </section>
    );
  }

  if (status === 'succeeded') {
    return (
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" aria-hidden />
            <h2 className="text-sm font-semibold" style={SECTION_HEADER_STYLE}>
              Commit (succeeded)
            </h2>
          </div>
        </div>
        <p className="text-sm" style={LABEL_STYLE}>
          <strong>{committed.toLocaleString()}</strong> row
          {committed === 1 ? '' : 's'} written to your canonical tables.
        </p>
        <p
          className="text-xs mt-1"
          style={MUTED_STYLE}
          title={fmtDateTime(job.commitCompletedAt)}
        >
          Committed {relativeTime(job.commitCompletedAt)}
        </p>
        <div className="text-xs mt-3 pt-3 border-t border-gray-100" style={MUTED_STYLE}>
          AuditLog entries written · Pub/Sub fanout fired (env-flag gated)
        </div>
      </section>
    );
  }

  if (status === 'partial' || status === 'failed') {
    const tone =
      status === 'partial'
        ? { panel: 'bg-amber-50 border-amber-200', label: 'Commit (partial)' }
        : { panel: 'bg-red-50 border-red-200', label: 'Commit (failed)' };
    return (
      <section className={`${tone.panel} border rounded-lg p-6`}>
        <div className="flex items-start gap-3">
          <AlertTriangle
            className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
              status === 'partial' ? 'text-amber-700' : 'text-red-600'
            }`}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <h2
              className={`text-sm font-semibold ${
                status === 'partial' ? 'text-amber-900' : 'text-red-800'
              }`}
            >
              {tone.label}
            </h2>
            <p className="text-sm mt-1" style={LABEL_STYLE}>
              <strong>{committed.toLocaleString()}</strong> committed,{' '}
              <strong>{failed.toLocaleString()}</strong> failed.
            </p>
            <p
              className="text-xs mt-2"
              style={MUTED_STYLE}
              title={fmtDateTime(job.commitCompletedAt)}
            >
              Completed {relativeTime(job.commitCompletedAt)}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <CommitErrorCsvButton importJobId={job.id} disabled={failed === 0} />
              <Button onClick={onRun} variant="default" size="sm">
                <PlayCircle className="w-4 h-4 mr-1.5" aria-hidden /> Retry commit
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // status === 'pending' — ready to commit.
  return (
    <section className="bg-white border rounded-lg p-6">
      <h2 className="text-sm font-semibold mb-2" style={SECTION_HEADER_STYLE}>
        Commit to canonical tables
      </h2>
      <p className="text-sm mb-3" style={LABEL_STYLE}>
        Write the staged rows to your canonical Contact / Company / Deal /
        Order tables, honoring the duplicate-resolution decisions you confirmed.
        {expectedTotalRows != null ? (
          <>
            {' '}
            <strong>{expectedTotalRows.toLocaleString()}</strong> row
            {expectedTotalRows === 1 ? '' : 's'} ready.
          </>
        ) : null}
      </p>
      <p className="text-xs mb-4" style={MUTED_STYLE}>
        Sync write in V1 — the page will wait up to 30-60s on large files.
        Each row gets its own transaction (canonical insert + staging update +
        audit log all-or-nothing). Failed rows surface in the error CSV; they
        don't roll back successful siblings.
      </p>
      <Button onClick={onRun} variant="default">
        <PlayCircle className="w-4 h-4 mr-1.5" aria-hidden /> Commit{' '}
        {expectedTotalRows != null
          ? `${expectedTotalRows.toLocaleString()} row${expectedTotalRows === 1 ? '' : 's'}`
          : 'rows'}
      </Button>
    </section>
  );
}

// ─────────────────────────────────────────────
// KAN-913 — error CSV download button. Fetches commitErrors JSON on
// click, converts to CSV via the tRPC query (server-side papaparse),
// and triggers a browser Blob download. No GCS write involved.
// ─────────────────────────────────────────────

function CommitErrorCsvButton({
  importJobId,
  disabled,
}: {
  importJobId: string;
  disabled: boolean;
}) {
  const downloadMutation = useMutation<
    { csvContent: string; rowCount: number },
    Error,
    string
  >({
    mutationFn: (id) => importJobsApi.downloadCommitErrors(id),
    onSuccess: (data) => {
      if (data.rowCount === 0 || !data.csvContent) {
        toast.info('No commit errors to download.');
        return;
      }
      const blob = new Blob([data.csvContent], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `commit-errors-${importJobId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(
        `Downloaded ${data.rowCount} error row${data.rowCount === 1 ? '' : 's'}.`,
      );
    },
    onError: (err) => {
      toast.error(err.message || 'Download failed');
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || downloadMutation.isPending}
      onClick={() => downloadMutation.mutate(importJobId)}
    >
      {downloadMutation.isPending ? (
        <>
          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden />
          Generating CSV…
        </>
      ) : (
        <>
          <Download className="w-3.5 h-3.5 mr-1.5" aria-hidden /> Download error CSV
        </>
      )}
    </Button>
  );
}
