/**
 * KAN-1166 PR 2a — FeasibilityContextService.
 *
 * The first cross-cutting tenant-aware query layer in growth. Pure read-only
 * historical aggregation that powers AI honest counsel on operator-stated
 * outcome goals (Q1-Q9 resolutions in cc_prompt_kan_1166_pr2_phase1_design_trace).
 *
 * # Boundary doctrine (peer of Brain, not extension)
 *
 * brain-service.ts is Deal-centric — every method takes dealId or deal-derived
 * input (verified empirically at Phase 1: docstring lines 4-5 + every method
 * signature). This service owns the orthogonal surface: cross-Deal, cross-
 * Contact, cross-Order tenant aggregates. The two services NEVER call each
 * other directly. The Feasibility Analyzer (PR 2b) is the orchestrator that
 * combines both peers' outputs.
 *
 * Future Re-engagement / Lifecycle / Churn-prediction services follow the same
 * pattern: each is a peer of Brain consuming this service's outputs. Do NOT
 * accrete domain-specific counsel logic here — pure query layer only.
 *
 * # Caching (Q9 Option A — direct ioredis per architect Phase 1 + SPO greenlight)
 *
 * Memorystore wrapper does not exist in growth (Phase 1 finding). Pattern
 * mirrored verbatim from packages/api/src/services/knowledge-retrieval-service.ts:147-160:
 * inject Redis | null, try/catch fall-through, JSON.parse on hit, hard TTL.
 * Three-strikes wrapper extraction follow-up tracked separately (gated on 3rd
 * callsite emergence; this is the 2nd alongside knowledge-retrieval).
 *
 * # Fail-safe convention (per sub-objective-gap-tracker.ts:56 pattern)
 *
 * Any DB or cache transient failure returns a graceful "insufficient_data"
 * skeleton, NEVER throws. Analyzer (PR 2b consumer) treats insufficient_data
 * as the cold-start path. Service-layer failure must not block the chat UI.
 */
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  type GoalShape,
  type TenantHistoricalContext,
  type RequiredDataType,
  type FeasibilityConfidence,
  type ConversionRateSignal,
  type SalesVelocitySignal,
  type CustomerBaseSignal,
  type EngagementDistribution,
  type LeadPipelineSignal,
  type DataReadinessSignal,
  type WindowMeta,
} from "@growth/shared";

// ─────────────────────────────────────────────
// Public API surface — Phase 1 lock: 2 methods only on PR 2a.
// compareGoalToHistoricalAchievability lives in the PR 2b analyzer (Q8 lock).
// ─────────────────────────────────────────────

export interface GetTenantHistoricalContextParams {
  tenantId: string;
  goalShape: GoalShape;
  /** Default 365 days. Minimum 90 (any shorter window degrades to
   *  insufficient_data per Q4 thresholds). */
  windowDays?: number;
}

// ─────────────────────────────────────────────
// Constants — empirical thresholds gated on PROD-signal review.
//
// REVISIT 2026-08-11 — 8-week empirical-threshold review after PROD signal
// per Q4 calendar-marker discipline + KAN-XXXX follow-up.
// ─────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 365;
const MIN_WINDOW_DAYS = 90;

const CACHE_KEY_PREFIX = "feasibility:context";
/** Coarse default TTL. Per-signal TTL refinement deferred to Step 4 (cache
 *  invalidation hooks). 1h matches conversionRate + customerBase tier in brief. */
const DEFAULT_CACHE_TTL_SECONDS = 3600;

// REVISIT 2026-08-11 — dataReadiness gradient cutoffs (Q4 SPO-locked).
const SUFFICIENT_DEALS_THRESHOLD = 30;
const SUFFICIENT_HISTORY_DAYS = 90;
const PARTIAL_DEALS_THRESHOLD = 10;
const PARTIAL_HISTORY_DAYS = 30;

// REVISIT 2026-08-11 — confidence sample-size cutoffs.
const HIGH_CONFIDENCE_SAMPLES = 30;
const MEDIUM_CONFIDENCE_SAMPLES = 10;

/** Minimum days_ago bucket boundaries for lastEngagementDistribution
 *  (Q3 cohort). Exposed as constant so unit tests can reference. */
const ENGAGEMENT_BUCKET_BOUNDARIES = [30, 90, 180, 365] as const;

/** Minimum sample size for avgDealSize to be considered statistically meaningful. */
const MIN_DEAL_SAMPLE_FOR_AVG = 5;

