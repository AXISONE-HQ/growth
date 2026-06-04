/**
 * KAN-1086 — Tier 2 cognitive-metrics aggregator tests.
 *
 * STRUCTURE:
 *   1. SENTINEL test — single most important test per Phase 1 discipline pin 3.
 *      Asserts every raw-SQL aggregator hard-codes the Tier 1 action_type
 *      filter, AND that the Prisma-layer totalTier1Rows count uses the
 *      actionType IN filter. Both layers fail loudly if drift occurs (per
 *      Fred's Phase 1 risk 1 acknowledgment: "exercise raw-SQL path AND the
 *      Prisma groupBy path so both fail loudly if drift occurs").
 *
 *   2. Per-aggregator happy-path tests — feed canned $queryRaw returns,
 *      verify shape transformations (bigint → number, null normalization,
 *      histogram bucket assembly).
 *
 *   3. jsonb null normalization — three "no value" cases per Phase 1 risk 3
 *      (missing key / JSON null / empty string) all collapse to TS null.
 *
 *   4. Orchestrator tests — cache hit / miss / forceRefresh + Promise.all
 *      execution.
 *
 * The mock $queryRaw captures every call's strings array; the sentinel test
 * inspects the joined SQL for required action_type literal. Per-aggregator
 * tests use call-indexed canned returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  TIER_1_ACTION_TYPES,
  getDecisionDistributionByEnginePhase,
  getBrainConfidenceDistribution,
  getBrainSuggestedToneDistribution,
  getGuardrailDeflectionByCategory,
  getMappingResolutionRate,
  getOperatorOverrideFrequency,
  getTokenUsageByActionType,
  getEngineActivitySparkline,
  getAllCognitiveMetrics,
} from '../cognitive-metrics-aggregator.js';
import { cognitiveMetricsCache } from '../cognitive-metrics-cache.js';

const TENANT = '9ca85088-f65b-4bac-b098-fff742281ede';
const WINDOW_START = new Date('2026-06-01T00:00:00Z');
const WINDOW_END = new Date('2026-06-30T23:59:59Z');
const AGG_INPUT = { tenantId: TENANT, windowStart: WINDOW_START, windowEnd: WINDOW_END };

interface QueryCall {
  joined: string;
  values: unknown[];
}

/**
 * Prisma.sql fragments + Prisma.join wrap interpolated values as Sql objects
 * with nested `.values`. Flatten the tree to a single array of leaf scalars
 * so test assertions can check for literal action_type strings regardless of
 * how deeply they were composed.
 */
function flattenSqlValues(value: unknown): unknown[] {
  if (value != null && typeof value === 'object' && 'values' in value && Array.isArray((value as { values: unknown[] }).values)) {
    return (value as { values: unknown[] }).values.flatMap(flattenSqlValues);
  }
  return [value];
}

/**
 * Pull the literal SQL text out of a Sql fragment (e.g., Prisma.sql`'day'`
 * exposes `.sql` = "'day'"). Returns null when value isn't a Sql object.
 */
function readSqlFragment(value: unknown): string | null {
  if (value != null && typeof value === 'object' && 'sql' in value) {
    return String((value as { sql: unknown }).sql);
  }
  return null;
}

function makePrismaMock(perCallReturns: unknown[]) {
  const calls: QueryCall[] = [];
  let callIndex = 0;
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ joined: strings.join('?'), values });
    const ret = perCallReturns[callIndex++];
    return ret ?? [];
  });
  const auditLogCount = vi.fn(async (_args: unknown) => 0);
  return {
    prisma: {
      $queryRaw,
      auditLog: { count: auditLogCount },
    } as never,
    calls,
    auditLogCountCalls: auditLogCount,
  };
}

// ─────────────────────────────────────────────
// 1. SENTINEL — load-bearing import-row noise filter
// ─────────────────────────────────────────────

