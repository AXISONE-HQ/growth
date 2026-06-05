/**
 * KAN-1087 Chart 5 — Mapping resolution rate (Cluster III).
 *
 * Pie showing tenant_or_blueprint vs fallback distribution from
 * engine_phase_stage_mapped audit rows.
 */
import * as React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip as RechartsTooltip, Legend } from 'recharts';
import { ChartCard } from './_chart-card';
import type { MappingResolutionRow } from '@/lib/cognitive-metrics-api';

export interface Props {
  data: MappingResolutionRow[];
  loading: boolean;
}

const SOURCE_COLORS: Record<string, string> = {
  tenant_or_blueprint: '#10B981',
  fallback: '#F59E0B',
};

export function MappingResolutionRate({ data, loading }: Props): React.ReactElement {
  const chartData = data.map((r) => ({
    name: r.source ?? '(none)',
    value: r.count,
  }));
  const total = chartData.reduce((sum, r) => sum + r.value, 0);

  return (
    <ChartCard title="Stage mapping resolution" loading={loading} isEmpty={!loading && total === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <RechartsTooltip />
          <Legend wrapperStyle={{ fontSize: '11px' }} />
          <Pie data={chartData} dataKey="value" nameKey="name" outerRadius={55} label={false}>
            {chartData.map((entry, idx) => (
              <Cell key={`cell-${idx}`} fill={SOURCE_COLORS[entry.name] ?? '#6B7280'} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
