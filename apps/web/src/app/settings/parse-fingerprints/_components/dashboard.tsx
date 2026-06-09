'use client';

/**
 * KAN-1140 Phase 3 PR 7 — Parser Patterns dashboard component.
 *
 * Renders a sortable + filterable table of `ParseFingerprintListItem`
 * rows + click-through to a detail drawer showing the 5 LRU samples
 * for the selected fingerprint.
 *
 * UI scope per Phase 1 Q5 lock: mirror the Cognitive Metrics tab
 * pattern (table + filter chips); NO histograms (counts surface as
 * raw integers in the row), NO threshold notifications (Q3 deferred
 * to KAN-1147), NO triggerType filter (PR 6 Q6 KAN-1144 follow-up).
 */
import * as React from 'react';
import {
  parserPatternsApi,
  type ParseFingerprintListItem,
  type ParseFingerprintDetail,
} from '@/lib/api';

type SortBy = 'lastSeenAt' | 'occurrenceCount' | 'escalationCount';

const SORT_LABELS: Record<SortBy, string> = {
  lastSeenAt: 'Most recent',
  occurrenceCount: 'Most common',
  escalationCount: 'Most escalated',
};

const SORT_OPTIONS: SortBy[] = ['lastSeenAt', 'occurrenceCount', 'escalationCount'];

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export function ParserPatternsDashboard(): React.ReactElement {
  const [items, setItems] = React.useState<ParseFingerprintListItem[] | null>(null);
  const [total, setTotal] = React.useState<number>(0);
  const [error, setError] = React.useState<string | null>(null);
  const [sortBy, setSortBy] = React.useState<SortBy>('lastSeenAt');
  const [formatFilter, setFormatFilter] = React.useState<string>('');
  const [languageFilter, setLanguageFilter] = React.useState<string>('');
  const [vendorFilter, setVendorFilter] = React.useState<string>('');
  const [showOnlyWithEscalations, setShowOnlyWithEscalations] = React.useState<boolean>(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<ParseFingerprintDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState<boolean>(false);

  const reload = React.useCallback(async () => {
    try {
      setError(null);
      const result = await parserPatternsApi.list({
        sortBy,
        limit: 50,
        offset: 0,
        formatFilter: formatFilter || undefined,
        languageFilter: languageFilter || undefined,
        vendorFilter: vendorFilter || undefined,
        showOnlyWithEscalations,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (e) {
      setError((e as Error).message);
      setItems([]);
      setTotal(0);
    }
  }, [sortBy, formatFilter, languageFilter, vendorFilter, showOnlyWithEscalations]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    parserPatternsApi
      .getDetail(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const list = items ?? [];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Parser patterns</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--ds-ink-secondary)' }}>
          Recurring inbound format signatures across your tenant. Patterns with
          high escalation counts indicate parser-confidence issues worth training
          a new extractor for. Patterns with high reclassify counts indicate
          operator-confirmed corrections that should feed future learning.
          {total > 0 ? ` (${total} unique patterns)` : null}
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded border px-3 py-2 text-sm"
          style={{
            background: 'var(--ds-danger-soft)',
            color: 'var(--ds-danger-text)',
          }}
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium">Sort by</label>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className="rounded border px-2 py-1 text-sm"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {SORT_LABELS[opt]}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Format filter (e.g. plain-text)"
          value={formatFilter}
          onChange={(e) => setFormatFilter(e.target.value)}
          className="rounded border px-2 py-1 text-sm"
        />
        <input
          type="text"
          placeholder="Language (e.g. en)"
          value={languageFilter}
          onChange={(e) => setLanguageFilter(e.target.value)}
          className="rounded border px-2 py-1 text-sm w-24"
        />
        <input
          type="text"
          placeholder="Vendor (e.g. formspree)"
          value={vendorFilter}
          onChange={(e) => setVendorFilter(e.target.value)}
          className="rounded border px-2 py-1 text-sm"
        />
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={showOnlyWithEscalations}
            onChange={(e) => setShowOnlyWithEscalations(e.target.checked)}
          />
          Only patterns with escalations
        </label>
      </div>

      <div className="flex gap-4">
        <div className="flex-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-1">Format</th>
                <th className="px-2 py-1">Language</th>
                <th className="px-2 py-1">Vendor</th>
                <th className="px-2 py-1 text-right">Seen</th>
                <th className="px-2 py-1 text-right">Escalations</th>
                <th className="px-2 py-1 text-right">Reclassified</th>
                <th className="px-2 py-1">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-4 text-center" style={{ color: 'var(--ds-ink-secondary)' }}>
                    No parser patterns yet. Patterns appear after the first
                    inbound lead lands through the webhook.
                  </td>
                </tr>
              ) : (
                list.map((fp) => (
                  <tr
                    key={fp.id}
                    onClick={() => setSelectedId(fp.id)}
                    className={`cursor-pointer border-b hover:bg-gray-50 ${
                      selectedId === fp.id ? 'bg-violet-50' : ''
                    }`}
                  >
                    <td className="px-2 py-1 font-mono">{fp.format}</td>
                    <td className="px-2 py-1 font-mono">{fp.language ?? '—'}</td>
                    <td className="px-2 py-1 font-mono">{fp.vendor ?? '—'}</td>
                    <td className="px-2 py-1 text-right">{fp.occurrenceCount}</td>
                    <td className="px-2 py-1 text-right">{fp.escalationCount}</td>
                    <td className="px-2 py-1 text-right">{fp.reclassifyCount}</td>
                    <td className="px-2 py-1">{formatRelative(fp.lastSeenAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {selectedId ? (
          <aside className="w-96 rounded border p-3 text-sm">
            <header className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Pattern detail</h2>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="text-xs underline"
              >
                Close
              </button>
            </header>
            {detailLoading ? (
              <p style={{ color: 'var(--ds-ink-secondary)' }}>Loading…</p>
            ) : detail ? (
              <div className="space-y-3">
                <div>
                  <div className="text-xs font-medium">Hashes (operator forensics)</div>
                  <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs">
                    <dt style={{ color: 'var(--ds-ink-secondary)' }}>structure</dt>
                    <dd className="font-mono">{detail.structureHash?.slice(0, 12) ?? '—'}</dd>
                    <dt style={{ color: 'var(--ds-ink-secondary)' }}>sender</dt>
                    <dd className="font-mono">{detail.senderDomainHash.slice(0, 12)}</dd>
                    <dt style={{ color: 'var(--ds-ink-secondary)' }}>labels</dt>
                    <dd className="font-mono">{detail.labelTokenHash?.slice(0, 12) ?? '—'}</dd>
                  </dl>
                </div>
                <div>
                  <div className="text-xs font-medium">Samples ({detail.samples.length})</div>
                  <div className="space-y-2">
                    {detail.samples.map((s) => (
                      <details key={s.id} className="rounded border p-2">
                        <summary className="cursor-pointer text-xs">
                          {s.senderDomain} · {formatRelative(s.capturedAt)}
                        </summary>
                        <pre
                          className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs"
                          style={{ color: 'var(--ds-ink-secondary)' }}
                        >
                          {s.bodyPreview}
                        </pre>
                      </details>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p style={{ color: 'var(--ds-ink-secondary)' }}>(no detail)</p>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