// ─────────────────────────────────────────────
// Minimal Redis interface — injectable for tests; matches ioredis surface.
// ─────────────────────────────────────────────

export interface FeasibilityRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

// ─────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────

/** Deterministic 16-char hex hash of GoalShape for cache key partitioning. */
export function hashGoalShape(goalShape: GoalShape): string {
  return createHash("sha256")
    .update(JSON.stringify(goalShape))
    .digest("hex")
    .slice(0, 16);
}

export function buildContextCacheKey(input: {
  tenantId: string;
  goalShape: GoalShape;
  windowDays: number;
}): string {
  return `${CACHE_KEY_PREFIX}:${input.tenantId}:${hashGoalShape(input.goalShape)}:${input.windowDays}`;
}

interface CachedEnvelope {
  /** Unix milliseconds. Used to compute windowMeta.cacheAge on read. */
  writtenAt: number;
  data: TenantHistoricalContext;
}

/** JSON.stringify lossy-round-trips Date objects as ISO strings; rehydrate
 *  the 3 known Date fields back to Date instances so consumers get the
 *  ergonomic Date interface. */
function rehydrateDates(data: TenantHistoricalContext): TenantHistoricalContext {
  const earliest = data.dataReadiness.earliestDataDate;
  if (typeof earliest === "string") {
    data.dataReadiness.earliestDataDate = new Date(earliest);
  }
  if (typeof data.windowMeta.windowStart === "string") {
    data.windowMeta.windowStart = new Date(data.windowMeta.windowStart);
  }
  if (typeof data.windowMeta.windowEnd === "string") {
    data.windowMeta.windowEnd = new Date(data.windowMeta.windowEnd);
  }
  return data;
}

async function getCachedContext(
  redis: FeasibilityRedis | null,
  cacheKey: string,
): Promise<TenantHistoricalContext | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(cacheKey);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as CachedEnvelope;
    const data = rehydrateDates(envelope.data);
    data.windowMeta = {
      ...data.windowMeta,
      cacheAge: Date.now() - envelope.writtenAt,
    };
    return data;
  } catch (err) {
    console.warn(
      `[feasibility-context-service] redis-cache-read-failed key=${cacheKey} err=${(err as Error)?.message ?? String(err)}`,
    );
    return null;
  }
}

async function setCachedContext(
  redis: FeasibilityRedis | null,
  cacheKey: string,
  value: TenantHistoricalContext,
  ttlSeconds: number,
): Promise<void> {
  if (!redis) return;
  try {
    const envelope: CachedEnvelope = { writtenAt: Date.now(), data: value };
    await redis.set(cacheKey, JSON.stringify(envelope), "EX", ttlSeconds);
  } catch (err) {
    console.warn(
      `[feasibility-context-service] redis-cache-write-failed key=${cacheKey} err=${(err as Error)?.message ?? String(err)}`,
    );
  }
}

// ─────────────────────────────────────────────
// Confidence classification helpers
// ─────────────────────────────────────────────

function classifyConfidence(sampleSize: number): FeasibilityConfidence {
  if (sampleSize >= HIGH_CONFIDENCE_SAMPLES) return "high";
  if (sampleSize >= MEDIUM_CONFIDENCE_SAMPLES) return "medium";
  if (sampleSize > 0) return "low";
  return "insufficient_data";
}

function confidenceReason(label: string, sampleSize: number, windowDays: number): string {
  if (sampleSize === 0) {
    return `No ${label} found in the last ${windowDays} days.`;
  }
  return `Based on ${sampleSize} ${label} in the last ${windowDays} days.`;
}

// ─────────────────────────────────────────────
// Insufficient-data skeleton (cold-start path)
// ─────────────────────────────────────────────

function buildInsufficientDataSkeleton(
  windowStart: Date,
  windowEnd: Date,
  missingDataTypes: RequiredDataType[],
  earliestDataDate: Date | null,
): TenantHistoricalContext {
  return {
    conversionRate: {
      value: null,
      sampleSize: 0,
      confidence: "insufficient_data",
      confidenceReason: "Not enough closed deals to compute a conversion rate.",
    },
    salesVelocity: {
      unitsPerMonth: null,
      revenuePerMonth: null,
      trendDirection: "insufficient_data",
      confidence: "insufficient_data",
    },
    customerBase: {
      totalCustomers: 0,
      matchingGoalShape: 0,
      avgDealSize: null,
      lastEngagementDistribution: {
        lt30days: 0,
        lt90days: 0,
        lt180days: 0,
        lt365days: 0,
        stale: 0,
      },
    },
    leadPipeline: {
      totalActiveLeads: 0,
      matchingGoalShape: 0,
      bySource: {},
      weeklyAcquisitionRate: null,
    },
    dataReadiness: {
      overall: "insufficient",
      missingDataTypes,
      earliestDataDate,
    },
    windowMeta: { windowStart, windowEnd, cacheAge: 0 },
  };
}

