/**
 * KAN-1087 Chart 8 — Engine activity sparkline.
 *
 * Time-series Recharts line over the Tier 1 IN list. Bucket comes from
 * the sparklineBucket field (hour for 24h window, day for 7d/30d).
 */
import * as React from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip } from 'recharts';
import { ChartCard } from './_chart-card';
import type { ActivitySparklinePoint, SparklineBucket } from '@/lib/cognitive-metrics-api';

export interface Props {
  data: ActivitySparklinePoint[];
  loading: boolean;
  bucket: SparklineBucket;
}

function formatBucketLabel(iso: string, bucket: SparklineBucket): string {
  const d = new Date(iso);
  if (bucket === 'hour') {
    return `${d.getUTCHours().toString().padStart(2, '0')}:00`;
  }
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function EngineActivitySparkline({ data, loading, bucket }: Props): React.ReactElement {
  const chartData = data.map((p) => ({
    label: formatBucketLabel(p.bucket, bucket),
    count: p.count,
  }));
  const total = chartData.reduce((sum, p) => sum + p.count, 0);

  return (
    <ChartCard
      title="Engine activity over time"
      loading={loading}
      isEmpty={!loading && total === 0}
      subtitle={<span>bucket: {bucket}</span>}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <RechartsTooltip />
          <Line type="monotone" dataKey="count" stroke="#7C3AED" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
