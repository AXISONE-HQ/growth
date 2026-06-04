/**
 * KAN-1087 Chart 2 — brainConfidence histogram (10 buckets 0.0–1.0).
 */
import * as React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, Cell } from 'recharts';
import { ChartCard } from './_chart-card';
import type { ConfidenceHistogramBucket } from '@/lib/cognitive-metrics-api';

export interface Props {
  data: ConfidenceHistogramBucket[];
  loading: boolean;
}

function colorFor(bucketStart: number): string {
  if (bucketStart < 0.3) return '#EF4444';
  if (bucketStart < 0.6) return '#F59E0B';
  if (bucketStart < 0.8) return '#3B82F6';
  return '#10B981';
}

export function BrainConfidenceHistogram({ data, loading }: Props): React.ReactElement {
  const chartData = data.map((b) => ({
    label: `${(b.bucketStart * 10).toFixed(0)}–${(b.bucketEnd * 10).toFixed(0)}`,
    count: b.count,
    bucketStart: b.bucketStart,
  }));
  const total = chartData.reduce((sum, b) => sum + b.count, 0);

  return (
    <ChartCard
      title="Brain confidence distribution"
      loading={loading}
      isEmpty={!loading && total === 0}
      subtitle={<span>buckets ×10</span>}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <RechartsTooltip />
          <Bar dataKey="count">
            {chartData.map((entry) => (
              <Cell key={`cell-${entry.label}`} fill={colorFor(entry.bucketStart)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