// ─────────────────────────────────────────────
// Compute helpers — per-signal queries.
//
// Tenant-id discipline: every query takes tenantId as typed first parameter
// (NEVER context-implicit). Multi-tenant-safe AND wrapper construct from
// audience-router.ts:222 verbatim where conditions tree could be extended.
// ─────────────────────────────────────────────

/** Tenant-wide audit of data substrates. Drives Q4 gradient decision +
 *  identifies which data types are missing for Q8 acquisition counsel. */
async function computeDataReadiness(
  prisma: PrismaClient,
  tenantId: string,
  windowStart: Date,
): Promise<DataReadinessSignal> {
  const [
    closedDeals,
    earliestOrder,
    earliestContact,
    earliestEngagement,
    customerCount,
    leadCount,
  ] = await Promise.all([
    prisma.deal.count({
      where: { tenantId, status: { in: ["won", "lost"] }, closedAt: { gte: windowStart } },
    }),
    prisma.order.findFirst({
      where: { tenantId },
      orderBy: { placedAt: "asc" },
      select: { placedAt: true },
    }),
    prisma.contact.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.engagement.findFirst({
      where: { tenantId, signalClass: "positive" },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
    prisma.contact.count({ where: { tenantId, lifecycleStage: "customer" } }),
    prisma.contact.count({
      where: { tenantId, lifecycleStage: { in: ["lead", "mql", "sql"] } },
    }),
  ]);

  const candidateDates = [
    earliestOrder?.placedAt,
    earliestContact?.createdAt,
    earliestEngagement?.occurredAt,
  ].filter((d): d is Date => d != null);
  const earliestDataDate =
    candidateDates.length > 0
      ? new Date(Math.min(...candidateDates.map((d) => d.getTime())))
      : null;

  const historyDays = earliestDataDate
    ? Math.floor((Date.now() - earliestDataDate.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const missingDataTypes: RequiredDataType[] = [];
  if (!earliestOrder) missingDataTypes.push("sales_history");
  if (customerCount === 0) missingDataTypes.push("customer_base");
  if (leadCount === 0) missingDataTypes.push("lead_history");
  if (!earliestEngagement) missingDataTypes.push("engagement_history");

  let overall: DataReadinessSignal["overall"];
  if (closedDeals >= SUFFICIENT_DEALS_THRESHOLD && historyDays >= SUFFICIENT_HISTORY_DAYS) {
    overall = "sufficient";
  } else if (closedDeals >= PARTIAL_DEALS_THRESHOLD || historyDays >= PARTIAL_HISTORY_DAYS) {
    overall = "partial";
  } else {
    overall = "insufficient";
  }

  return { overall, missingDataTypes, earliestDataDate };
}

/** Approximate conversion rate: closed-won deals in window ÷ leads created
 *  in window. v0.1 caveat: deals can be won outside the window from leads
 *  inside the window; rate is a tenant-level approximation. Analyzer counsel
 *  surfaces this caveat honestly. */
async function computeConversionRate(
  prisma: PrismaClient,
  tenantId: string,
  goalShape: GoalShape,
  windowStart: Date,
  windowDays: number,
): Promise<ConversionRateSignal> {
  const segmentId = "segmentId" in goalShape ? goalShape.segmentId : undefined;
  const segmentFilter = segmentId ? { segment: segmentId } : {};

  const [wonDeals, leadsCreated] = await Promise.all([
    prisma.deal.count({
      where: {
        tenantId,
        status: "won",
        closedAt: { gte: windowStart },
        ...(segmentFilter.segment
          ? { contact: { tenantId, segment: segmentFilter.segment } }
          : {}),
      },
    }),
    prisma.contact.count({
      where: {
        tenantId,
        lifecycleStage: { in: ["lead", "mql", "sql"] },
        createdAt: { gte: windowStart },
        ...segmentFilter,
      },
    }),
  ]);

  const value = leadsCreated > 0 ? wonDeals / leadsCreated : null;
  const confidence = classifyConfidence(wonDeals);

  return {
    value,
    sampleSize: wonDeals,
    confidence,
    confidenceReason: confidenceReason("closed-won deals", wonDeals, windowDays),
  };
}

/** Sales velocity from paid Orders. Trend via raw SQL window comparison
 *  (recent half-window AVG vs prior half-window AVG). v0.1 caveat:
 *  unitsPerMonth ≈ order count (line_items are opaque Json; per-unit parsing
 *  deferred until product catalog ships). */
async function computeSalesVelocity(
  prisma: PrismaClient,
  tenantId: string,
  windowStart: Date,
  windowDays: number,
): Promise<SalesVelocitySignal> {
  const [orderCount, sumResult] = await Promise.all([
    prisma.order.count({
      where: {
        tenantId,
        status: { in: ["paid", "partially_refunded"] },
        placedAt: { gte: windowStart },
      },
    }),
    prisma.order.aggregate({
      where: {
        tenantId,
        status: { in: ["paid", "partially_refunded"] },
        placedAt: { gte: windowStart },
        currency: "USD",
      },
      _sum: { grandTotal: true },
    }),
  ]);

  const months = windowDays / 30;
  const unitsPerMonth = orderCount > 0 ? orderCount / months : null;
  const rawSum = sumResult._sum.grandTotal;
  const totalRevenue =
    rawSum == null ? 0 : Number((rawSum as { toString(): string }).toString());
  const revenuePerMonth =
    orderCount > 0 && Number.isFinite(totalRevenue) ? totalRevenue / months : null;

  // Trend: raw SQL window comparison (recent half vs prior half).
  // Per Q1 caveat: raw-SQL aggregator MUST have ≥1 KAN-1112 integration
  // test that EXECUTES the SQL against real Postgres (KAN-1089 lesson).
  let trendDirection: SalesVelocitySignal["trendDirection"] = "insufficient_data";
  if (orderCount >= MIN_DEAL_SAMPLE_FOR_AVG * 2) {
    const halfwayMs = windowStart.getTime() + (Date.now() - windowStart.getTime()) / 2;
    const halfway = new Date(halfwayMs);
    try {
      const trendRows = await prisma.$queryRaw<
        Array<{ recent_avg: number | null; prior_avg: number | null }>
      >`
        WITH monthly AS (
          SELECT
            DATE_TRUNC('month', placed_at) AS month,
            COUNT(*)::float AS order_count
          FROM orders
          WHERE tenant_id = ${tenantId}
            AND status IN ('paid', 'partially_refunded')
            AND placed_at >= ${windowStart}
          GROUP BY 1
        )
        SELECT
          AVG(CASE WHEN month >= ${halfway} THEN order_count END)::float AS recent_avg,
          AVG(CASE WHEN month < ${halfway} THEN order_count END)::float AS prior_avg
        FROM monthly
      `;
      const row = trendRows[0];
      if (row?.recent_avg != null && row?.prior_avg != null && row.prior_avg > 0) {
        const ratio = row.recent_avg / row.prior_avg;
        if (ratio > 1.1) trendDirection = "up";
        else if (ratio < 0.9) trendDirection = "down";
        else trendDirection = "stable";
      }
    } catch (err) {
      console.warn(
        `[feasibility-context-service] trend-query-failed tenantId=${tenantId} err=${(err as Error)?.message ?? String(err)}`,
      );
      // Leave trendDirection as 'insufficient_data' — fail-safe convention.
    }
  }

  return {
    unitsPerMonth,
    revenuePerMonth,
    trendDirection,
    confidence: classifyConfidence(orderCount),
  };
}

/** Customer base aggregates + lastEngagement cohort distribution.
 *  Q3 lock: cohort gated to signalClass='positive' Engagements. */
async function computeCustomerBase(
  prisma: PrismaClient,
  tenantId: string,
  goalShape: GoalShape,
): Promise<CustomerBaseSignal> {
  const segmentId = "segmentId" in goalShape ? goalShape.segmentId : undefined;

  const [totalCustomers, matchingCustomers, avgDealStats] = await Promise.all([
    prisma.contact.count({ where: { tenantId, lifecycleStage: "customer" } }),
    prisma.contact.count({
      where: {
        tenantId,
        lifecycleStage: "customer",
        ...(segmentId ? { segment: segmentId } : {}),
      },
    }),
    prisma.deal.aggregate({
      where: { tenantId, status: { in: ["won", "lost"] } },
      _avg: { value: true },
      _count: { value: true },
    }),
  ]);

  const dealSampleCount = avgDealStats._count.value;
  const avgDealSize =
    dealSampleCount >= MIN_DEAL_SAMPLE_FOR_AVG && avgDealStats._avg.value != null
      ? Number((avgDealStats._avg.value as { toString(): string }).toString())
      : null;

  // Last-engagement cohort distribution — raw SQL per Q1 hybrid (cohort
  // bucketing not cleanly expressible in Prisma).
  // Per Q1 caveat: raw-SQL aggregator MUST have ≥1 KAN-1112 integration test.
  let dist: EngagementDistribution = {
    lt30days: 0,
    lt90days: 0,
    lt180days: 0,
    lt365days: 0,
    stale: 0,
  };

  if (totalCustomers > 0) {
    try {
      const rows = await prisma.$queryRaw<
        Array<{
          lt30: bigint;
          lt90: bigint;
          lt180: bigint;
          lt365: bigint;
          stale: bigint;
        }>
      >`
        SELECT
          COUNT(*) FILTER (WHERE days_ago < ${ENGAGEMENT_BUCKET_BOUNDARIES[0]}) AS lt30,
          COUNT(*) FILTER (WHERE days_ago >= ${ENGAGEMENT_BUCKET_BOUNDARIES[0]} AND days_ago < ${ENGAGEMENT_BUCKET_BOUNDARIES[1]}) AS lt90,
          COUNT(*) FILTER (WHERE days_ago >= ${ENGAGEMENT_BUCKET_BOUNDARIES[1]} AND days_ago < ${ENGAGEMENT_BUCKET_BOUNDARIES[2]}) AS lt180,
          COUNT(*) FILTER (WHERE days_ago >= ${ENGAGEMENT_BUCKET_BOUNDARIES[2]} AND days_ago < ${ENGAGEMENT_BUCKET_BOUNDARIES[3]}) AS lt365,
          COUNT(*) FILTER (WHERE days_ago >= ${ENGAGEMENT_BUCKET_BOUNDARIES[3]} OR days_ago IS NULL) AS stale
        FROM (
          SELECT
            c.id,
            EXTRACT(EPOCH FROM (NOW() - MAX(e.occurred_at))) / 86400 AS days_ago
          FROM contacts c
          LEFT JOIN engagements e
            ON e.contact_id = c.id
           AND e.signal_class = 'positive'
           AND e.tenant_id = ${tenantId}
          WHERE c.tenant_id = ${tenantId}
            AND c.lifecycle_stage = 'customer'
          GROUP BY c.id
        ) sub
      `;
      const row = rows[0];
      if (row) {
        dist = {
          lt30days: Number(row.lt30),
          lt90days: Number(row.lt90),
          lt180days: Number(row.lt180),
          lt365days: Number(row.lt365),
          stale: Number(row.stale),
        };
      }
    } catch (err) {
      console.warn(
        `[feasibility-context-service] engagement-distribution-query-failed tenantId=${tenantId} err=${(err as Error)?.message ?? String(err)}`,
      );
      // Leave dist as zeroes — fail-safe convention.
    }
  }

  return {
    totalCustomers,
    matchingGoalShape: matchingCustomers,
    avgDealSize,
    lastEngagementDistribution: dist,
  };
}

/** Active leads aggregates + per-source breakdown + weekly acquisition rate. */
async function computeLeadPipeline(
  prisma: PrismaClient,
  tenantId: string,
  goalShape: GoalShape,
  windowStart: Date,
  windowDays: number,
): Promise<LeadPipelineSignal> {
  const segmentId = "segmentId" in goalShape ? goalShape.segmentId : undefined;

  const [totalActiveLeads, matchingLeads, sourceGroups, recentLeadsCount] =
    await Promise.all([
      prisma.contact.count({
        where: { tenantId, lifecycleStage: { in: ["lead", "mql", "sql"] } },
      }),
      prisma.contact.count({
        where: {
          tenantId,
          lifecycleStage: { in: ["lead", "mql", "sql"] },
          ...(segmentId ? { segment: segmentId } : {}),
        },
      }),
      prisma.contact.groupBy({
        by: ["source"],
        where: {
          tenantId,
          lifecycleStage: { in: ["lead", "mql", "sql"] },
          createdAt: { gte: windowStart },
        },
        _count: { _all: true },
      }),
      prisma.contact.count({
        where: {
          tenantId,
          lifecycleStage: { in: ["lead", "mql", "sql"] },
          createdAt: { gte: windowStart },
        },
      }),
    ]);

  const bySource: Record<string, number> = {};
  for (const group of sourceGroups) {
    const sourceLabel = group.source ?? "unknown";
    bySource[sourceLabel] = group._count._all;
  }

  const weeksInWindow = windowDays / 7;
  const weeklyAcquisitionRate =
    recentLeadsCount > 0 ? recentLeadsCount / weeksInWindow : null;

  return {
    totalActiveLeads,
    matchingGoalShape: matchingLeads,
    bySource,
    weeklyAcquisitionRate,
  };
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Compute tenant-aware historical aggregates for AI feasibility counsel.
 *
 * Orchestrates: cache lookup → dataReadiness gate → parallel-compute
 * remaining signals (skipped under cold-start) → cache write → return.
 *
 * Fail-safe convention (per sub-objective-gap-tracker.ts:56): any orchestrator-
 * level DB transient returns the insufficient_data skeleton. Per-signal
 * compute helpers also fail-safe locally (raw-SQL catch + zero fallback).
 */
export async function getTenantHistoricalContext(
  prisma: PrismaClient,
  redis: FeasibilityRedis | null,
  params: GetTenantHistoricalContextParams,
): Promise<TenantHistoricalContext> {
  const { tenantId, goalShape } = params;
  const windowDays = Math.max(params.windowDays ?? DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const cacheKey = buildContextCacheKey({ tenantId, goalShape, windowDays });
  const cached = await getCachedContext(redis, cacheKey);
  if (cached) return cached;

  try {
    const dataReadiness = await computeDataReadiness(prisma, tenantId, windowStart);

    // Cold-start: skip the heavy queries; return skeleton so analyzer's
    // LLM can synthesize first-principles counsel.
    if (dataReadiness.overall === "insufficient") {
      const skeleton = buildInsufficientDataSkeleton(
        windowStart,
        windowEnd,
        dataReadiness.missingDataTypes,
        dataReadiness.earliestDataDate,
      );
      await setCachedContext(redis, cacheKey, skeleton, DEFAULT_CACHE_TTL_SECONDS);
      return skeleton;
    }

    const [conversionRate, salesVelocity, customerBase, leadPipeline] = await Promise.all([
      computeConversionRate(prisma, tenantId, goalShape, windowStart, windowDays),
      computeSalesVelocity(prisma, tenantId, windowStart, windowDays),
      computeCustomerBase(prisma, tenantId, goalShape),
      computeLeadPipeline(prisma, tenantId, goalShape, windowStart, windowDays),
    ]);

    const windowMeta: WindowMeta = { windowStart, windowEnd, cacheAge: 0 };
    const result: TenantHistoricalContext = {
      conversionRate,
      salesVelocity,
      customerBase,
      leadPipeline,
      dataReadiness,
      windowMeta,
    };

    await setCachedContext(redis, cacheKey, result, DEFAULT_CACHE_TTL_SECONDS);
    return result;
  } catch (err) {
    // Orchestrator-level fail-safe — any uncaught DB transient surfaces as
    // insufficient_data so chat-UI counsel is never blocked.
    console.error(
      `[feasibility-context-service] getTenantHistoricalContext-failed tenantId=${tenantId}:`,
      err,
    );
    return buildInsufficientDataSkeleton(windowStart, windowEnd, [], null);
  }
}

/**
 * Pure mapping: GoalShape → which data substrates the analyzer's LLM needs
 * to give CONFIDENT counsel. Drives Q8 data-acquisition chat flow.
 *
 * No DB queries — pure function over the discriminated union.
 */
export function getRequiredDataTypesForGoal(goalShape: GoalShape): RequiredDataType[] {
  switch (goalShape.type) {
    case "revenue":
    case "units":
      // Revenue + units counsel needs sales history (closed deals + paid
      // orders) plus the customer base for upsell-feasibility signals.
      return ["sales_history", "customer_base"];
    case "deals":
      // Deal-volume counsel needs sales history + lead pipeline (for
      // organic-projection math).
      return ["sales_history", "lead_history"];
    case "meetings":
      // Meeting counsel is dominantly engagement-driven; lead pipeline
      // gives acquisition projection.
      return ["engagement_history", "lead_history"];
    case "custom":
      // Custom goals — LLM interprets at counsel time; surface all four
      // substrates as potentially relevant.
      return ["sales_history", "customer_base", "lead_history", "engagement_history"];
  }
}
