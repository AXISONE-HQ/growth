/**
 * KAN-1087 (Tier 2 PR II) — Type mirror + tRPC wrapper for cognitiveMetrics.getMetrics.
 *
 * Mirrors the response shape from
 * packages/api/src/services/cognitive-metrics-aggregator.ts:128 (CognitiveMetricsResult)
 * so apps/web has compile-time visibility without a packages/api path alias.
 *
 * Convention matches apps/web/src/lib/api.ts pattern (ContactListItem, CursorPage<T>
 * are similarly mirror-declared from their backend sources). Drift mitigation:
 * trivial because any packages/api shape change forces tsc on apps/api side first.
 */
import { trpcQuery } from './api';

// ─────────────────────────────────────────────
// Response shape (mirror)
// ─────────────────────────────────────────────

export interface DecisionDistributionRow {
  enginePhase: string | null;
  actionType: string;
  count: number;
}

export interface ConfidenceHistogramBucket {
  bucketStart: number;
  bucketEnd: number;
  count: number;
}

export interface ToneDistributionRow {
  tone: string | null;
  count: number;
}

export interface GuardrailCategoryRow {
  category: string;
  count: number;
}

export interface MappingResolutionRow {
  source: string | null;
  count: number;
}

export interface OperatorOverrideRow {
  source: string;
  count: number;
}

export interface TokenUsageRow {
  brainActionType: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  decisionCount: number;
}

export interface ActivitySparklinePoint {
  bucket: string;
  count: number;
}

export interface CognitiveMetricsResult {
  windowStart: string;
  windowEnd: string;
  tenantId: string | null;
  generatedAt: string;
  cacheHit: boolean;
  totalTier1Rows: number;

  decisionDistribution: DecisionDistributionRow[];
  confidenceHistogram: ConfidenceHistogramBucket[];
  toneDistribution: ToneDistributionRow[];
  guardrailByCategory: GuardrailCategoryRow[];
  mappingResolution: MappingResolutionRow[];
  operatorOverride: OperatorOverrideRow[];
  tokenUsage: TokenUsageRow[];
  activitySparkline: ActivitySparklinePoint[];
}

// ─────────────────────────────────────────────
// Request shape
// ─────────────────────────────────────────────

export type SparklineBucket = 'hour' | 'day';

export interface GetCognitiveMetricsInput {
  tenantId: string | null;
  windowStart: string;
  windowEnd: string;
  forceRefresh?: boolean;
  sparklineBucket?: SparklineBucket;
}

// ─────────────────────────────────────────────
// API wrapper
// ─────────────────────────────────────────────

export const cognitiveMetricsApi = {
  getMetrics: (input: GetCognitiveMetricsInput): Promise<CognitiveMetricsResult> =>
    trpcQuery<CognitiveMetricsResult>('cognitiveMetrics.getMetrics', input as unknown as Record<string, unknown>),
};

// ─────────────────────────────────────────────
// Window helpers
// ─────────────────────────────────────────────

export type WindowOption = '24h' | '7d' | '30d';

export function windowToBounds(option: WindowOption, now: Date = new Date()): {
  windowStart: string;
  windowEnd: string;
} {
  const windowEnd = now.toISOString();
  const startMs =
    option === '24h' ? now.getTime() - 24 * 60 * 60 * 1000 :
    option === '7d'  ? now.getTime() - 7 * 24 * 60 * 60 * 1000 :
                       now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return { windowStart: new Date(startMs).toISOString(), windowEnd };
}

export function sparklineBucketForWindow(option: WindowOption): SparklineBucket {
  return option === '24h' ? 'hour' : 'day';
}
