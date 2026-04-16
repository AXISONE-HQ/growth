/**
 * BigQuery Analytics Pipeline — Learning Service (LEARN Phase)
 *
 * Streams learning events to BigQuery for OLAP reporting. Maintains
 * strict OLTP/OLAP separation: Cloud SQL handles transactional writes,
 * BigQuery handles analytical queries. This pipeline is the bridge.
 *
 * Subscribes to: growth.outcome.recorded, growth.engagement.logged,
 *                growth.strategy.weights.updated, growth.customer.health.changed,
 *                growth.behavioral.updated
 * Publishes to:  BigQuery tables (via streaming insert)
 *
 * BigQuery Dataset: growth_analytics
 * Tables:
 *   - outcomes      (from outcome.recorded)
 *   - engagements   (from engagement.logged)
 *   - strategy_perf (from strategy.weights.updated)
 *   - health_scores (from customer.health.changed)
 *   - behavioral    (from behavioral.updated)
 *
 * @module learning-service/analytics-pipeline
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const BQ_DATASET = 'growth_analytics';

const BQ_TABLES = {
  outcomes: `${BQ_DATASET}.outcomes`,
  engagements: `${BQ_DATASET}.engagements`,
  strategyPerf: `${BQ_DATASET}.strategy_performance`,
  healthScores: `${BQ_DATASET}.health_scores`,
  behavioral: `${BQ_DATASET}.behavioral_signals`,
} as const;

// Max rows per streaming insert batch
const MAX_BATCH_SIZE = 500;

// Retry config for BigQuery streaming inserts
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

// ─────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────

/**
 * Generic row schema for BigQuery streaming insert.
 * Each event type maps to a specific table with its own columns.
 */
export const AnalyticsRowSchema = z.object({
  table: z.string(),
  insertId: z.string(),
  row: z.record(z.unknown()),
});

export type AnalyticsRow = z.infer<typeof AnalyticsRowSchema>;

export const PipelineResultSchema = z.object({
  table: z.string(),
  rowsInserted: z.number().int().min(0),
  rowsFailed: z.number().int().min(0),
  errors: z.array(z.string()),
});

export type PipelineResult = z.infer<typeof PipelineResultSchema>;

export const PipelineBatchResultSchema = z.object({
  totalRows: z.number(),
  totalInserted: z.number(),
  totalFailed: z.number(),
  tableResults: z.array(PipelineResultSchema),
  processedAt: z.string().datetime(),
});

export type PipelineBatchResult = z.infer<typeof PipelineBatchResultSchema>;

// ─────────────────────────────────────────────────────────
// Interfaces (Dependency Injection)
// ─────────────────────────────────────────────────────────

export interface BigQueryClient {
  /**
   * Insert rows into a BigQuery table via streaming insert.
   * @param table  Fully qualified table name (dataset.table)
   * @param rows   Array of row objects with insertId for deduplication
   * @returns Insert result with per-row error details
   */
  insertRows(
    table: string,
    rows: Array<{ insertId: string; json: Record<string, unknown> }>,
  ): Promise<{
    insertedCount: number;
    failedCount: number;
    errors: Array<{ index: number; message: string }>;
  }>;
}

export interface AnalyticsPipelineDependencies {
  bigquery: BigQueryClient;
}

// ─────────────────────────────────────────────────────────
// Event-to-Row Transformers
// ─────────────────────────────────────────────────────────

/**
 * Transform an outcome.recorded Pub/Sub event into a BigQuery row.
 */
