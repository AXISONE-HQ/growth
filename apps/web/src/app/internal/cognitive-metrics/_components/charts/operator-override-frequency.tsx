/**
 * KAN-1087 Chart 6 — Operator override frequency (manual vs engine).
 *
 * From sub_objective_gap_state.transitioned audit rows. Manual transitions
 * indicate operator override; engine transitions are auto-derivation.
 * Phase A (KAN-1042 PR A2) shipped the source field.
 */
import * as React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip as RechartsTooltip, Legend } from 'recharts';
import { ChartCard } from './_chart-card';
import type { OperatorOverrideRow } from '@/lib/cognitive-metrics-api';

export interface Props {
  data: OperatorOverrideRow[];
  loading: boolean;
}

const SOURCE_COLORS: Record<string, string> = {
  manual: '#7C3AED',
  engine: '#10B981',
};

export function OperatorOverrideFrequency({ data, loading }: Props): React.ReactElement {
  const total = data.reduce((sum, r) => sum + r.count, 0);

  return (
    <ChartCard
      title="Sub-objective transitions"
      loading={loading}
      isEmpty={!loading && total === 0}
      subtitle={<span>manual vs engine</span>}
    >
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <RechartsTooltip />
          <Legend wrapperStyle={{ fontSize: '11px' }} />
          <Pie data={data} dataKey="count" nameKey="source" outerRadius={55} label={false}>
            {data.map((entry, idx) => (
              <Cell key={`cell-${idx}`} fill={SOURCE_COLORS[entry.source] ?? '#6B7280'} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
