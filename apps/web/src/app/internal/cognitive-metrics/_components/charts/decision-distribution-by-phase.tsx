/**
 * KAN-1087 Chart 1 — Decision distribution by EnginePhase.
 *
 * Recharts stacked bar: X = engine phase (including NULL), Y = count,
 * stack = brainActionType. Phase 1 Anchor 6: NULL bucket gets a Radix
 * Tooltip with the capability-description copy explaining legacy rows.
 */
import * as React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, Legend } from 'recharts';
import { Tooltip, TooltipTrigger, TooltipContent } from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import { ChartCard } from './_chart-card';
import type { DecisionDistributionRow } from '@/lib/cognitive-metrics-api';

export interface Props {
  data: DecisionDistributionRow[];
  loading: boolean;
}

const NULL_BUCKET_TOOLTIP =
  'Decisions made before engine-phase tracking was instrumented (2026-06-03) lack phase context. Shown for forensic continuity.';

interface PhaseRow {
  phase: string;
  isNullBucket: boolean;
  [actionType: string]: string | number | boolean;
}

function pivotByPhase(rows: DecisionDistributionRow[]): { rows: PhaseRow[]; actionTypes: string[] } {
  const phaseMap = new Map<string, PhaseRow>();
  const actionTypeSet = new Set<string>();
  for (const r of rows) {
    const phase = r.enginePhase ?? 'unknown';
    actionTypeSet.add(r.actionType);
    if (!phaseMap.has(phase)) {
      phaseMap.set(phase, { phase, isNullBucket: r.enginePhase === null });
    }
    phaseMap.get(phase)![r.actionType] = ((phaseMap.get(phase)![r.actionType] as number) ?? 0) + r.count;
  }
  return {
    rows: [...phaseMap.values()].sort((a, b) => a.phase.localeCompare(b.phase)),
    actionTypes: [...actionTypeSet].sort(),
  };
}

const COLORS = ['#7C3AED', '#10B981', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899', '#6B7280'];

export function DecisionDistributionByPhaseChart({ data, loading }: Props): React.ReactElement {
  const { rows, actionTypes } = React.useMemo(() => pivotByPhase(data), [data]);
  const hasNullBucket = rows.some((r) => r.isNullBucket);

  const subtitle = hasNullBucket ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 text-xs underline decoration-dotted">
          <Info className="h-3 w-3" />
          unknown phase
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={6}
        className="max-w-xs rounded-md border border-border bg-card p-2 text-xs shadow-md"
      >
        {NULL_BUCKET_TOOLTIP}
      </TooltipContent>
    </Tooltip>
  ) : undefined;

  return (
    <ChartCard
      title="Decisions by engine phase"
      loading={loading}
      isEmpty={!loading && rows.length === 0}
      subtitle={subtitle}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <XAxis dataKey="phase" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <RechartsTooltip />
          <Legend wrapperStyle={{ fontSize: '11px' }} />
          {actionTypes.map((at, idx) => (
            <Bar key={at} dataKey={at} stackId="actions" fill={COLORS[idx % COLORS.length]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