export function transformOutcomeEvent(event: Record<string, unknown>): AnalyticsRow {
  const outcome = event.outcome as Record<string, unknown> | undefined;
  const strategy = event.strategy as Record<string, unknown> | undefined;
  const timing = event.timing as Record<string, unknown> | undefined;
  const revenue = event.revenue as Record<string, unknown> | undefined;

  return {
    table: BQ_TABLES.outcomes,
    insertId: event.eventId as string ?? `ins_${crypto.randomUUID()}`,
    row: {
      event_id: event.eventId,
      tenant_id: event.tenantId,
      contact_id: event.contactId,
      objective_id: event.objectiveId,
      outcome_id: event.outcomeId,
      result: outcome?.result,
      reason_category: outcome?.reasonCategory,
      reason_detail: outcome?.reasonDetail,
      strategy_used: strategy?.strategyUsed,
      channel_used: strategy?.channelUsed,
      confidence_at_decision: strategy?.confidenceAtDecision,
      revenue_amount: revenue?.amount ?? 0,
      revenue_currency: revenue?.currency ?? 'USD',
      revenue_type: revenue?.type,
      total_interactions: timing?.totalInteractions,
      total_duration_days: timing?.totalDurationDays,
      objective_started_at: timing?.objectiveStartedAt,
      recorded_at: timing?.recordedAt ?? event.timestamp,
      ingested_at: new Date().toISOString(),
    },
  };
}

/**
 * Transform an engagement.logged Pub/Sub event into a BigQuery row.
 */
export function transformEngagementEvent(event: Record<string, unknown>): AnalyticsRow {
  const engagement = event.engagement as Record<string, unknown> | undefined;
  const timing = event.timing as Record<string, unknown> | undefined;
  const context = event.context as Record<string, unknown> | undefined;

  return {
    table: BQ_TABLES.engagements,
    insertId: event.eventId as string ?? `ins_${crypto.randomUUID()}`,
    row: {
      event_id: event.eventId,
      tenant_id: event.tenantId,
      contact_id: event.contactId,
      engagement_id: event.engagementId,
      engagement_type: engagement?.type,
      channel: engagement?.channel,
      sentiment: engagement?.sentiment,
      signal_class: engagement?.signalClass,
      occurred_at: timing?.occurredAt,
      time_since_action_ms: timing?.timeSinceActionMs,
      day_of_week: timing?.dayOfWeek,
      hour_of_day: timing?.hourOfDay,
      action_id: context?.actionId,
      decision_id: context?.decisionId,
      objective_id: context?.objectiveId,
      ingested_at: new Date().toISOString(),
    },
  };
}

/**
 * Transform a strategy.weights.updated Pub/Sub event into a BigQuery row.
 */
export function transformStrategyEvent(event: Record<string, unknown>): AnalyticsRow {
  const strategy = event.strategy as Record<string, unknown> | undefined;
  const metrics = event.metrics as Record<string, unknown> | undefined;
  const performance = event.performance as Record<string, unknown> | undefined;

  return {
    table: BQ_TABLES.strategyPerf,
    insertId: event.eventId as string ?? `ins_${crypto.randomUUID()}`,
    row: {
      event_id: event.eventId,
      tenant_id: event.tenantId,
      weight_id: event.weightId,
      strategy_type: strategy?.type,
      segment: strategy?.segment,
      channel: strategy?.channel,
      previous_win_rate: metrics?.previousWinRate,
      new_win_rate: metrics?.newWinRate,
      sample_size: metrics?.sampleSize,
      total_attempts: metrics?.totalAttempts,
      total_successes: metrics?.totalSuccesses,
      total_revenue: metrics?.totalRevenue,
      is_statistically_significant: metrics?.isStatisticallySignificant,
      avg_confidence: performance?.avgConfidenceAtDecision,
      avg_duration_days: performance?.avgDurationDays,
      avg_interactions: performance?.avgInteractions,
      updated_at: event.timestamp,
      ingested_at: new Date().toISOString(),
    },
  };
}

/**
 * Transform a customer.health.changed Pub/Sub event into a BigQuery row.
 */
export function transformHealthEvent(event: Record<string, unknown>): AnalyticsRow {
  const health = event.health as Record<string, unknown> | undefined;
  const components = event.components as Record<string, unknown> | undefined;
  const signals = event.signals as Record<string, unknown> | undefined;

  return {
    table: BQ_TABLES.healthScores,
    insertId: event.eventId as string ?? `ins_${crypto.randomUUID()}`,
    row: {
      event_id: event.eventId,
      tenant_id: event.tenantId,
      contact_id: event.contactId,
      score_id: event.scoreId,
      score: health?.score,
      tier: health?.tier,
      previous_score: health?.previousScore,
      previous_tier: health?.previousTier,
      tier_changed: health?.tierChanged,
      component_recency: components?.recency,
      component_frequency: components?.frequency,
      component_sentiment: components?.sentiment,
      component_objective_progress: components?.objectiveProgress,
      component_revenue: components?.revenue,
      days_since_last_engagement: signals?.daysSinceLastEngagement,
      engagement_count_30d: signals?.engagementCountLast30Days,
      computed_at: event.timestamp,
      ingested_at: new Date().toISOString(),
    },
  };
}

