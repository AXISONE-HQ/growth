'use client';

/**
 * KAN-911 — Ingestion Cohort 2.6. Duplicate-detection resolution page.
 *
 * Per-entity tabs (Contacts / Companies / Deals / Orders) — each tab
 * shows a table of staging rows with their MatchDecision (top 3
 * candidates + suggested action). Operator can override per-row action
 * via dropdown; Confirm & continue is blocked until every needs_review
 * row has an explicit override.
 *
 * Five high-level states:
 *   (a) gate — rowClassificationConfirmedAt is null (must confirm
 *       classification on the parent page first)
 *   (b) empty — dedupCompletedAt is null → big "Run duplicate detection" CTA
 *   (c) reviewing — dedupCompletedAt populated → tabs + table + Confirm
 *   (d) confirmed — dedupConfirmedAt populated → green check + read-only view
 *   (e) error — dedupError populated + no dedupCompletedAt → red panel + Retry
 *
 * Confirm & continue success → navigate back to /imports/[id] where Card 6
 * now shows confirmed state + the "Continue to staging" (PR 8) CTA.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Scan,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  importJobsApi,
  type DedupEntityType,
  type DedupMatchCandidate,
  type DedupMatchDecision,
  type DedupSignalName,
  type DedupStagingRow,
  type DedupSuggestedAction,
  type ImportJobDetail,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;
const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

const ENTITY_TABS: Array<{ key: DedupEntityType; label: string }> = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'companies', label: 'Companies' },
  { key: 'deals', label: 'Deals' },
  { key: 'orders', label: 'Orders' },
];

// Human labels for signal chips (decision F canonical signal names).
const SIGNAL_LABELS: Record<DedupSignalName, string> = {
  email_exact: 'email match',
  phone_exact: 'phone match',
  domain_exact: 'domain match',
  provider_order_id_exact: 'provider order ID match',
  order_number_exact: 'order # match',
  name_fuzzy: 'name similar',
  legal_name_fuzzy: 'legal name similar',
  close_date_window: 'close date ±30d',
  contact_email_exact: 'contact email match',
  placed_at_window: 'placed at ±24h',
};

const ACTION_LABELS: Record<DedupSuggestedAction, string> = {
  update: 'Update existing',
  needs_review: 'Needs review',
  insert: 'Insert new',
  skip: 'Skip',
};

export default function DuplicatesPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params?.id;

  const { data: job, isLoading, isError, error } = useQuery<ImportJobDetail>({
    queryKey: ['importJobs', 'get', id],
    queryFn: () => importJobsApi.get(id as string),
    enabled: !!id,
  });

  const [activeTab, setActiveTab] = useState<DedupEntityType>('contacts');

  useEffect(() => {
    if (job) document.title = `Review duplicates · ${job.fileName}`;
  }, [job]);

  const runDedupMutation = useMutation<ImportJobDetail, Error, string>({
    mutationFn: (importJobId) => importJobsApi.runDuplicateDetection(importJobId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['importJobs', 'get', id], updated);
      // Invalidate staging queries so tabs reflect the fresh decisions.
      void queryClient.invalidateQueries({
        queryKey: ['importJobs', 'staging', id],
      });
    },
    onError: (err) => {
      toast.error(err.message || 'Duplicate detection failed', {
        description: 'See the error panel for details.',
      });
      void queryClient.invalidateQueries({ queryKey: ['importJobs', 'get', id] });
    },
  });

  const confirmDedupMutation = useMutation<ImportJobDetail, Error, string>({
    mutationFn: (importJobId) => importJobsApi.confirmDuplicateResolution(importJobId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['importJobs', 'get', id], updated);
      toast.success('Duplicate resolution confirmed.');
      router.push(`/imports/${updated.id}`);
    },
    onError: (err) => {
      toast.error(err.message || 'Confirm failed');
    },
  });

  if (!id) return null;
  if (isLoading) return <DuplicatesSkeleton />;
  if (isError) {
    return <DuplicatesErrorPanel message={(error as Error)?.message ?? 'Unknown error'} />;
  }
  if (!job) return null;

  // (a) Gate: row classification must be confirmed first.
  if (!job.rowClassificationConfirmedAt) {
    return (
      <PageShell job={job}>
        <GateNotReady reason="Confirm row classification on the file detail page before reviewing duplicates." />
      </PageShell>
    );
  }

  // (e) Error state — only when no decisions exist AND error is set.
  const hasError = !!job.dedupError && !job.dedupCompletedAt;
  if (hasError) {
    return (
      <PageShell job={job}>
        <section className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold text-red-800">
                Duplicate detection failed
              </h2>
              <p className="text-sm mt-1 text-red-700 whitespace-pre-wrap break-words">
                {job.dedupError}
              </p>
              <div className="mt-3">
                <Button
                  onClick={() => runDedupMutation.mutate(job.id)}
                  disabled={runDedupMutation.isPending}
                  variant="default"
                >
                  {runDedupMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Retrying…
                    </>
                  ) : (
                    <>
                      <Scan className="w-4 h-4 mr-1.5" /> Retry
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </section>
      </PageShell>
    );
  }

  // (b) Empty — never run.
  if (!job.dedupCompletedAt) {
    return (
      <PageShell job={job}>
        <section className="bg-white border rounded-lg p-12 text-center">
          <Scan className="w-10 h-10 mx-auto text-violet-500" aria-hidden />
          <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
            Scan for duplicates
          </h2>
          <p className="text-sm mt-2 max-w-md mx-auto" style={LABEL_STYLE}>
            We'll compare each staged row against your existing contacts, companies,
            deals, and orders to flag potential duplicates. Rule-based + fuzzy name
            matching, no AI — fully deterministic, $0 cost.
          </p>
          <div className="mt-5">
            <Button
              onClick={() => runDedupMutation.mutate(job.id)}
              disabled={runDedupMutation.isPending}
              variant="default"
              size="lg"
            >
              {runDedupMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Scanning…
                </>
              ) : (
                <>
                  <Scan className="w-4 h-4 mr-2" /> Run duplicate detection
                </>
              )}
            </Button>
          </div>
        </section>
      </PageShell>
    );
  }

  // (c) + (d) — reviewing or confirmed. Render tabs + table.
  const isConfirmed = !!job.dedupConfirmedAt;
  const counts = job.dedupCounts;

  return (
    <PageShell job={job}>
      {isConfirmed ? (
        <div
          className="flex items-center gap-2 p-3 mb-4 rounded-md border bg-emerald-50 border-emerald-200 text-emerald-800 text-sm"
          role="status"
        >
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" aria-hidden />
          <span>
            Duplicate resolution confirmed. Continue to staging on the file detail page.
          </span>
        </div>
      ) : null}

      {/* Summary chips */}
      {counts ? (
        <section className="bg-white border rounded-lg p-4 mb-4">
          <div className="flex flex-wrap gap-3 text-xs" style={LABEL_STYLE}>
            {ENTITY_TABS.map((t) => {
              const c = counts.byEntity[t.key];
              if (c.total === 0) return null;
              return (
                <div
                  key={t.key}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-gray-200 bg-gray-50"
                >
                  <strong>{t.label}:</strong>
                  <span>{c.total.toLocaleString()} rows</span>
                  {c.exactMatches > 0 ? (
                    <span className="text-emerald-700">
                      · {c.exactMatches} exact
                    </span>
                  ) : null}
                  {c.fuzzyMatches > 0 ? (
                    <span className="text-amber-700">
                      · {c.fuzzyMatches} fuzzy
                    </span>
                  ) : null}
                  {c.needsReview > 0 ? (
                    <span className="text-orange-700">
                      · {c.needsReview} review
                    </span>
                  ) : null}
                  {c.insertOnly > 0 ? (
                    <span style={MUTED_STYLE}>
                      · {c.insertOnly} new
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Tabs */}
      <div className="flex items-center border-b border-gray-200 mb-4">
        {ENTITY_TABS.map((t) => {
          const c = counts?.byEntity[t.key];
          const total = c?.total ?? 0;
          const isActive = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-violet-500 text-violet-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
              {total > 0 ? (
                <span
                  className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-gray-100"
                  style={MUTED_STYLE}
                >
                  {total}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <EntityTab
        importJobId={job.id}
        entityType={activeTab}
        readOnly={isConfirmed}
      />

      {/* Sticky bottom action bar */}
      {!isConfirmed ? (
        <div
          className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-6 py-3 shadow-lg z-10"
        >
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
            <Button
              variant="outline"
              onClick={() => runDedupMutation.mutate(job.id)}
              disabled={runDedupMutation.isPending || confirmDedupMutation.isPending}
            >
              {runDedupMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Re-scanning…
                </>
              ) : (
                <>
                  <Scan className="w-4 h-4 mr-1.5" /> Re-run scan
                </>
              )}
            </Button>
            <div className="flex items-center gap-2">
              <Link href={`/imports/${job.id}`}>
                <Button variant="outline" disabled={confirmDedupMutation.isPending}>
                  Cancel
                </Button>
              </Link>
              <Button
                onClick={() => confirmDedupMutation.mutate(job.id)}
                disabled={confirmDedupMutation.isPending || runDedupMutation.isPending}
                variant="default"
              >
                {confirmDedupMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Confirming…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 mr-1.5" /> Confirm & continue
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}

// ─────────────────────────────────────────────
// Per-entity tab — fetches staging rows + renders the resolution table
// ─────────────────────────────────────────────

function EntityTab({
  importJobId,
  entityType,
  readOnly,
}: {
  importJobId: string;
  entityType: DedupEntityType;
  readOnly: boolean;
}) {
  const [filterAction, setFilterAction] = useState<DedupSuggestedAction | 'all'>(
    'all',
  );

  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ['importJobs', 'staging', importJobId, entityType],
    [importJobId, entityType],
  );

  const { data, isLoading } = useQuery<{
    rows: DedupStagingRow[];
    count: number;
  }>({
    queryKey,
    queryFn: () =>
      importJobsApi.getStagingForReview({ importJobId, entityType }),
  });

  const overrideMutation = useMutation<
    { ok: true },
    Error,
    {
      stagingId: string;
      newAction: DedupSuggestedAction;
      chosenCandidateId?: string;
    }
  >({
    mutationFn: (input) =>
      importJobsApi.overrideStagingDecision({
        ...input,
        entityType,
      }),
    onMutate: async (input) => {
      // Optimistic update — patch the row's matchDecision in-place.
      await queryClient.cancelQueries({ queryKey });
      const prev = queryClient.getQueryData<{
        rows: DedupStagingRow[];
        count: number;
      }>(queryKey);
      if (prev) {
        const next = {
          ...prev,
          rows: prev.rows.map((r) => {
            if (r.id !== input.stagingId) return r;
            const md = r.matchDecision ?? {
              candidates: [],
              suggestedAction: 'insert' as DedupSuggestedAction,
              confidence: 0,
              suggestedReason: '',
            };
            return {
              ...r,
              matchDecision: {
                ...md,
                userChoice: {
                  action: input.newAction,
                  chosenCandidateId: input.chosenCandidateId,
                  overriddenAt: new Date().toISOString(),
                },
              },
            };
          }),
        };
        queryClient.setQueryData(queryKey, next);
      }
      return { prev };
    },
    onError: (err, _input, ctx) => {
      const restore = (ctx as { prev?: unknown } | undefined)?.prev;
      if (restore) queryClient.setQueryData(queryKey, restore);
      toast.error(err.message || 'Override failed');
    },
  });

  if (isLoading) {
    return (
      <section className="bg-white border rounded-lg p-6">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  const rows = data?.rows ?? [];
  const filteredRows =
    filterAction === 'all'
      ? rows
      : rows.filter((r) => {
          const md = r.matchDecision;
          const action = md?.userChoice?.action ?? md?.suggestedAction;
          return action === filterAction;
        });

  if (rows.length === 0) {
    return (
      <section className="bg-white border rounded-lg p-12 text-center">
        <p className="text-sm" style={MUTED_STYLE}>
          No {entityType} were classified for this import.
        </p>
      </section>
    );
  }

  return (
    <>
      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-3 text-sm">
        <span style={MUTED_STYLE}>Filter:</span>
        <FilterChip
          label="All"
          count={rows.length}
          active={filterAction === 'all'}
          onClick={() => setFilterAction('all')}
        />
        {(['update', 'needs_review', 'insert', 'skip'] as DedupSuggestedAction[]).map(
          (a) => {
            const count = rows.filter((r) => {
              const md = r.matchDecision;
              const action = md?.userChoice?.action ?? md?.suggestedAction;
              return action === a;
            }).length;
            if (count === 0) return null;
            return (
              <FilterChip
                key={a}
                label={ACTION_LABELS[a]}
                count={count}
                active={filterAction === a}
                onClick={() => setFilterAction(a)}
              />
            );
          },
        )}
      </div>

      <section className="bg-white border rounded-lg overflow-hidden mb-20">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left" style={MUTED_STYLE}>
                <th className="px-4 py-3 font-medium uppercase tracking-wider text-xs w-12">
                  #
                </th>
                <th className="px-4 py-3 font-medium uppercase tracking-wider text-xs w-1/3">
                  Source row
                </th>
                <th className="px-4 py-3 font-medium uppercase tracking-wider text-xs w-1/3">
                  Top match
                </th>
                <th className="px-4 py-3 font-medium uppercase tracking-wider text-xs">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRows.map((row) => (
                <DedupRow
                  key={row.id}
                  row={row}
                  readOnly={readOnly}
                  onOverride={(newAction, chosenCandidateId) =>
                    overrideMutation.mutate({
                      stagingId: row.id,
                      newAction,
                      chosenCandidateId,
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
        active
          ? 'bg-violet-50 text-violet-700 border-violet-300'
          : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
      }`}
    >
      {label} <span className="ml-1 font-mono">{count}</span>
    </button>
  );
}

function DedupRow({
  row,
  readOnly,
  onOverride,
}: {
  row: DedupStagingRow;
  readOnly: boolean;
  onOverride: (
    newAction: DedupSuggestedAction,
    chosenCandidateId?: string,
  ) => void;
}) {
  const md = row.matchDecision;
  const effectiveAction =
    md?.userChoice?.action ?? md?.suggestedAction ?? 'insert';
  const effectiveCandidateId =
    md?.userChoice?.chosenCandidateId ??
    (md && md.candidates.length > 0 ? md.candidates[0]!.existingEntityId : undefined);
  const overridden = !!md?.userChoice;

  const isNeedsReview = md?.suggestedAction === 'needs_review' && !md?.userChoice;
  const topCandidate: DedupMatchCandidate | undefined = md?.candidates[0];

  const rowPreview = sourceRowPreview(row.sourceRowData);

  return (
    <tr className={isNeedsReview ? 'bg-amber-50' : ''}>
      <td className="px-4 py-3 align-top font-mono text-xs" style={MUTED_STYLE}>
        {row.sourceRowIndex}
      </td>
      <td className="px-4 py-3 align-top" style={LABEL_STYLE}>
        <div className="text-xs font-mono space-y-0.5">
          {rowPreview.map((line, i) => (
            <div key={i} className="truncate" title={line}>
              {line}
            </div>
          ))}
        </div>
      </td>
      <td className="px-4 py-3 align-top" style={LABEL_STYLE}>
        {topCandidate ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs" title={topCandidate.existingEntityId}>
                {topCandidate.existingEntityId.slice(0, 8)}…
              </span>
              <ConfidenceChip score={topCandidate.score} />
            </div>
            <div className="flex flex-wrap gap-1">
              {topCandidate.matchedFields.map((s) => (
                <SignalChip key={s} signal={s} />
              ))}
            </div>
            {md && md.candidates.length > 1 ? (
              <div className="text-xs" style={MUTED_STYLE}>
                + {md.candidates.length - 1} more candidate
                {md.candidates.length - 1 === 1 ? '' : 's'}
              </div>
            ) : null}
          </div>
        ) : (
          <span className="text-xs" style={MUTED_STYLE}>
            No matches — will be inserted as new.
          </span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        {readOnly ? (
          <div className="text-sm" style={LABEL_STYLE}>
            {ACTION_LABELS[effectiveAction]}
            {overridden ? (
              <span className="ml-1 text-xs" style={MUTED_STYLE}>
                (overridden)
              </span>
            ) : null}
          </div>
        ) : (
          <div className="space-y-1.5">
            <Select
              value={effectiveAction}
              onValueChange={(v) => {
                const newAction = v as DedupSuggestedAction;
                const chosen =
                  newAction === 'update' ? effectiveCandidateId : undefined;
                onOverride(newAction, chosen);
              }}
            >
              <SelectTrigger className="h-9 text-sm w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(['update', 'needs_review', 'insert', 'skip'] as DedupSuggestedAction[]).map(
                    (a) => (
                      <SelectItem
                        key={a}
                        value={a}
                        disabled={a === 'update' && !topCandidate}
                      >
                        {ACTION_LABELS[a]}
                      </SelectItem>
                    ),
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
            {overridden ? (
              <div className="text-xs" style={MUTED_STYLE}>
                Overridden
              </div>
            ) : isNeedsReview ? (
              <div className="flex items-center gap-1 text-xs text-amber-700">
                <AlertTriangle className="w-3 h-3" aria-hidden />
                Choose an action
              </div>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}

function SignalChip({ signal }: { signal: DedupSignalName }) {
  const label = SIGNAL_LABELS[signal] ?? signal;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-violet-50 text-violet-700 border border-violet-200">
      {label}
    </span>
  );
}

function ConfidenceChip({ score }: { score: number }) {
  let cls = 'bg-gray-100 text-gray-700 border-gray-200';
  if (score >= 95) cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (score >= 75) cls = 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-xs font-mono rounded border ${cls}`}
    >
      {score}%
    </span>
  );
}

function sourceRowPreview(
  data: Record<string, unknown> | null,
  max = 3,
): string[] {
  if (!data) return ['—'];
  const entries = Object.entries(data).slice(0, max);
  return entries.map(([k, v]) => {
    if (v === null || v === undefined || v === '') return `${k}: —`;
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    const trimmed = str.length > 60 ? `${str.slice(0, 60)}…` : str;
    return `${k}: ${trimmed}`;
  });
}

// ─────────────────────────────────────────────
// Shells / states
// ─────────────────────────────────────────────

function PageShell({
  job,
  children,
}: {
  job: ImportJobDetail;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8 pb-24">
      <Link
        href={`/imports/${job.id}`}
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-3"
      >
        <ArrowLeft className="w-4 h-4" /> Back to file
      </Link>
      <div className="mb-2 text-xs" style={MUTED_STYLE}>
        Imports / {job.fileName}
      </div>
      <h1 className="text-2xl font-semibold mb-1" style={SECTION_HEADER_STYLE}>
        Review duplicates
      </h1>
      <p className="text-sm mb-6" style={LABEL_STYLE}>
        For each staged row, we suggest whether to update an existing record, insert
        a new one, or flag for your review. You can override any suggestion before
        confirming.
      </p>
      {children}
    </div>
  );
}

function GateNotReady({ reason }: { reason: string }) {
  return (
    <section className="bg-white border rounded-lg p-12 text-center">
      <AlertTriangle className="w-10 h-10 mx-auto text-amber-500" aria-hidden />
      <h2 className="text-base font-semibold mt-3" style={SECTION_HEADER_STYLE}>
        Not ready for duplicate review
      </h2>
      <p className="text-sm mt-2 max-w-md mx-auto" style={LABEL_STYLE}>
        {reason}
      </p>
    </section>
  );
}

function DuplicatesSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-4">
      <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
      <div className="h-7 w-1/3 bg-gray-200 rounded animate-pulse" />
      <div className="h-4 w-1/2 bg-gray-100 rounded animate-pulse" />
      <div className="bg-white border rounded-lg p-6 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
        ))}
      </div>
    </div>
  );
}

function DuplicatesErrorPanel({ message }: { message: string }) {
  const isNotFound = /not found/i.test(message);
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="bg-white border rounded-lg p-12 text-center">
        <XCircle className="w-10 h-10 mx-auto text-red-500" aria-hidden />
        <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
          {isNotFound ? 'Import not found' : 'Failed to load import'}
        </h2>
        <p className="text-sm mt-1" style={MUTED_STYLE}>
          {message}
        </p>
        <div className="mt-4">
          <Link href="/imports">
            <Button variant="outline">Back to Imports</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