describe('SENTINEL — import.row.committed.* rows MUST NOT contaminate aggregations', () => {
  it('every raw-SQL aggregator hard-codes the expected Tier 1 action_type filter', async () => {
    const { prisma, calls } = makePrismaMock([]);

    await getDecisionDistributionByEnginePhase(prisma, AGG_INPUT);
    await getBrainConfidenceDistribution(prisma, AGG_INPUT);
    await getBrainSuggestedToneDistribution(prisma, AGG_INPUT);
    await getGuardrailDeflectionByCategory(prisma, AGG_INPUT);
    await getMappingResolutionRate(prisma, AGG_INPUT);
    await getOperatorOverrideFrequency(prisma, AGG_INPUT);
    await getTokenUsageByActionType(prisma, AGG_INPUT);
    await getEngineActivitySparkline(prisma, AGG_INPUT);

    expect(calls).toHaveLength(8);

    // 1. decision_re_evaluated rows ONLY
    expect(calls[0].joined).toMatch(/action_type\s*=\s*'decision_re_evaluated'/);
    // 2. brainConfidence histogram → decision_re_evaluated
    expect(calls[1].joined).toMatch(/action_type\s*=\s*'decision_re_evaluated'/);
    // 3. brainSuggestedTone → decision_re_evaluated
    expect(calls[2].joined).toMatch(/action_type\s*=\s*'decision_re_evaluated'/);
    // 4. guardrail by category → engine_guardrail.deflected
    expect(calls[3].joined).toMatch(/action_type\s*=\s*'engine_guardrail\.deflected'/);
    // 5. mapping resolution → engine_phase_stage_mapped
    expect(calls[4].joined).toMatch(/action_type\s*=\s*'engine_phase_stage_mapped'/);
    // 6. operator override → sub_objective_gap_state.transitioned
    expect(calls[5].joined).toMatch(/action_type\s*=\s*'sub_objective_gap_state\.transitioned'/);
    // 7. token usage → decision_re_evaluated
    expect(calls[6].joined).toMatch(/action_type\s*=\s*'decision_re_evaluated'/);
    // 8. sparkline → action_type IN (...) Tier 1 list
    expect(calls[7].joined).toMatch(/action_type IN/);
    // sparkline values are Prisma.sql fragments; flatten to find action_type strings
    const sparklineValues = calls[7].values.flatMap(flattenSqlValues);
    for (const tier1 of TIER_1_ACTION_TYPES) {
      expect(sparklineValues).toContain(tier1);
    }

    // None of the queries reference import.row.committed.* literals
    for (const call of calls) {
      expect(call.joined).not.toContain('import.row.committed');
    }
  });

  it('SENTINEL — GROUP BY uses expressions, never SELECT aliases (PostgreSQL 42803 regression guard per KAN-1089)', async () => {
    const { prisma, calls } = makePrismaMock([]);

    await getDecisionDistributionByEnginePhase(prisma, AGG_INPUT);
    await getBrainConfidenceDistribution(prisma, AGG_INPUT);
    await getBrainSuggestedToneDistribution(prisma, AGG_INPUT);
    await getGuardrailDeflectionByCategory(prisma, AGG_INPUT);
    await getMappingResolutionRate(prisma, AGG_INPUT);
    await getOperatorOverrideFrequency(prisma, AGG_INPUT);
    await getTokenUsageByActionType(prisma, AGG_INPUT);
    await getEngineActivitySparkline(prisma, AGG_INPUT);

    // SELECT aliases that PostgreSQL rejects in GROUP BY: scan every query
    // for `GROUP BY <bare_alias>` patterns. Allowed forms: expression-based
    // (`GROUP BY payload->>'X'`), function calls (`GROUP BY DATE_TRUNC(...)`),
    // cast results (`GROUP BY LEAST(...)::int`).
    //
    // Bug class root-cause: Prisma rewraps $queryRaw output in a subquery
    // for some shapes which loses the outer SELECT's alias scope; safest
    // discipline is to never reference SELECT aliases in GROUP BY at all.
    const FORBIDDEN_ALIAS_PATTERNS = [
      /GROUP BY engine_phase\b/i,
      /GROUP BY action_type\b/i,
      /GROUP BY bucket\b/i,
      /GROUP BY tone\b/i,
      /GROUP BY category\b/i,
      /GROUP BY source\b/i,
      /GROUP BY brain_action_type\b/i,
    ];

    for (const call of calls) {
      for (const pattern of FORBIDDEN_ALIAS_PATTERNS) {
        expect(call.joined).not.toMatch(pattern);
      }
      // Positive assertion: every GROUP BY clause uses an expression
      // (payload->> jsonb projection, DATE_TRUNC, or LEAST/FLOOR cast).
      const groupByMatches = call.joined.match(/GROUP BY ([^\n]+)/g) ?? [];
      for (const gb of groupByMatches) {
        const isExpressionBased =
          gb.includes("payload->>'") ||
          gb.includes('DATE_TRUNC') ||
          gb.includes('LEAST(') ||
          gb.includes('FLOOR(');
        expect(isExpressionBased).toBe(true);
      }
    }
  });

  it('orchestrator Prisma-layer totalTier1Rows count uses actionType IN filter', async () => {
    cognitiveMetricsCache.clear();
    const { prisma, auditLogCountCalls } = makePrismaMock(
      // 8 canned $queryRaw returns (empty arrays — orchestrator test only verifies the count call)
      Array.from({ length: 8 }, () => []),
    );

    await getAllCognitiveMetrics(prisma, AGG_INPUT);

    expect(auditLogCountCalls).toHaveBeenCalledTimes(1);
    const [{ where }] = auditLogCountCalls.mock.calls[0] as [
      { where: { actionType: { in: string[] }; tenantId?: string; createdAt: unknown } },
    ];
    expect(where.actionType.in).toEqual([...TIER_1_ACTION_TYPES]);
    expect(where.tenantId).toBe(TENANT);
    expect(where).toHaveProperty('createdAt');
  });

  it('cross-tenant query (null tenantId) omits tenantId from Prisma where clause', async () => {
    cognitiveMetricsCache.clear();
    const { prisma, auditLogCountCalls } = makePrismaMock(
      Array.from({ length: 8 }, () => []),
    );

    await getAllCognitiveMetrics(prisma, {
      tenantId: null,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    const [{ where }] = auditLogCountCalls.mock.calls[0] as [
      { where: { actionType: { in: string[] }; tenantId?: string } },
    ];
    expect(where.actionType.in).toEqual([...TIER_1_ACTION_TYPES]);
    expect(where).not.toHaveProperty('tenantId');
  });
});

// ─────────────────────────────────────────────
// 2. Per-aggregator happy-path tests
// ─────────────────────────────────────────────

describe('getDecisionDistributionByEnginePhase', () => {
  it('groups by currentEnginePhase + brainActionType + normalizes nulls', async () => {
    const { prisma } = makePrismaMock([
      [
        { engine_phase: 'qualify', action_type: 'send_follow_up', count: 5n },
        { engine_phase: null, action_type: 'transition_sub_objective', count: 11n },
        { engine_phase: '', action_type: 'escalate_to_human', count: 2n },
      ],
    ]);

    const result = await getDecisionDistributionByEnginePhase(prisma, AGG_INPUT);

    expect(result).toEqual([
      { enginePhase: 'qualify', actionType: 'send_follow_up', count: 5 },
      { enginePhase: null, actionType: 'transition_sub_objective', count: 11 },
      { enginePhase: null, actionType: 'escalate_to_human', count: 2 },
    ]);
  });
});

describe('getBrainConfidenceDistribution', () => {
  it('builds 10 buckets with zeros where no data, maps positive-confidence rows correctly', async () => {
    const { prisma } = makePrismaMock([
      [
        { bucket: 8, count: 3n },
        { bucket: 9, count: 7n },
        { bucket: 5, count: 1n },
      ],
    ]);

    const result = await getBrainConfidenceDistribution(prisma, AGG_INPUT);

    expect(result).toHaveLength(10);
    expect(result[0]).toEqual({ bucketStart: 0.0, bucketEnd: 0.1, count: 0 });
    expect(result[5]).toEqual({ bucketStart: 0.5, bucketEnd: 0.6, count: 1 });
    expect(result[8]).toEqual({ bucketStart: 0.8, bucketEnd: 0.9, count: 3 });
    expect(result[9]).toEqual({ bucketStart: 0.9, bucketEnd: 1.0, count: 7 });
  });
});

describe('getBrainSuggestedToneDistribution', () => {
  it('groups by tone + normalizes null/empty-string to null', async () => {
    const { prisma } = makePrismaMock([
      [
        { tone: 'professional', count: 4n },
        { tone: 'curious', count: 2n },
        { tone: null, count: 9n },
        { tone: '', count: 1n },
      ],
    ]);

    const result = await getBrainSuggestedToneDistribution(prisma, AGG_INPUT);

    expect(result).toEqual([
      { tone: 'professional', count: 4 },
      { tone: 'curious', count: 2 },
      { tone: null, count: 9 },
      { tone: null, count: 1 },
    ]);
  });
});

describe('getGuardrailDeflectionByCategory', () => {
  it('groups by guardrailCategory + normalizes null/empty to "unknown"', async () => {
    const { prisma } = makePrismaMock([
      [
        { category: 'politics', count: 1n },
        { category: 'regulated_advice', count: 2n },
        { category: null, count: 1n },
      ],
    ]);

    const result = await getGuardrailDeflectionByCategory(prisma, AGG_INPUT);

    expect(result).toEqual([
      { category: 'politics', count: 1 },
      { category: 'regulated_advice', count: 2 },
      { category: 'unknown', count: 1 },
    ]);
  });
});

describe('getMappingResolutionRate', () => {
  it('groups by mappingSource', async () => {
    const { prisma } = makePrismaMock([
      [
        { source: 'tenant_or_blueprint', count: 8n },
        { source: 'fallback', count: 3n },
      ],
    ]);

    const result = await getMappingResolutionRate(prisma, AGG_INPUT);

    expect(result).toEqual([
      { source: 'tenant_or_blueprint', count: 8 },
      { source: 'fallback', count: 3 },
    ]);
  });
});

describe('getOperatorOverrideFrequency', () => {
  it('groups by source (manual vs engine) + normalizes null to unknown', async () => {
    const { prisma } = makePrismaMock([
      [
        { source: 'manual', count: 3n },
        { source: 'engine', count: 1n },
        { source: null, count: 1n },
      ],
    ]);

    const result = await getOperatorOverrideFrequency(prisma, AGG_INPUT);

    expect(result).toEqual([
      { source: 'manual', count: 3 },
      { source: 'engine', count: 1 },
      { source: 'unknown', count: 1 },
    ]);
  });
});

describe('getTokenUsageByActionType', () => {
  it('groups by brainActionType + sums input/output tokens + computes averages', async () => {
    const { prisma } = makePrismaMock([
      [
        {
          brain_action_type: 'send_follow_up',
          total_input_tokens: 1724n,
          total_output_tokens: 175n,
          avg_input_tokens: 1724,
          avg_output_tokens: 175,
          decision_count: 1n,
        },
        {
          brain_action_type: 'transition_sub_objective',
          total_input_tokens: 6000n,
          total_output_tokens: 700n,
          avg_input_tokens: 1500,
          avg_output_tokens: 175,
          decision_count: 4n,
        },
      ],
    ]);

    const result = await getTokenUsageByActionType(prisma, AGG_INPUT);

    expect(result).toEqual([
      {
        brainActionType: 'send_follow_up',
        totalInputTokens: 1724,
        totalOutputTokens: 175,
        avgInputTokens: 1724,
        avgOutputTokens: 175,
        decisionCount: 1,
      },
      {
        brainActionType: 'transition_sub_objective',
        totalInputTokens: 6000,
        totalOutputTokens: 700,
        avgInputTokens: 1500,
        avgOutputTokens: 175,
        decisionCount: 4,
      },
    ]);
  });
});

describe('getEngineActivitySparkline', () => {
  it('time-buckets Tier 1 activity', async () => {
    const { prisma, calls } = makePrismaMock([
      [
        { bucket: new Date('2026-06-01T00:00:00Z'), count: 2n },
        { bucket: new Date('2026-06-02T00:00:00Z'), count: 5n },
      ],
    ]);

    const result = await getEngineActivitySparkline(prisma, AGG_INPUT, 'day');

    expect(result).toEqual([
      { bucket: '2026-06-01T00:00:00.000Z', count: 2 },
      { bucket: '2026-06-02T00:00:00.000Z', count: 5 },
    ]);
    // truncUnit is a Prisma.sql fragment with literal "'day'"
    expect(readSqlFragment(calls[0].values[0])).toBe("'day'");
  });

  it('accepts hour bucket option', async () => {
    const { prisma, calls } = makePrismaMock([[{ bucket: new Date('2026-06-01T05:00:00Z'), count: 1n }]]);
    await getEngineActivitySparkline(prisma, AGG_INPUT, 'hour');
    expect(readSqlFragment(calls[0].values[0])).toBe("'hour'");
  });
});

// ─────────────────────────────────────────────
// 3. jsonb null normalization (Phase 1 risk 3)
// ─────────────────────────────────────────────

describe('jsonb null normalization — three "no value" cases all collapse to TS null', () => {
  it('decisionDistribution: SQL NULL + empty string + valid value coexist correctly', async () => {
    const { prisma } = makePrismaMock([
      [
        { engine_phase: null, action_type: 'a', count: 1n },        // SQL NULL (missing key)
        { engine_phase: '', action_type: 'b', count: 2n },          // Empty string (Postgres jsonb empty)
        { engine_phase: 'qualify', action_type: 'c', count: 3n },   // Real value
      ],
    ]);

    const result = await getDecisionDistributionByEnginePhase(prisma, AGG_INPUT);

    expect(result[0].enginePhase).toBeNull();
    expect(result[1].enginePhase).toBeNull();
    expect(result[2].enginePhase).toBe('qualify');
  });

  it('toneDistribution: same three cases collapse for tone field', async () => {
    const { prisma } = makePrismaMock([
      [
        { tone: null, count: 1n },
        { tone: '', count: 1n },
        { tone: 'professional', count: 1n },
      ],
    ]);

    const result = await getBrainSuggestedToneDistribution(prisma, AGG_INPUT);

    expect(result[0].tone).toBeNull();
    expect(result[1].tone).toBeNull();
    expect(result[2].tone).toBe('professional');
  });
});

// ─────────────────────────────────────────────
// 4. Orchestrator tests
// ─────────────────────────────────────────────

describe('getAllCognitiveMetrics — orchestrator', () => {
  beforeEach(() => {
    cognitiveMetricsCache.clear();
  });

  it('runs all 8 aggregators + auditLog.count exactly once in parallel', async () => {
    const { prisma, calls, auditLogCountCalls } = makePrismaMock(
      Array.from({ length: 8 }, () => []),
    );

    await getAllCognitiveMetrics(prisma, AGG_INPUT);

    expect(calls).toHaveLength(8);
    expect(auditLogCountCalls).toHaveBeenCalledTimes(1);
  });

  it('returns cacheHit=false on first call, cacheHit=true on second call (same window)', async () => {
    const { prisma } = makePrismaMock([
      ...Array.from({ length: 8 }, () => []),
      ...Array.from({ length: 8 }, () => []),
    ]);

    const first = await getAllCognitiveMetrics(prisma, AGG_INPUT);
    expect(first.cacheHit).toBe(false);

    const second = await getAllCognitiveMetrics(prisma, AGG_INPUT);
    expect(second.cacheHit).toBe(true);
    expect(second.windowStart).toBe(first.windowStart);
    expect(second.windowEnd).toBe(first.windowEnd);
  });

  it('forceRefresh=true bypasses cache and re-fetches', async () => {
    const { prisma, calls } = makePrismaMock([
      ...Array.from({ length: 8 }, () => []),
      ...Array.from({ length: 8 }, () => []),
    ]);

    await getAllCognitiveMetrics(prisma, AGG_INPUT);
    expect(calls).toHaveLength(8);

    await getAllCognitiveMetrics(prisma, { ...AGG_INPUT, forceRefresh: true });
    expect(calls).toHaveLength(16);
  });

  it('different windows produce different cache entries (no cross-window pollution)', async () => {
    const { prisma } = makePrismaMock([
      ...Array.from({ length: 8 }, () => []),
      ...Array.from({ length: 8 }, () => []),
    ]);

    await getAllCognitiveMetrics(prisma, AGG_INPUT);
    const altWindow = {
      tenantId: TENANT,
      windowStart: new Date('2026-05-01T00:00:00Z'),
      windowEnd: new Date('2026-05-31T23:59:59Z'),
    };
    const second = await getAllCognitiveMetrics(prisma, altWindow);

    expect(second.cacheHit).toBe(false);
    expect(second.windowStart).toBe(altWindow.windowStart.toISOString());
  });

  it('result includes all 8 metric fields + totalTier1Rows + metadata', async () => {
    const { prisma } = makePrismaMock(Array.from({ length: 8 }, () => []));

    const result = await getAllCognitiveMetrics(prisma, AGG_INPUT);

    expect(result).toMatchObject({
      windowStart: WINDOW_START.toISOString(),
      windowEnd: WINDOW_END.toISOString(),
      tenantId: TENANT,
      cacheHit: false,
      totalTier1Rows: 0,
      decisionDistribution: [],
      confidenceHistogram: expect.any(Array),
      toneDistribution: [],
      guardrailByCategory: [],
      mappingResolution: [],
      operatorOverride: [],
      tokenUsage: [],
      activitySparkline: [],
    });
    expect(result.confidenceHistogram).toHaveLength(10);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
