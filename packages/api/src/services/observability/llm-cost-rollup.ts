/**
 * KAN-745 PR B — query API for the rollup table.
 *
 * Read path consumed by the observability tRPC router. Queries flatten
 * `pricingVersion` — UI/router SUM across versions for display. The
 * `pricingVersion` column stays an audit trail (per
 * `feedback_model_pricing_refresh_discipline`); not a user-facing dimension.
 */
import type { PrismaClient } from '@prisma/client';
import { toHourBucket } from './llm-cost-aggregator.js';
import { CALLER_TAG_PREFIXES, type CallerTagPrefix } from './tag-mapping.js';

export interface RollupRow {
  hourBucket: Date;
  callerTagPrefix: CallerTagPrefix;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface ListInput {
  fromHour: Date;
  toHour: Date;
}

/**
 * Returns rows aggregated across pricingVersion (SUM-flattened) so UI
 * doesn't need to know about the version dimension.
 */
export async function listRollups(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
): Promise<RollupRow[]> {
  const fromHour = toHourBucket(input.fromHour);
  // toHour is exclusive at hour boundary — caller passes the next-hour
  // start to include the current incomplete bucket.
  const toHour = toHourBucket(input.toHour);

  const grouped = await prisma.llmCostRollup.groupBy({
    by: ['hourBucket', 'callerTagPrefix'],
    where: {
      tenantId,
      hourBucket: { gte: fromHour, lt: toHour },
    },
    _sum: {
      callCount: true,
      totalInputTokens: true,
      totalOutputTokens: true,
      totalCostUsd: true,
    },
    orderBy: [{ hourBucket: 'desc' }, { callerTagPrefix: 'asc' }],
  });

  return grouped.map((g) => ({
    hourBucket: g.hourBucket,
    callerTagPrefix: g.callerTagPrefix as CallerTagPrefix,
    callCount: g._sum.callCount ?? 0,
    totalInputTokens: g._sum.totalInputTokens ?? 0,
    totalOutputTokens: g._sum.totalOutputTokens ?? 0,
    totalCostUsd: g._sum.totalCostUsd ?? 0,
  }));
}

export interface CurrentHourSummary {
  hourBucket: Date;
  perPrefix: Array<{ callerTagPrefix: CallerTagPrefix; callCount: number; totalCostUsd: number }>;
  agenticUsd: number;
  nonAgenticUsd: number;
  shadowRatio: number | null;
  breachThreshold: boolean;
}

const SHADOW_RATIO_THRESHOLD = 2.5;

/**
 * Snapshot for the current hour bucket — feeds the dashboard top cards.
 * Includes zero-row prefixes so the UI renders a stable column set.
 */
export async function currentHourSummary(
  prisma: PrismaClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<CurrentHourSummary> {
  const hourBucket = toHourBucket(now);
  const grouped = await prisma.llmCostRollup.groupBy({
    by: ['callerTagPrefix'],
    where: { tenantId, hourBucket },
    _sum: { callCount: true, totalCostUsd: true },
  });

  const byPrefix = new Map<string, { callCount: number; totalCostUsd: number }>();
  for (const g of grouped) {
    byPrefix.set(g.callerTagPrefix, {
      callCount: g._sum.callCount ?? 0,
      totalCostUsd: g._sum.totalCostUsd ?? 0,
    });
  }

  const perPrefix: CurrentHourSummary['perPrefix'] = [];
  for (const prefix of [...CALLER_TAG_PREFIXES, 'other'] as const) {
    const v = byPrefix.get(prefix) ?? { callCount: 0, totalCostUsd: 0 };
    perPrefix.push({
      callerTagPrefix: prefix as CallerTagPrefix,
      callCount: v.callCount,
      totalCostUsd: v.totalCostUsd,
    });
  }

  let agenticUsd = 0;
  let nonAgenticUsd = 0;
  for (const p of perPrefix) {
    if (p.callerTagPrefix === 'agentic' || p.callerTagPrefix === 'agentic-tool') {
      agenticUsd += p.totalCostUsd;
    } else {
      nonAgenticUsd += p.totalCostUsd;
    }
  }

  let shadowRatio: number | null;
  if (nonAgenticUsd === 0 && agenticUsd === 0) shadowRatio = null;
  else if (nonAgenticUsd === 0) shadowRatio = Infinity;
  else shadowRatio = agenticUsd / nonAgenticUsd;

  return {
    hourBucket,
    perPrefix,
    agenticUsd,
    nonAgenticUsd,
    shadowRatio,
    breachThreshold:
      shadowRatio != null && Number.isFinite(shadowRatio) && shadowRatio > SHADOW_RATIO_THRESHOLD,
  };
}
