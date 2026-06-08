'use client';

/**
 * KAN-745 PR B — /settings/observability admin-only LLM cost dashboard.
 * KAN-990 Phase C.6 — restyled to light DS v1 tokens. Behavior preserved:
 * current-hour summary, 24h rollup table, threshold-breach indicator,
 * pricing-version + KAN-734 footnotes.
 *
 * Surfaces:
 *   - Current-hour stat cards: agentic / non-agentic / shadow_ratio
 *     (with threshold-breach indicator if > 2.5)
 *   - Rolling 24-hour per-prefix table
 *   - Pricing-version footnote (refresh discipline)
 *   - KAN-734 worker embedding + CSV column-mapping cost surfaced via the
 *     shared @growth/llm-cost-tracking package.
 *
 * Empty state: when no rollup rows exist, the cards show $0.00 and the
 * table renders the column header only with a directional "no LLM calls
 * in this window yet" note.
 */

import { useEffect, useState, useCallback } from 'react';
import { Activity, Loader2, RefreshCw, AlertTriangle, Info, Sparkles } from 'lucide-react';
import {
  observabilityApi,
  type ObservabilityCurrentHourSummary,
  type ObservabilityRollupRow,
} from '@/lib/api';
import { SectionCard } from '@/components/ui/detail-page-shell';

/**
 * USD-only formatter for LLM billing cost display.
 *
 * Precision-aware: 4 decimals sub-cent ($0.0042), 3 decimals sub-dollar
 * ($0.123), 2 decimals otherwise ($1.23). The precision tier matters for
 * sub-cent cost visibility — collapsing to 2 decimals would render every
 * small per-call cost as "$0.00" and lose the signal.
 *
 * Intentionally NOT tenant-currency-aware: LLM providers (OpenAI,
 * Anthropic, Google) bill in USD regardless of tenant locale. Audited
 * 2026-06-07 per KAN-1132 multi-currency epic — USD-lock is correct here.
 * MoneyDisplay / formatMoney aren't substitutable because they force
 * 2-decimal precision.
 */
