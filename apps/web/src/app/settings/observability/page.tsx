'use client';

/**
 * KAN-745 PR B — /settings/observability admin-only LLM cost dashboard.
 *
 * Surfaces:
 *   - Current-hour stat cards: agentic / non-agentic / shadow_ratio
 *     (with threshold-breach indicator if > 2.5)
 *   - Rolling 24-hour per-prefix table
 *   - Pricing-version footnote (refresh discipline)
 *   - KAN-734 (Sprint 5) shipped: worker embedding cost + CSV column-mapping
 *     cost both flow through @growth/llm-cost-tracking → llm.call topic →
 *     LlmCostRollup, surfaced in this dashboard alongside apps/api LLM cost.
 *
 * Empty state: when no rollup rows exist (pre-traffic), the cards show
 * $0.00 and the table renders the column header only with a directional
 * "no LLM calls in this window yet" note.
 */

import { useEffect, useState, useCallback } from 'react';
import { Activity, Loader2, RefreshCw, AlertTriangle, Info, Sparkles } from 'lucide-react';
import {
  observabilityApi,
  type ObservabilityCurrentHourSummary,
  type ObservabilityRollupRow,
} from '@/lib/api';

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

const PREFIX_COLORS: Record<string, { bg: string; text: string }> = {
  agentic: { bg: 'bg-indigo-50', text: 'text-indigo-700' },
  'agentic-tool': { bg: 'bg-violet-50', text: 'text-violet-700' },
  'message-composer': { bg: 'bg-emerald-50', text: 'text-emerald-700' },
  'lead-assignment': { bg: 'bg-amber-50', text: 'text-amber-700' },
  recommendation: { bg: 'bg-blue-50', text: 'text-blue-700' },
  other: { bg: 'bg-gray-100', text: 'text-gray-600' },
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
      const fromHour = new Date(now.getTime() - 24 * 3_600_000); // 24h ago
      const toHour = new Date(now.getTime() + 3_600_000); // include current hour
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

  // Group rollups by hour for the table render
  const rollupsByHour = new Map<string, ObservabilityRollupRow[]>();
  for (const r of rollups ?? []) {
    const key = r.hourBucket;
    const existing = rollupsByHour.get(key);
    if (existing) existing.push(r);
    else rollupsByHour.set(key, [r]);
  }
  const sortedHours = [...rollupsByHour.keys()].sort((a, b) => b.localeCompare(a));

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <Activity className="w-6 h-6 text-gray-500" />
              LLM Cost Observability
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Per-tenant LLM call cost partitioned by source. Threshold breach fires when shadow ratio &gt; 2.5×.
            </p>
          </div>
          <button
            onClick={() => void reload()}
            disabled={loading}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {summary === null && !error && (
          <div className="flex items-center gap-2 text-gray-500 py-12">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading observability data…
          </div>
        )}

        {summary !== null && (
          <>
            {/* Top stat cards — current hour */}
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                <div className="text-xs text-gray-500 mb-1">Agentic (current hour)</div>
                <div className="text-2xl font-semibold text-indigo-700">
                  {formatUsd(summary.agenticUsd)}
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  agentic + agentic-tool callerTags
                </div>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                <div className="text-xs text-gray-500 mb-1">Non-agentic baseline</div>
                <div className="text-2xl font-semibold text-emerald-700">
                  {formatUsd(summary.nonAgenticUsd)}
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  message-composer / lead-assignment / etc.
                </div>
              </div>
              <div
                className={`border rounded-xl px-5 py-4 ${
                  summary.breachThreshold
                    ? 'bg-red-50 border-red-300'
                    : 'bg-white border-gray-200'
                }`}
              >
                <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                  Shadow ratio
                  {summary.breachThreshold && (
                    <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                  )}
                </div>
                <div
                  className={`text-2xl font-semibold ${
                    summary.breachThreshold ? 'text-red-700' : 'text-gray-900'
                  }`}
                >
                  {formatRatio(summary.shadowRatio)}
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  threshold: 2.50× per 1-hour window
                </div>
              </div>
            </div>

            {/* Rolling 24-hour table */}
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Rolling 24-hour rollup</h2>
                <span className="text-[11px] text-gray-400">most recent first</span>
              </div>

              {sortedHours.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
                    <Sparkles className="w-6 h-6 text-gray-400" />
                  </div>
                  <h3 className="text-base font-semibold text-gray-900 mb-1">
                    No LLM calls in this window yet
                  </h3>
                  <p className="text-sm text-gray-500 max-w-md mx-auto">
                    Once the agentic loop or message composer fires, per-hour
                    rollups appear here.
                  </p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="text-left px-5 py-2.5">Hour</th>
                      <th className="text-left px-3 py-2.5">Source</th>
                      <th className="text-right px-3 py-2.5">Calls</th>
                      <th className="text-right px-3 py-2.5">Tokens (in/out)</th>
                      <th className="text-right px-5 py-2.5">Cost (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedHours.map((hour) => {
                      const rows = rollupsByHour.get(hour) ?? [];
                      return rows.map((row, idx) => {
                        const c = PREFIX_COLORS[row.callerTagPrefix] ?? PREFIX_COLORS.other;
                        return (
                          <tr key={`${hour}-${row.callerTagPrefix}`} className="border-t border-gray-100">
                            <td className="px-5 py-2.5 text-gray-600 text-xs">
                              {idx === 0 ? (
                                <>
                                  <div>{new Date(hour).toLocaleString()}</div>
                                  <div className="text-[10px] text-gray-400">
                                    {relativeHour(hour)}
                                  </div>
                                </>
                              ) : null}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`text-[11px] px-2 py-0.5 rounded-full ${c.bg} ${c.text}`}>
                                {row.callerTagPrefix}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right text-gray-700">{row.callCount}</td>
                            <td className="px-3 py-2.5 text-right text-gray-500 text-xs">
                              {row.totalInputTokens.toLocaleString()} / {row.totalOutputTokens.toLocaleString()}
                            </td>
                            <td className="px-5 py-2.5 text-right font-mono text-gray-900">
                              {formatUsd(row.totalCostUsd)}
                            </td>
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footnotes */}
            <div className="mt-6 space-y-2">
              <div className="flex items-start gap-2 text-xs text-gray-500">
                <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <p>
                  Cost computed from MODEL_PRICING constant (
                  <span className="font-mono">2026-04-29-v1</span>). Quarterly review per
                  the pricing-refresh discipline.
                </p>
              </div>
              <div className="flex items-start gap-2 text-xs text-gray-500">
                <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <p>
                  KAN-734 (Sprint 5): worker embedding cost (model{' '}
                  <span className="font-mono">text-embedding-3-small</span>, callerTag{' '}
                  <span className="font-mono">knowledge-worker:embed</span>) and CSV
                  column-mapping cost (callerTag{' '}
                  <span className="font-mono">csv-import:column-mapping</span>) now
                  emit through the shared{' '}
                  <span className="font-mono">@growth/llm-cost-tracking</span> package
                  and roll up into this dashboard.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
