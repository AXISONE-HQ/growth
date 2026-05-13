'use client';

/**
 * KAN-901 — /imports/[id] ImportJob detail page (Ingestion Cohort 2.1b).
 * KAN-904 — adds Card 3 (AI Detection) between Inspection + Timestamps.
 * KAN-905 — adds Card 4 (Field Mapping) after AI Detection.
 *
 * 7 stacked cards consuming the `importJobs.get` response:
 *   1. File info       (always)
 *   2. Inspection      (only when status='inspected')
 *   3. AI Detection    (only when status='inspected'; 3-state) — KAN-904
 *   4. Field Mapping   (only when detectedEntityType supported; 4-state) — KAN-905
 *   5. Timestamps      (always)
 *   6. Error           (only when status='failed' — inspection-side)
 *   7. Next steps      (always — gated on mapping confirmation)
 *
 * NOT_FOUND state renders a friendly error per KAN-895 finding.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Columns3,
  FileSpreadsheet,
  FileText,
  Loader2,
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

      {/* Card 4 — Field Mapping (KAN-905) — only when detection complete */}
      {showInspection && job.detectedEntityType ? (
        <MappingCard job={job} />
      ) : null}

      {/* Card 5 — Timestamps */}
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
                . Complete column mapping (Card 4) before continuing to staging.
              </p>
              <Button disabled variant="outline" title="Complete and save column mapping first">
                Continue to staging
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm" style={LABEL_STYLE}>
                File classified as{' '}
                <strong>
                  {enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)}
                </strong>
                {' '}and column mappings are saved. The next phase — staging — ships in
                a later release.
              </p>
              <Button disabled variant="outline">
                Continue to staging (coming in next release)
              </Button>
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

  // (a) Unsupported entity (mixed / unknown).
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
