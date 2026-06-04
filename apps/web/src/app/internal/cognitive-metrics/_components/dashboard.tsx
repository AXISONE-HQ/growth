'use client';

/**
 * KAN-1087 — CognitiveMetricsDashboard — data orchestration.
 *
 * react-query + cognitiveMetricsApi wrapper (which delegates to PR I's
 * cognitiveMetrics.getMetrics tRPC procedure with adminProcedure server-side
 * gate). Manages window selection + manual refresh (cache invalidation +
 * server-side forceRefresh) + sparse-data badge + grid of 8 chart cards.
 *
 * Phase 1 Anchor 6: NULL bucket tooltip wrapped at TooltipProvider root.
 * Phase 1 Anchor 8: inline react-query states (loading skeleton + error
 * card); MetricCard provides skeleton built-in.
 */
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TooltipProvider } from '@radix-ui/react-tooltip';

import {
  cognitiveMetricsApi,
  windowToBounds,
  sparklineBucketForWindow,
  type WindowOption,
  type CognitiveMetricsResult,
} from '@/lib/cognitive-metrics-api';

import { DashboardHeader } from './dashboard-header';
import { SparseDataBadge } from './sparse-data-badge';
import { ErrorCard } from './error-card';
import { DecisionDistributionByPhaseChart } from './charts/decision-distribution-by-phase';
import { BrainConfidenceHistogram } from './charts/brain-confidence-histogram';
import { BrainSuggestedToneDistribution } from './charts/brain-suggested-tone-distribution';
import { GuardrailDeflectionByCategory } from './charts/guardrail-deflection-by-category';
import { MappingResolutionRate } from './charts/mapping-resolution-rate';
import { OperatorOverrideFrequency } from './charts/operator-override-frequency';
import { TokenUsageByActionType } from './charts/token-usage-by-action-type';
import { EngineActivitySparkline } from './charts/engine-activity-sparkline';

const QUERY_KEY = 'cognitiveMetrics';

export function CognitiveMetricsDashboard(): React.ReactElement {
  const [selectedWindow, setSelectedWindow] = React.useState<WindowOption>('7d');
  const [forceRefreshFlag, setForceRefreshFlag] = React.useState(0);

  const queryClient = useQueryClient();

  // Recompute window bounds on each render so the query keys reflect current
  // wall time. Refetching is gated on the queryKey hash, not the values.
  const bounds = React.useMemo(() => windowToBounds(selectedWindow), [selectedWindow, forceRefreshFlag]);
  const sparklineBucket = sparklineBucketForWindow(selectedWindow);

  const { data, isLoading, error, isFetching, refetch } = useQuery<CognitiveMetricsResult>({
    queryKey: [QUERY_KEY, selectedWindow, forceRefreshFlag],
    queryFn: () =>
      cognitiveMetricsApi.getMetrics({
        tenantId: null,
        windowStart: bounds.windowStart,
        windowEnd: bounds.windowEnd,
        forceRefresh: forceRefreshFlag > 0,
        sparklineBucket,
      }),
    staleTime: 60_000,
  });

  const handleRefresh = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
    setForceRefreshFlag((n) => n + 1);
  }, [queryClient]);

  const windowLabel = selectedWindow === '24h' ? 'last 24h' : selectedWindow === '7d' ? 'last 7 days' : 'last 30 days';

  if (error) {
    return (
      <TooltipProvider>
        <DashboardHeader
          selectedWindow={selectedWindow}
          onWindowChange={setSelectedWindow}
          generatedAt={null}
          cacheHit={null}
          isRefreshing={isFetching}
          onRefresh={handleRefresh}
        />
        <ErrorCard
          message={error instanceof Error ? error.message : 'Unknown error fetching cognitive metrics.'}
          onRetry={() => refetch()}
        />
      </TooltipProvider>
    );
  }

  const loading = isLoading || !data;

  return (
    <TooltipProvider>
      <DashboardHeader
        selectedWindow={selectedWindow}
        onWindowChange={setSelectedWindow}
        generatedAt={data?.generatedAt ?? null}
        cacheHit={data?.cacheHit ?? null}
        isRefreshing={isFetching}
        onRefresh={handleRefresh}
      />

      {data ? (
        <div className="mb-4">
          <SparseDataBadge totalTier1Rows={data.totalTier1Rows} windowLabel={windowLabel} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <DecisionDistributionByPhaseChart data={data?.decisionDistribution ?? []} loading={loading} />
        <BrainConfidenceHistogram data={data?.confidenceHistogram ?? []} loading={loading} />
        <BrainSuggestedToneDistribution data={data?.toneDistribution ?? []} loading={loading} />
        <GuardrailDeflectionByCategory data={data?.guardrailByCategory ?? []} loading={loading} />
        <MappingResolutionRate data={data?.mappingResolution ?? []} loading={loading} />
        <OperatorOverrideFrequency data={data?.operatorOverride ?? []} loading={loading} />
        <TokenUsageByActionType data={data?.tokenUsage ?? []} loading={loading} />
        <EngineActivitySparkline data={data?.activitySparkline ?? []} loading={loading} bucket={sparklineBucket} />
      </div>
    </TooltipProvider>
  );
}
