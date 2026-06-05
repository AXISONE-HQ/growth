/**
 * KAN-1087 Chart 4 — Guardrail deflections by category (KAN-1083 surface).
 *
 * Horizontal bar — categories vary in length; horizontal reads better.
 */
import * as React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip } from 'recharts';
import { ChartCard } from './_chart-card';
import type { GuardrailCategoryRow } from '@/lib/cognitive-metrics-api';

export interface Props {
  data: GuardrailCategoryRow[];
  loading: boolean;
}

export function GuardrailDeflectionByCategory({ data, loading }: Props): React.ReactElement {
  const chartData = [...data].sort((a, b) => b.count - a.count);
  const total = chartData.reduce((sum, r) => sum + r.count, 0);

  return (
    <ChartCard title="Guardrail deflections by category" loading={loading} isEmpty={!loading && total === 0}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
          <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
          <YAxis type="category" dataKey="category" tick={{ fontSize: 11 }} width={130} />
          <RechartsTooltip />
          <Bar dataKey="count" fill="#EF4444" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
