/**
 * KAN-1087 Chart 7 — Token usage by brainActionType (plain HTML table).
 *
 * Numerical surface; table renders cleaner than a chart for this density.
 */
import * as React from 'react';
import { ChartCard } from './_chart-card';
import type { TokenUsageRow } from '@/lib/cognitive-metrics-api';

export interface Props {
  data: TokenUsageRow[];
  loading: boolean;
}

export function TokenUsageByActionType({ data, loading }: Props): React.ReactElement {
  const rows = [...data].sort((a, b) => b.totalInputTokens - a.totalInputTokens);
  return (
    <ChartCard title="Token usage by action" loading={loading} isEmpty={!loading && rows.length === 0}>
      <div className="h-full overflow-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr style={{ color: 'var(--ds-ink-secondary)' }}>
              <th className="pb-1 font-medium">Action</th>
              <th className="pb-1 text-right font-medium">Calls</th>
              <th className="pb-1 text-right font-medium">In tokens</th>
              <th className="pb-1 text-right font-medium">Out tokens</th>
              <th className="pb-1 text-right font-medium">Avg in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.brainActionType ?? '(none)'} className="border-t border-border">
                <td className="py-1">{r.brainActionType ?? '(none)'}</td>
                <td className="py-1 text-right tabular-nums">{r.decisionCount.toLocaleString()}</td>
                <td className="py-1 text-right tabular-nums">{r.totalInputTokens.toLocaleString()}</td>
                <td className="py-1 text-right tabular-nums">{r.totalOutputTokens.toLocaleString()}</td>
                <td className="py-1 text-right tabular-nums">{Math.round(r.avgInputTokens).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
