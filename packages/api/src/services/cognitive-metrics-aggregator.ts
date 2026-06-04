/**
 * KAN-1086 — Aggregation helpers for Tier 2 cognitive-quality dashboards.
 *
 * Builds aggregate metrics from audit_log rows shipped by:
 *   - Cluster II PR V (KAN-1067): decision_re_evaluated payload extensions
 *   - Cluster III PR II (KAN-1081): engine_phase_stage_mapped audit reason
 *   - KAN-1083: engine_guardrail.deflected audit reason
 *   - Phase A (KAN-1042 PR A2): sub_objective_gap_state.transitioned with source
 *
 * Strategy per Phase 1 Lock 1: query-time aggregation (no materialization in v1).
 * audit_log is 49MB / composite indexes (tenant_id, action_type) + (tenant_id,
 * created_at) already serve aggregation directly. Sub-millisecond at current
 * scale; Phase 2.5 escape-hatch fires when audit_log crosses ~1M rows or
 * dashboard p95 > 2s.
 *
 * Tenant scoping per Phase 1 Lock B (Anchor 5): tenantId is OPTIONAL — null
 * means cross-tenant aggregate (the super-admin default). Conditional tenant
 * filter via Prisma.sql fragment in raw queries; conditional spread in Prisma
 * groupBy/count for the Prisma-layer total-row count.
 *
 * IMPORT-ROW NOISE SENTINEL: 78% of audit_log rows are import.row.committed.*
 * (CSV import telemetry, not cognitive-engine signal). Every aggregator MUST
 * explicitly filter on TIER_1_ACTION_TYPES. The sentinel test in
 * cognitive-metrics-aggregator.test.ts fixtures both cohorts and asserts zero
 * contamination — see Phase 1 risk 1 acknowledgment.
 *
 * jsonb NULL normalization per Phase 1 risk 3: payload->>'key' returns SQL
 * NULL for both missing-key and JSON-null, and empty string for empty string.
 * normalizeJsonbNull() collapses all three "no value" cases to TS null so
 * NULL-bucket categorization is unambiguous downstream (per Lock 6 — legacy
 * decision_re_evaluated rows bucket under "Unknown phase").
 */
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import {
  cognitiveMetricsCache,
  buildCacheKey,
} from './cognitive-metrics-cache.js';

// ─────────────────────────────────────────────
// Tier 1 action_types (SENTINEL — must filter)
// ─────────────────────────────────────────────

/**
 * Tier 1 audit action_types that Tier 2 aggregations operate on. Every raw SQL
 * query in this module hard-codes the relevant subset of this list in its
 * WHERE clause. Adding a new Tier 1 audit reason requires extending this
 * constant AND adding a new aggregator function — Lock 1 from Phase 1 says
 * Tier 2 does NOT extend Tier 1 surface, so this list moves only when Tier 1
 * itself extends.
 */
export const TIER_1_ACTION_TYPES = [
  'decision_re_evaluated',
  'engine_phase.advanced',
  'engine_phase.advance_escalated',
  'engine_phase_stage_mapped',
  'engine_guardrail.deflected',
  'sub_objective_gap_state.transitioned',
] as const;

export type Tier1ActionType = (typeof TIER_1_ACTION_TYPES)[number];

// ─────────────────────────────────────────────
// Input + result types
// ─────────────────────────────────────────────

export interface AggregatorInput {
  /** null = cross-tenant aggregate (super-admin default per Phase 1 Lock B). */
  tenantId: string | null;
  windowStart: Date;
  windowEnd: Date;
}

export interface GetMetricsInput extends AggregatorInput {
  /** When true, bypass cache + force fresh fetch. Manual refresh button. */
  forceRefresh?: boolean;
  /** Sparkline time-bucket granularity. Defaults to 'day'. */
  sparklineBucket?: 'hour' | 'day';
}

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
// Helpers
// ─────────────────────────────────────────────

function tenantFilterSql(tenantId: string | null): Prisma.Sql {
  return tenantId != null ? Prisma.sql`AND tenant_id = ${tenantId}` : Prisma.empty;
}

