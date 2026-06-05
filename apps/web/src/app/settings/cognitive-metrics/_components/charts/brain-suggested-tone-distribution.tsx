/**
 * KAN-1087 Chart 3 — brainSuggestedTone distribution (pie).
 */
import * as React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip as RechartsTooltip, Legend } from 'recharts';
import { ChartCard } from './_chart-card';
import type { ToneDistributionRow } from '@/lib/cognitive-metrics-api';

export interface Props {
  data: ToneDistributionRow[];
  loading: boolean;
}

const COLORS = ['#7C3AED', '#10B981', '#F59E0B', '#3B82F6', '#EC4899', '#6B7280'];

export function BrainSuggestedToneDistribution({ data, loading }: Props): React.ReactElement {
  const chartData = data.map((r) => ({
    name: r.tone ?? '(none)',
    value: r.count,
  }));
  const total = chartData.reduce((sum, r) => sum + r.value, 0);

  return (
    <ChartCard title="Suggested tone distribution" loading={loading} isEmpty={!loading && total === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <RechartsTooltip />
          <Legend wrapperStyle={{ fontSize: '11px' }} />
          <Pie data={chartData} dataKey="value" nameKey="name" outerRadius={55} label={false}>
            {chartData.map((_, idx) => (
              <Cell key={`cell-${idx}`} fill={COLORS[idx % COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