/**
 * Transform a behavioral.updated Pub/Sub event into a BigQuery row.
 */
export function transformBehavioralEvent(event: Record<string, unknown>): AnalyticsRow {
  const timing = event.timing as Record<string, unknown> | undefined;
  const channels = event.channels as Record<string, unknown> | undefined;
  const velocity = event.velocity as Record<string, unknown> | undefined;
  const sentiment = event.sentiment as Record<string, unknown> | undefined;

  return {
    table: BQ_TABLES.behavioral,
    insertId: event.eventId as string ?? `ins_${crypto.randomUUID()}`,
    row: {
      event_id: event.eventId,
      tenant_id: event.tenantId,
      contact_id: event.contactId,
      profile_id: event.profileId,
      best_day_of_week: timing?.bestDayOfWeek,
      best_hour_of_day: timing?.bestHourOfDay,
      avg_response_time_ms: timing?.avgResponseTimeMs,
      preferred_channel: channels?.preferred,
      channel_scores: JSON.stringify(channels?.scores ?? {}),
      total_engagements: velocity?.totalEngagements,
      engagement_rate: velocity?.engagementRate,
      positive_signals: sentiment?.positiveSignals,
      negative_signals: sentiment?.negativeSignals,
      neutral_signals: sentiment?.neutralSignals,
      updated_at: event.timestamp,
      ingested_at: new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────
// Event Router
// ─────────────────────────────────────────────────────────

/**
 * Route a Pub/Sub event to the correct transformer based on eventType.
 */
export function routeEventToRow(event: Record<string, unknown>): AnalyticsRow | null {
  const eventType = event.eventType as string;

  switch (eventType) {
    case 'outcome.recorded':
      return transformOutcomeEvent(event);
    case 'engagement.logged':
      return transformEngagementEvent(event);
    case 'strategy.weights.updated':
      return transformStrategyEvent(event);
    case 'customer.health.changed':
      return transformHealthEvent(event);
    case 'behavioral.updated':
      return transformBehavioralEvent(event);
    default:
      console.warn(`[AnalyticsPipeline] Unknown event type: ${eventType}`);
      return null;
  }
}

// ─────────────────────────────────────────────────────────
// Streaming Insert with Retry
// ─────────────────────────────────────────────────────────

/**
 * Insert rows into BigQuery with exponential backoff retry.
 */
async function insertWithRetry(
  client: BigQueryClient,
  table: string,
  rows: Array<{ insertId: string; json: Record<string, unknown> }>,
): Promise<PipelineResult> {
  let lastError: string | null = null;
  let insertedCount = 0;
  let failedCount = rows.length;
  const errors: string[] = [];

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const result = await client.insertRows(table, rows);
      insertedCount = result.insertedCount;
      failedCount = result.failedCount;

      for (const err of result.errors) {
        errors.push(`Row ${err.index}: ${err.message}`);
      }

      return PipelineResultSchema.parse({
        table,
        rowsInserted: insertedCount,
        rowsFailed: failedCount,
        errors,
      });
    } catch (err: any) {
      lastError = err.message ?? 'Unknown error';
      if (attempt < RETRY_CONFIG.maxRetries) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
          RETRY_CONFIG.maxDelayMs,
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  errors.push(`All ${RETRY_CONFIG.maxRetries + 1} attempts failed: ${lastError}`);
  return PipelineResultSchema.parse({
    table,
    rowsInserted: 0,
    rowsFailed: rows.length,
    errors,
  });
}

// ─────────────────────────────────────────────────────────
// Main Entry Points
// ─────────────────────────────────────────────────────────

/**
 * Stream a single event to BigQuery.
 * Used by Pub/Sub push subscribers.
 */
export async function streamEvent(
  event: Record<string, unknown>,
  deps: AnalyticsPipelineDependencies,
): Promise<PipelineResult | null> {
  const row = routeEventToRow(event);
  if (!row) return null;

  return insertWithRetry(deps.bigquery, row.table, [
    { insertId: row.insertId, json: row.row },
  ]);
}

/**
 * Stream a batch of events to BigQuery.
 * Groups events by target table for efficient batch inserts.
 */
export async function streamEventBatch(
  events: Array<Record<string, unknown>>,
  deps: AnalyticsPipelineDependencies,
): Promise<PipelineBatchResult> {
  // Route and group by table
  const byTable = new Map<string, Array<{ insertId: string; json: Record<string, unknown> }>>();

  for (const event of events) {
    const row = routeEventToRow(event);
    if (!row) continue;
    if (!byTable.has(row.table)) byTable.set(row.table, []);
    byTable.get(row.table)!.push({ insertId: row.insertId, json: row.row });
  }

  // Insert per table, respecting batch size limits
  const tableResults: PipelineResult[] = [];
  let totalInserted = 0;
  let totalFailed = 0;

  for (const [table, rows] of byTable) {
    // Chunk into MAX_BATCH_SIZE batches
    for (let i = 0; i < rows.length; i += MAX_BATCH_SIZE) {
      const chunk = rows.slice(i, i + MAX_BATCH_SIZE);
      const result = await insertWithRetry(deps.bigquery, table, chunk);
      tableResults.push(result);
      totalInserted += result.rowsInserted;
      totalFailed += result.rowsFailed;
    }
  }

  return PipelineBatchResultSchema.parse({
    totalRows: events.length,
    totalInserted,
    totalFailed,
    tableResults,
    processedAt: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────
// In-Memory Adapters (for testing)
// ─────────────────────────────────────────────────────────

export class InMemoryBigQueryClient implements BigQueryClient {
  private rows: Map<string, Array<{ insertId: string; json: Record<string, unknown> }>> = new Map();

  async insertRows(
    table: string,
    rows: Array<{ insertId: string; json: Record<string, unknown> }>,
  ) {
    if (!this.rows.has(table)) this.rows.set(table, []);
    this.rows.get(table)!.push(...rows);
    return {
      insertedCount: rows.length,
      failedCount: 0,
      errors: [],
    };
  }

  getRows(table: string) {
    return this.rows.get(table) ?? [];
  }

  getAllRows() {
    const all: Record<string, Array<Record<string, unknown>>> = {};
    for (const [table, rows] of this.rows) {
      all[table] = rows.map(r => r.json);
    }
    return all;
  }

  getRowCount(table: string): number {
    return this.rows.get(table)?.length ?? 0;
  }

  getTotalRowCount(): number {
    let total = 0;
    for (const rows of this.rows.values()) total += rows.length;
    return total;
  }

  clear(): void { this.rows.clear(); }
}

// ─────────────────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createAnalyticsPipelineRouter(
  deps: AnalyticsPipelineDependencies,
): Router {
  const router = Router();

  /**
   * POST /api/learning/analytics/stream
   * Stream a single event to BigQuery.
   */
  router.post('/analytics/stream', async (req: Request, res: Response) => {
    try {
      const result = await streamEvent(req.body, deps);
      if (!result) {
        res.status(400).json({ success: false, error: 'Unknown event type' });
        return;
      }
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[AnalyticsPipeline] Stream error:', err);
      res.status(500).json({
        success: false,
        error: err.message ?? 'Analytics streaming failed',
      });
    }
  });

  /**
   * POST /api/learning/analytics/stream/batch
   * Stream a batch of events to BigQuery.
   */
  router.post('/analytics/stream/batch', async (req: Request, res: Response) => {
    try {
      const events = z.array(z.record(z.unknown())).parse(req.body);
      const result = await streamEventBatch(events, deps);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[AnalyticsPipeline] Batch stream error:', err);
      res.status(500).json({
        success: false,
        error: err.message ?? 'Batch analytics streaming failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

export {
  BQ_DATASET,
  BQ_TABLES,
  MAX_BATCH_SIZE,
  RETRY_CONFIG,
  routeEventToRow,
};