/**
 * Collapse SQL-NULL, JSON-null, and empty-string to TS null. payload->>'key'
 * returns NULL for missing or JSON-null and '' for empty string — three "no
 * value" cases. Per Phase 1 risk 3, normalize them to one bucket downstream.
 */
function normalizeJsonbNull(value: string | null): string | null {
  if (value == null || value === '') return null;
  return value;
}

function toNumber(value: bigint | number | null): number {
  if (value == null) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

// ─────────────────────────────────────────────
// 1. Decision distribution by EnginePhase + brainActionType
// ─────────────────────────────────────────────

export async function getDecisionDistributionByEnginePhase(
  prisma: PrismaClient,
  input: AggregatorInput,
): Promise<DecisionDistributionRow[]> {
  const { tenantId, windowStart, windowEnd } = input;
  const rows = await prisma.$queryRaw<
    Array<{ engine_phase: string | null; action_type: string | null; count: bigint }>
  >`
    SELECT
      payload->>'currentEnginePhase' AS engine_phase,
      payload->>'brainActionType' AS action_type,
      COUNT(*)::bigint AS count
    FROM audit_log
    WHERE action_type = 'decision_re_evaluated'
      ${tenantFilterSql(tenantId)}
      AND created_at >= ${windowStart}
      AND created_at <= ${windowEnd}
    GROUP BY engine_phase, action_type
    ORDER BY count DESC
  `;
  return rows.map((r) => ({
    enginePhase: normalizeJsonbNull(r.engine_phase),
    actionType: r.action_type ?? 'unknown',
    count: toNumber(r.count),
  }));
}

// ─────────────────────────────────────────────
// 2. brainConfidence histogram (10 buckets, 0.0–1.0)
// ─────────────────────────────────────────────

export async function getBrainConfidenceDistribution(
  prisma: PrismaClient,
  input: AggregatorInput,
): Promise<ConfidenceHistogramBucket[]> {
  const { tenantId, windowStart, windowEnd } = input;
  const rows = await prisma.$queryRaw<
    Array<{ bucket: number; count: bigint }>
  >`
    SELECT
      LEAST(FLOOR((payload->>'brainConfidence')::float * 10), 9)::int AS bucket,
      COUNT(*)::bigint AS count
    FROM audit_log
    WHERE action_type = 'decision_re_evaluated'
      AND payload->>'brainConfidence' IS NOT NULL
      AND payload->>'brainConfidence' != ''
      ${tenantFilterSql(tenantId)}
      AND created_at >= ${windowStart}
      AND created_at <= ${windowEnd}
    GROUP BY bucket
    ORDER BY bucket
  `;

  const byBucket = new Map<number, number>();
  for (const r of rows) byBucket.set(Number(r.bucket), toNumber(r.count));

  const result: ConfidenceHistogramBucket[] = [];
  for (let i = 0; i < 10; i++) {
    result.push({
      bucketStart: i / 10,
      bucketEnd: (i + 1) / 10,
      count: byBucket.get(i) ?? 0,
    });
  }
  return result;
}

// ─────────────────────────────────────────────
// 3. brainSuggestedTone distribution
// ─────────────────────────────────────────────

export async function getBrainSuggestedToneDistribution(
  prisma: PrismaClient,
  input: AggregatorInput,
): Promise<ToneDistributionRow[]> {
  const { tenantId, windowStart, windowEnd } = input;
  const rows = await prisma.$queryRaw<
    Array<{ tone: string | null; count: bigint }>
  >`
    SELECT
      payload->>'brainSuggestedTone' AS tone,
      COUNT(*)::bigint AS count
    FROM audit_log
    WHERE action_type = 'decision_re_evaluated'
      ${tenantFilterSql(tenantId)}
      AND created_at >= ${windowStart}
      AND created_at <= ${windowEnd}
    GROUP BY tone
    ORDER BY count DESC
  `;
  return rows.map((r) => ({
    tone: normalizeJsonbNull(r.tone),
    count: toNumber(r.count),
  }));
}

// ─────────────────────────────────────────────
// 4. Guardrail deflections by category (KAN-1083)
// ─────────────────────────────────────────────

export async function getGuardrailDeflectionByCategory(
  prisma: PrismaClient,
  input: AggregatorInput,
): Promise<GuardrailCategoryRow[]> {
  const { tenantId, windowStart, windowEnd } = input;
  const rows = await prisma.$queryRaw<
    Array<{ category: string | null; count: bigint }>
  >`
    SELECT
      payload->>'guardrailCategory' AS category,
      COUNT(*)::bigint AS count
    FROM audit_log
    WHERE action_type = 'engine_guardrail.deflected'
      ${tenantFilterSql(tenantId)}
      AND created_at >= ${windowStart}
      AND created_at <= ${windowEnd}
    GROUP BY category
    ORDER BY count DESC
  `;
  return rows.map((r) => ({
    category: normalizeJsonbNull(r.category) ?? 'unknown',
    count: toNumber(r.count),
  }));
}

// ─────────────────────────────────────────────
// 5. Mapping resolution rate (Cluster III)
// ─────────────────────────────────────────────

export async function getMappingResolutionRate(
  prisma: PrismaClient,
  input: AggregatorInput,
): Promise<MappingResolutionRow[]> {
  const { tenantId, windowStart, windowEnd } = input;
  const rows = await prisma.$queryRaw<
    Array<{ source: string | null; count: bigint }>
  >`
    SELECT
      payload->>'mappingSource' AS source,
      COUNT(*)::bigint AS count
    FROM audit_log
    WHERE action_type = 'engine_phase_stage_mapped'
      ${tenantFilterSql(tenantId)}
      AND created_at >= ${windowStart}
      AND created_at <= ${windowEnd}
    GROUP BY source
    ORDER BY count DESC
  `;
  return rows.map((r) => ({
    source: normalizeJsonbNull(r.source),
    count: toNumber(r.count),
  }));
}

// ─────────────────────────────────────────────
// 6. Operator-override frequency (Phase A — manual vs engine)
// ─────────────────────────────────────────────

export async function getOperatorOverrideFrequency(
  prisma: PrismaClient,
  input: AggregatorInput,
): Promise<OperatorOverrideRow[]> {
  const { tenantId, windowStart, windowEnd } = input;
  const rows = await prisma.$queryRaw<
    Array<{ source: string | null; count: bigint }>
  >`
    SELECT
      payload->>'source' AS source,
      COUNT(*)::bigint AS count
    FROM audit_log
    WHERE action_type = 'sub_objective_gap_state.transitioned'
      ${tenantFilterSql(tenantId)}
      AND created_at >= ${windowStart}
      AND created_at <= ${windowEnd}
    GROUP BY source
    ORDER BY count DESC
  `;
  return rows.map((r) => ({
    source: normalizeJsonbNull(r.source) ?? 'unknown',
    count: toNumber(r.count),
  }));
}

// ─────────────────────────────────────────────
// 7. Token usage by brainActionType
// ─────────────────────────────────────────────

export async function getTokenUsageByActionType(
  prisma: PrismaClient,
  input: AggregatorInput,
): Promise<TokenUsageRow[]> {
  const { tenantId, windowStart, windowEnd } = input;
  const rows = await prisma.$queryRaw<
    Array<{
      brain_action_type: string | null;
      total_input_tokens: bigint | null;
      total_output_tokens: bigint | null;
      avg_input_tokens: number | null;
      avg_output_tokens: number | null;
      decision_count: bigint;
    }>
  >`
    SELECT
      payload->>'brainActionType' AS brain_action_type,
      SUM((payload->>'llmInputTokens')::bigint) AS total_input_tokens,
      SUM((payload->>'llmOutputTokens')::bigint) AS total_output_tokens,
      AVG((payload->>'llmInputTokens')::float) AS avg_input_tokens,
      AVG((payload->>'llmOutputTokens')::float) AS avg_output_tokens,
      COUNT(*)::bigint AS decision_count
    FROM audit_log
    WHERE action_type = 'decision_re_evaluated'
      AND payload->>'llmInputTokens' IS NOT NULL
      ${tenantFilterSql(tenantId)}
      AND created_at >= ${windowStart}
      AND created_at <= ${windowEnd}
    GROUP BY brain_action_type
    ORDER BY total_input_tokens DESC NULLS LAST
  `;
  return rows.map((r) => ({
    brainActionType: normalizeJsonbNull(r.brain_action_type),
    totalInputTokens: toNumber(r.total_input_tokens),
    totalOutputTokens: toNumber(r.total_output_tokens),
    avgInputTokens: r.avg_input_tokens ?? 0,
    avgOutputTokens: r.avg_output_tokens ?? 0,
    decisionCount: toNumber(r.decision_count),
  }));
}

// ─────────────────────────────────────────────
// 8. Engine-activity sparkline (time-bucketed Tier 1 counts)
// ─────────────────────────────────────────────

export async function getEngineActivitySparkline(
  prisma: PrismaClient,
  input: AggregatorInput,
  bucket: 'hour' | 'day' = 'day',
): Promise<ActivitySparklinePoint[]> {
  const { tenantId, windowStart, windowEnd } = input;
  const tier1List = Prisma.sql`(${Prisma.join(TIER_1_ACTION_TYPES.map((a) => Prisma.sql`${a}`))})`;
  const truncUnit = bucket === 'hour' ? Prisma.sql`'hour'` : Prisma.sql`'day'`;

  const rows = await prisma.$queryRaw<
    Array<{ bucket: Date; count: bigint }>
  >`
    SELECT
      DATE_TRUNC(${truncUnit}, created_at) AS bucket,
      COUNT(*)::bigint AS count
    FROM audit_log
    WHERE action_type IN ${tier1List}
      ${tenantFilterSql(tenantId)}
      AND created_at >= ${windowStart}
      AND created_at <= ${windowEnd}
    GROUP BY bucket
    ORDER BY bucket
  `;
  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    count: toNumber(r.count),
  }));
}

