'use client';

/**
 * KAN-1140 Phase 3 PR 9c — Parse Rules dashboard component.
 *
 * Operator-facing rule authoring UI. Mirrors PR 7 ParserPatternsDashboard
 * pattern: list table + filter chips + detail drawer. Detail drawer
 * embeds RuleForm + SampleTestPanel + VersionHistory + StatusActions.
 *
 * State management: plain controlled state (Q9 lock; matches parse-arc
 * Settings sibling convention).
 *
 * # KAN-1166 fix-forward — URL param reading lives HERE, not in page.tsx
 *
 * `useSearchParams` was originally in page.tsx but caused a redirect-to-
 * home regression on initial load. In Next.js 14.2, `useSearchParams`
 * returns `null` during prerender; `.get()` on null throws and corrupts
 * the page render. Moving the hook into this dashboard component —
 * which mounts AFTER the page-level auth gate passes — sidesteps the
 * prerender-null window entirely.
 */
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import {
  parseRulesApi,
  type ParseRuleRow,
  type ParseRuleDetail,
  type ParseRuleStatus,
  type ParseRuleBody,
} from '@/lib/api';
import { RuleForm, createEmptyRuleBody } from './RuleForm';
import { SampleTestPanel } from './SampleTestPanel';
import { VersionHistory } from './VersionHistory';

type StatusFilter = ParseRuleStatus | 'all';

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  pending: 'Pending',
  active: 'Active',
  disabled: 'Disabled',
};
const STATUS_FILTER_ORDER: StatusFilter[] = ['all', 'pending', 'active', 'disabled'];