function formatUsd(n: number): string {
  if (n === 0) return '$0.0000';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatRatio(r: number | null): string {
  if (r == null) return '—';
  if (!Number.isFinite(r)) return '∞ (no non-agentic baseline)';
  return `${r.toFixed(2)}×`;
}

function relativeHour(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const hr = Math.floor(ms / 3_600_000);
  if (hr < 1) return 'this hour';
  if (hr === 1) return '1h ago';
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h ago`;
}

const PREFIX_CHIP: Record<string, string> = {
  agentic: 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]',
  'agentic-tool': 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-700)]',
  'message-composer': 'bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]',
  'lead-assignment': 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning-text)]',
  recommendation: 'bg-[var(--ds-teal-100)] text-[var(--ds-teal-700)]',
  other: 'bg-[var(--ds-surface-sunken)] text-muted-foreground',
};

export default function ObservabilityPage() {
  const [summary, setSummary] = useState<ObservabilityCurrentHourSummary | null>(null);
  const [rollups, setRollups] = useState<ObservabilityRollupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const now = new Date();
      const fromHour = new Date(now.getTime() - 24 * 3_600_000);
      const toHour = new Date(now.getTime() + 3_600_000);
      const [s, r] = await Promise.all([
        observabilityApi.currentHour(),
        observabilityApi.list({ fromHour: fromHour.toISOString(), toHour: toHour.toISOString() }),
      ]);
      setSummary(s);
      setRollups(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rollupsByHour = new Map<string, ObservabilityRollupRow[]>();
  for (const r of rollups ?? []) {
    const key = r.hourBucket;
    const existing = rollupsByHour.get(key);
    if (existing) existing.push(r);
    else rollupsByHour.set(key, [r]);
  }
  const sortedHours = [...rollupsByHour.keys()].sort((a, b) => b.localeCompare(a));

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-h1 text-foreground">
            <Activity className="h-6 w-6 text-muted-foreground" />
            LLM cost observability
          </h1>
          <p className="mt-1 text-body text-muted-foreground">
            Per-tenant LLM call cost partitioned by source. Threshold breach fires when shadow
            ratio &gt; 2.5×.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-[var(--ds-radius-input)] px-3 py-1.5 text-body text-muted-foreground transition-colors hover:bg-[var(--ds-surface-sunken)] disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-[var(--ds-radius-input)] border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] p-3 text-body text-[var(--ds-danger-text)]">
          {error}
        </div>
      )}

      {summary === null && !error && (
        <div className="flex items-center gap-2 py-12 text-body text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading observability data…
        </div>
      )}

      {summary !== null && (
        <>
          {/* Top stat cards — current hour */}
          <div className="mb-6 grid grid-cols-3 gap-4">
            <div className="rounded-[var(--ds-radius-card)] border border-border bg-card px-5 py-4 shadow-[var(--ds-shadow-card)]">
              <div className="mb-1 text-caption text-muted-foreground">Agentic (current hour)</div>
              <div className="text-h1 text-[var(--ds-violet-500)]">{formatUsd(summary.agenticUsd)}</div>
              <div className="mt-1 text-micro text-muted-foreground">
                agentic + agentic-tool callerTags
              </div>
            </div>
            <div className="rounded-[var(--ds-radius-card)] border border-border bg-card px-5 py-4 shadow-[var(--ds-shadow-card)]">
              <div className="mb-1 text-caption text-muted-foreground">Non-agentic baseline</div>
              <div className="text-h1 text-[var(--ds-emerald-700)]">
                {formatUsd(summary.nonAgenticUsd)}
              </div>
              <div className="mt-1 text-micro text-muted-foreground">
                message-composer / lead-assignment / etc.
              </div>
            </div>
            <div
              className={`rounded-[var(--ds-radius-card)] border px-5 py-4 shadow-[var(--ds-shadow-card)] ${
                summary.breachThreshold
                  ? 'border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)]'
                  : 'border-border bg-card'
              }`}
            >
              <div className="mb-1 flex items-center gap-1 text-caption text-muted-foreground">
                Shadow ratio
                {summary.breachThreshold && (
                  <AlertTriangle className="h-3.5 w-3.5 text-[var(--ds-danger-text)]" />
                )}
              </div>
              <div
                className={`text-h1 ${
                  summary.breachThreshold ? 'text-[var(--ds-danger-text)]' : 'text-foreground'
                }`}
              >
                {formatRatio(summary.shadowRatio)}
              </div>
              <div className="mt-1 text-micro text-muted-foreground">
                threshold: 2.50× per 1-hour window
              </div>
            </div>
          </div>

          {/* Rolling 24-hour table */}
          <SectionCard
            title="Rolling 24-hour rollup"
            headerRight={<span className="text-micro text-muted-foreground">most recent first</span>}
          >
            {sortedHours.length === 0 ? (
              <div className="p-12 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-surface-sunken)]">
                  <Sparkles className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="mb-1 text-h3 text-foreground">
                  No LLM calls in this window yet
                </h3>
                <p className="mx-auto max-w-md text-body text-muted-foreground">
                  Once the agentic loop or message composer fires, per-hour rollups appear here.
                </p>
              </div>
            ) : (
              <table className="w-full text-body">
                <thead className="text-caption text-muted-foreground">
                  <tr>
                    <th className="px-1 pb-2 text-left font-medium">Hour</th>
                    <th className="pb-2 text-left font-medium">Source</th>
                    <th className="pb-2 text-right font-medium">Calls</th>
                    <th className="pb-2 text-right font-medium">Tokens (in/out)</th>
                    <th className="px-1 pb-2 text-right font-medium">Cost (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedHours.map((hour) => {
                    const rows = rollupsByHour.get(hour) ?? [];
                    return rows.map((row, idx) => {
                      const chip = PREFIX_CHIP[row.callerTagPrefix] ?? PREFIX_CHIP.other;
                      return (
                        <tr key={`${hour}-${row.callerTagPrefix}`} className="border-t border-border">
                          <td className="px-1 py-2.5 text-caption text-foreground">
                            {idx === 0 ? (
                              <>
                                {/* USER-tz display: `hour` is a DateTime instant (the
                                    UTC top-of-hour bucket label) — operator sees the
                                    bucket in their browser-local time, which matches
                                    their day/night reading expectation. KAN-943's
                                    off-by-one bug applies only to `@db.Date` sources.
                                    KAN-1131 PR 2 audit 2026-06-08. */}
                                <div>{new Date(hour).toLocaleString()}</div>
                                <div className="text-micro text-muted-foreground">
                                  {relativeHour(hour)}
                                </div>
                              </>
                            ) : null}
                          </td>
                          <td className="py-2.5">
                            <span className={`rounded-[var(--ds-radius-pill)] px-2 py-0.5 text-caption ${chip}`}>
                              {row.callerTagPrefix}
                            </span>
                          </td>
                          <td className="py-2.5 text-right text-foreground">{row.callCount}</td>
                          <td className="py-2.5 text-right text-caption text-muted-foreground">
                            {row.totalInputTokens.toLocaleString()} /{' '}
                            {row.totalOutputTokens.toLocaleString()}
                          </td>
                          <td className="px-1 py-2.5 text-right font-mono text-foreground">
                            {formatUsd(row.totalCostUsd)}
                          </td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            )}
          </SectionCard>

          {/* Footnotes */}
          <div className="mt-6 space-y-2">
            <div className="flex items-start gap-2 text-caption text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <p>
                Cost computed from MODEL_PRICING constant (
                <span className="font-mono">2026-04-29-v1</span>). Quarterly review per the
                pricing-refresh discipline.
              </p>
            </div>
            <div className="flex items-start gap-2 text-caption text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <p>
                KAN-734 (Sprint 5): worker embedding cost (model{' '}
                <span className="font-mono">text-embedding-3-small</span>, callerTag{' '}
                <span className="font-mono">knowledge-worker:embed</span>) and CSV column-mapping
                cost (callerTag <span className="font-mono">csv-import:column-mapping</span>) now
                emit through the shared{' '}
                <span className="font-mono">@growth/llm-cost-tracking</span> package and roll up
                into this dashboard.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