// ─────────────────────────────────────────────
// Orchestrator — runs all 8 in parallel + applies cache
// ─────────────────────────────────────────────

export async function getAllCognitiveMetrics(
  prisma: PrismaClient,
  input: GetMetricsInput,
): Promise<CognitiveMetricsResult> {
  const { tenantId, windowStart, windowEnd, forceRefresh, sparklineBucket } = input;
  const cacheKey = buildCacheKey({ tenantId, windowStart, windowEnd });

  if (forceRefresh) {
    cognitiveMetricsCache.delete(cacheKey);
  } else {
    const cached = cognitiveMetricsCache.get<CognitiveMetricsResult>(cacheKey);
    if (cached) {
      return { ...cached, cacheHit: true };
    }
  }

  const aggInput: AggregatorInput = { tenantId, windowStart, windowEnd };

  // totalTier1Rows uses Prisma findMany/count layer — exercises a DIFFERENT
  // code path from the raw SQL aggregators. Sentinel test verifies both
  // layers correctly exclude import.* noise per Phase 1 risk 1.
  const tier1CountPromise = prisma.auditLog.count({
    where: {
      actionType: { in: [...TIER_1_ACTION_TYPES] },
      ...(tenantId != null ? { tenantId } : {}),
      createdAt: { gte: windowStart, lte: windowEnd },
    },
  });

  const [
    decisionDistribution,
    confidenceHistogram,
    toneDistribution,
    guardrailByCategory,
    mappingResolution,
    operatorOverride,
    tokenUsage,
    activitySparkline,
    totalTier1Rows,
  ] = await Promise.all([
    getDecisionDistributionByEnginePhase(prisma, aggInput),
    getBrainConfidenceDistribution(prisma, aggInput),
    getBrainSuggestedToneDistribution(prisma, aggInput),
    getGuardrailDeflectionByCategory(prisma, aggInput),
    getMappingResolutionRate(prisma, aggInput),
    getOperatorOverrideFrequency(prisma, aggInput),
    getTokenUsageByActionType(prisma, aggInput),
    getEngineActivitySparkline(prisma, aggInput, sparklineBucket ?? 'day'),
    tier1CountPromise,
  ]);

  const result: CognitiveMetricsResult = {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    tenantId,
    generatedAt: new Date().toISOString(),
    cacheHit: false,
    totalTier1Rows,
    decisionDistribution,
    confidenceHistogram,
    toneDistribution,
    guardrailByCategory,
    mappingResolution,
    operatorOverride,
    tokenUsage,
    activitySparkline,
  };

  cognitiveMetricsCache.set(cacheKey, result);
  return result;
}