function StatusBadge({ status }: { status: ParseRuleStatus }) {
  const colors: Record<ParseRuleStatus, string> = {
    pending: 'bg-gray-100 text-gray-700',
    active: 'bg-green-100 text-green-800',
    disabled: 'bg-amber-100 text-amber-800',
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${colors[status]}`}
    >
      {status}
    </span>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function describeScope(rule: { fingerprintId: string | null; format: string | null; vendor: string | null }): string {
  if (rule.fingerprintId) return `Fingerprint: ${rule.fingerprintId.slice(0, 8)}…`;
  if (rule.format && rule.vendor) return `${rule.format} + ${rule.vendor}`;
  if (rule.format) return `Format: ${rule.format}`;
  if (rule.vendor) return `Vendor: ${rule.vendor}`;
  return 'Global (all inbounds)';
}

export function ParseRulesDashboard(): React.ReactElement {
  // Q-ADD-INLINE-CROSS-LINK — read URL query params from parse-fingerprints
  // cross-link. Hook lives in this component (which mounts AFTER the page
  // auth gate) to avoid Next.js 14.2 prerender-null window. searchParams
  // can be null during initial prerender; guard with optional chaining +
  // null-coalesce.
  const searchParams = useSearchParams();
  const createForFingerprintId = searchParams?.get('createForFingerprint') ?? null;
  const createForFormat = searchParams?.get('format') ?? null;
  const createForVendor = searchParams?.get('vendor') ?? null;

  const [rules, setRules] = React.useState<ParseRuleRow[] | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [selectedDetail, setSelectedDetail] = React.useState<ParseRuleDetail | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  // Pre-populated create state from URL query (Q-ADD-INLINE-CROSS-LINK).
  const [createPrefill] = React.useState<{
    fingerprintId: string | null;
    format: string | null;
    vendor: string | null;
  }>({
    fingerprintId: createForFingerprintId,
    format: createForFormat,
    vendor: createForVendor,
  });

  // Open create form automatically if URL params indicate a cross-link.
  React.useEffect(() => {
    if (createForFingerprintId || createForFormat || createForVendor) {
      setCreating(true);
    }
  }, [createForFingerprintId, createForFormat, createForVendor]);

  const reload = React.useCallback(async () => {
    try {
      const result = await parseRulesApi.list();
      setRules(result.rows);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to load rules');
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const handleSelectRule = React.useCallback(async (ruleId: string) => {
    setBusy(true);
    try {
      const detail = await parseRulesApi.getDetail(ruleId);
      setSelectedDetail(detail);
      setCreating(false);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to load rule detail');
    } finally {
      setBusy(false);
    }
  }, []);

  const closeDetail = React.useCallback(() => {
    setSelectedDetail(null);
    setCreating(false);
  }, []);

  const showToast = React.useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const handleCreate = React.useCallback(
    async (input: { label: string; body: ParseRuleBody; fingerprintId?: string; format?: string; vendor?: string }) => {
      setBusy(true);
      try {
        await parseRulesApi.create(input);
        await reload();
        setCreating(false);
        showToast('Rule created (status: pending). Activate to fire on inbounds.');
      } catch (err) {
        setError((err as Error)?.message ?? 'Failed to create rule');
      } finally {
        setBusy(false);
      }
    },
    [reload, showToast],
  );

  const handleUpdate = React.useCallback(
    async (ruleId: string, input: { label?: string; body?: ParseRuleBody }) => {
      setBusy(true);
      try {
        await parseRulesApi.update({ ruleId, ...input });
        await reload();
        // Refresh selected detail so previousVersion reflects the snapshot.
        const detail = await parseRulesApi.getDetail(ruleId);
        setSelectedDetail(detail);
        showToast('Rule saved. Previous version preserved (one snapshot retained).');
      } catch (err) {
        setError((err as Error)?.message ?? 'Failed to update rule');
      } finally {
        setBusy(false);
      }
    },
    [reload, showToast],
  );

  const handleDelete = React.useCallback(
    async (ruleId: string) => {
      if (!window.confirm('Delete this rule? This cannot be undone. The previous version snapshot will also be removed.')) {
        return;
      }
      setBusy(true);
      try {
        await parseRulesApi.delete(ruleId);
        await reload();
        setSelectedDetail(null);
        showToast('Rule deleted.');
      } catch (err) {
        setError((err as Error)?.message ?? 'Failed to delete rule');
      } finally {
        setBusy(false);
      }
    },
    [reload, showToast],
  );

  const handleActivate = React.useCallback(
    async (ruleId: string) => {
      // KAN-1158 cross-referenced confirmation per epic discipline.
      const confirmed = window.confirm(
        'Activate this rule?\n\n' +
          'This rule will execute on every matching inbound starting now. ' +
          'KAN-1158 budget verification ensures runtime safety (between-rules 250ms pipeline budget; safe-regex2 at create time). ' +
          'Continue?',
      );
      if (!confirmed) return;
      setBusy(true);
      try {
        await parseRulesApi.activate(ruleId);
        await reload();
        const detail = await parseRulesApi.getDetail(ruleId);
        setSelectedDetail(detail);
        showToast('Rule activated. Now firing on matching inbounds.');
      } catch (err) {
        setError((err as Error)?.message ?? 'Failed to activate rule');
      } finally {
        setBusy(false);
      }
    },
    [reload, showToast],
  );

  const handleDeactivate = React.useCallback(
    async (ruleId: string) => {
      // No-confirm per Q6 (low-risk transition).
      setBusy(true);
      try {
        await parseRulesApi.deactivate(ruleId);
        await reload();
        const detail = await parseRulesApi.getDetail(ruleId);
        setSelectedDetail(detail);
        showToast('Rule deactivated. No longer firing on inbounds.');
      } catch (err) {
        setError((err as Error)?.message ?? 'Failed to deactivate rule');
      } finally {
        setBusy(false);
      }
    },
    [reload, showToast],
  );

  const handleRestorePreviousVersion = React.useCallback(
    async (ruleId: string) => {
      const confirmed = window.confirm(
        'Restore the previous version of this rule?\n\n' +
          'The current body will be saved as the new "previous version" (restore is reversible). ' +
          'Continue?',
      );
      if (!confirmed) return;
      setBusy(true);
      try {
        await parseRulesApi.restorePreviousVersion(ruleId);
        const detail = await parseRulesApi.getDetail(ruleId);
        setSelectedDetail(detail);
        await reload();
        showToast('Previous version restored. Current body saved as new previous.');
      } catch (err) {
        setError((err as Error)?.message ?? 'Failed to restore previous version');
      } finally {
        setBusy(false);
      }
    },
    [reload, showToast],
  );

  // Status-filtered subset.
  const filteredRules = React.useMemo(() => {
    if (!rules) return [];
    if (statusFilter === 'all') return rules;
    return rules.filter((r) => r.status === statusFilter);
  }, [rules, statusFilter]);

  // Summary counts.
  const summary = React.useMemo(() => {
    const counts: Record<ParseRuleStatus, number> = { pending: 0, active: 0, disabled: 0 };
    rules?.forEach((r) => {
      counts[r.status]++;
    });
    return counts;
  }, [rules]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Parse Rules</h1>
        <p className="text-sm text-muted-foreground">
          Author tenant-specific extraction rules that fire before Haiku on inbound emails.
          Rules with <code>status=&apos;active&apos;</code> execute on every matching inbound;
          newly-created rules default to <code>pending</code> until you explicitly activate.
        </p>
      </header>

      {/* Summary card */}
      <div className="rounded border p-3 text-sm">
        <span className="font-medium">Active: {summary.active}</span>
        <span className="text-muted-foreground"> · Pending: {summary.pending}</span>
        <span className="text-muted-foreground"> · Disabled: {summary.disabled}</span>
        {' · '}
        <button
          type="button"
          onClick={() => {
            setSelectedDetail(null);
            setCreating(true);
          }}
          className="text-blue-700 underline"
        >
          + Create rule
        </button>
      </div>

      {error ? (
        <div className="rounded border border-red-400 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {toast ? (
        <div className="rounded border border-green-400 bg-green-50 px-3 py-2 text-sm text-green-800">
          {toast}
        </div>
      ) : null}

      {/* Filter chips */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Status:</span>
        {STATUS_FILTER_ORDER.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setStatusFilter(opt)}
            className={
              statusFilter === opt
                ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground'
                : 'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted'
            }
          >
            {STATUS_FILTER_LABELS[opt]}
          </button>
        ))}
      </div>

      {/* Rule list table */}
      {rules === null ? (
        <div className="text-sm text-muted-foreground">Loading rules…</div>
      ) : rules.length === 0 ? (
        <div className="rounded border border-dashed py-8 text-center text-sm text-muted-foreground">
          Create your first parse rule to start automating extraction.
        </div>
      ) : filteredRules.length === 0 ? (
        <div className="rounded border border-dashed py-8 text-center text-sm text-muted-foreground">
          No rules match this filter.
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="px-2 py-1">Label</th>
              <th className="px-2 py-1">Scope</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filteredRules.map((r) => (
              <tr
                key={r.id}
                className={`cursor-pointer border-b hover:bg-muted ${
                  selectedDetail?.id === r.id ? 'bg-blue-50' : ''
                }`}
                onClick={() => handleSelectRule(r.id)}
              >
                <td className="px-2 py-1 font-medium">{r.label}</td>
                <td className="px-2 py-1 text-muted-foreground">{describeScope(r)}</td>
                <td className="px-2 py-1">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-2 py-1 text-muted-foreground">{formatRelative(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Detail drawer (inline; non-modal — operator can still scan list) */}
      {creating ? (
        <div className="rounded-lg border-2 border-blue-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Create new rule</h2>
            <button
              type="button"
              onClick={closeDetail}
              className="text-sm text-muted-foreground underline"
            >
              Cancel
            </button>
          </div>
          <RuleForm
            mode="create"
            initialBody={createEmptyRuleBody()}
            initialLabel=""
            initialFingerprintId={createPrefill.fingerprintId}
            initialFormat={createPrefill.format}
            initialVendor={createPrefill.vendor}
            busy={busy}
            onSubmit={async ({ label, body, fingerprintId, format, vendor }) => {
              await handleCreate({ label, body, fingerprintId, format, vendor });
            }}
          />
        </div>
      ) : selectedDetail ? (
        <div className="rounded-lg border-2 border-blue-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">{selectedDetail.label}</h2>
              <p className="text-xs text-muted-foreground">
                {describeScope(selectedDetail)} · <StatusBadge status={selectedDetail.status} />
              </p>
            </div>
            <button
              type="button"
              onClick={closeDetail}
              className="text-sm text-muted-foreground underline"
            >
              Close
            </button>
          </div>

          {/* Status actions (context-sensitive per Q6) */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {selectedDetail.status === 'pending' || selectedDetail.status === 'disabled' ? (
              <button
                type="button"
                onClick={() => handleActivate(selectedDetail.id)}
                disabled={busy}
                className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {selectedDetail.status === 'pending' ? 'Activate' : 'Re-enable'}
              </button>
            ) : null}
            {selectedDetail.status === 'active' ? (
              <button
                type="button"
                onClick={() => handleDeactivate(selectedDetail.id)}
                disabled={busy}
                className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                Deactivate
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => handleDelete(selectedDetail.id)}
              disabled={busy}
              className="rounded border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          </div>

          {/* RuleForm in edit mode */}
          <RuleForm
            mode="edit"
            initialBody={selectedDetail.body}
            initialLabel={selectedDetail.label}
            initialFingerprintId={selectedDetail.fingerprintId}
            initialFormat={selectedDetail.format}
            initialVendor={selectedDetail.vendor}
            busy={busy}
            onSubmit={async ({ label, body }) => {
              await handleUpdate(selectedDetail.id, { label, body });
            }}
          />

          {/* Sample test panel */}
          <div className="mt-4 border-t pt-4">
            <h3 className="mb-2 text-sm font-semibold">Test rule against sample</h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Run the rule against a stored sample, pasted body, or recent inbox event. Tests the
              currently-displayed form state (not the saved version).
            </p>
            <SampleTestPanel currentBody={selectedDetail.body} fingerprintId={selectedDetail.fingerprintId} />
          </div>

          {/* Version history */}
          <div className="mt-4 border-t pt-4">
            <VersionHistory
              previousVersion={selectedDetail.previousVersion}
              onRestore={() => handleRestorePreviousVersion(selectedDetail.id)}
              busy={busy}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
