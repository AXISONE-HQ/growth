/**
 * Strategy Win Rate Tracker — Learning Service (LEARN Phase)
 *
 * Tracks which strategies lead to successful outcomes per segment,
 * channel, and context. Updates the strategy_weights table so the
 * Decision Engine can select higher-performing strategies over time.
 * This is the core of growth's compounding intelligence moat.
 *
 * Subscribes to: growth.outcome.recorded (from Outcome Recorder)
 * Publishes to:  growth.strategy.weights.updated (consumed by Decision Engine, Analytics)
 *
 * @module learning-service/strategy-tracker
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────
// Enums & Constants
// ─────────────────────────────────────────────────────────

const StrategyType = z.enum([
  'direct',           // Direct outreach — immediate value proposition
  're_engage',        // Re-engagement — revive cold contacts
  'trust_build',      // Trust building — nurture before ask
  'guided',           // Guided journey — step-by-step education
  'upsell',           // Upsell / expansion — existing customers
  'retention',        // Retention — prevent churn
  'referral',         // Referral — leverage satisfied customers
  'winback',          // Win-back — recover lost customers
]);

const SegmentType = z.enum([
  'new_lead',
  'warm_lead',
  'hot_lead',
  'active_customer',
  'at_risk',
  'churned',
  'champion',
  'enterprise',
  'smb',
  'unknown',
]);

const TOPIC_WEIGHTS_UPDATED = 'growth.strategy.weights.updated';

// Minimum sample size before weight is considered statistically meaningful
const MIN_SAMPLE_SIZE = 10;

// ─────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────

export const StrategyWeightSchema = z.object({
  weightId: z.string(),
  tenantId: z.string(),
  strategyType: z.string(),
  segment: z.string(),
  channel: z.string().optional(),

  // Win rate metrics
  totalAttempts: z.number().int().min(0),
  totalSuccesses: z.number().int().min(0),
  totalFailures: z.number().int().min(0),
  totalPartials: z.number().int().min(0),
  winRate: z.number().min(0).max(1),

  // Performance metrics
  avgConfidenceAtDecision: z.number().min(0).max(100).optional(),
  avgDurationDays: z.number().min(0).optional(),
  avgInteractions: z.number().min(0).optional(),
  totalRevenue: z.number().min(0).default(0),

  // Statistical confidence
  sampleSize: z.number().int().min(0),
  isStatisticallySignificant: z.boolean(),

  updatedAt: z.string().datetime(),
});

export type StrategyWeight = z.infer<typeof StrategyWeightSchema>;

export const StrategyUpdateInputSchema = z.object({
  tenantId: z.string().min(1),
  strategyType: z.string().min(1),
  segment: z.string().min(1),
  channel: z.string().optional(),

  // Outcome data
  result: z.enum(['success', 'partial', 'failure', 'expired', 'cancelled']),
  confidenceAtDecision: z.number().min(0).max(100).optional(),
  durationDays: z.number().min(0).optional(),
  interactions: z.number().int().min(0).optional(),
  revenueAmount: z.number().min(0).optional(),

  // Context
  outcomeId: z.string().optional(),
  contactId: z.string().optional(),
  objectiveId: z.string().optional(),
});

export type StrategyUpdateInput = z.infer<typeof StrategyUpdateInputSchema>;

export const StrategyTrackerResultSchema = z.object({
  tenantId: z.string(),
  strategyType: z.string(),
  segment: z.string(),
  channel: z.string().optional(),
  previousWinRate: z.number().nullable(),
  newWinRate: z.number(),
  sampleSize: z.number(),
  isStatisticallySignificant: z.boolean(),
  published: z.boolean(),
  error: z.string().nullable(),
});

export type StrategyTrackerResult = z.infer<typeof StrategyTrackerResultSchema>;

// ─────────────────────────────────────────────────────────
// Interfaces (Dependency Injection)
// ─────────────────────────────────────────────────────────

export interface StrategyWeightStore {
  /** Get current weight for a strategy/segment/channel combination */
  getWeight(
    tenantId: string,
    strategyType: string,
    segment: string,
    channel?: string,
  ): Promise<StrategyWeight | null>;

  /** Upsert (create or update) a strategy weight */
  upsertWeight(weight: StrategyWeight): Promise<{ success: boolean }>;

  /** Get all weights for a tenant (for Decision Engine context) */
  getWeightsByTenant(tenantId: string): Promise<StrategyWeight[]>;

  /** Get top-performing strategies for a segment */
  getTopStrategies(
    tenantId: string,
    segment: string,
    limit: number,
  ): Promise<StrategyWeight[]>;
}

export interface StrategyPubSubClient {
  publish(topic: string, data: Record<string, unknown>): Promise<{ messageId: string }>;
}

export interface StrategyTrackerDependencies {
  store: StrategyWeightStore;
  pubsub: StrategyPubSubClient;
}

// ─────────────────────────────────────────────────────────
// Win Rate Calculation
// ─────────────────────────────────────────────────────────

/**
 * Calculate win rate from outcome counts.
 * Partials count as 0.5 success for win rate purposes.
 */
function calculateWinRate(successes: number, partials: number, total: number): number {
  if (total === 0) return 0;
  const effectiveSuccesses = successes + (partials * 0.5);
  return Math.round((effectiveSuccesses / total) * 10000) / 10000; // 4 decimal precision
}

/**
 * Calculate running average with new value.
 */
function runningAverage(currentAvg: number | undefined, newValue: number | undefined, count: number): number | undefined {
  if (newValue === undefined) return currentAvg;
  if (currentAvg === undefined || count <= 1) return newValue;
  return ((currentAvg * (count - 1)) + newValue) / count;
}

// ─────────────────────────────────────────────────────────
// Event Builder
// ─────────────────────────────────────────────────────────

function buildWeightsUpdatedEvent(
  weight: StrategyWeight,
  previousWinRate: number | null,
): Record<string, unknown> {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'strategy.weights.updated',
    timestamp: weight.updatedAt,
    tenantId: weight.tenantId,
    weightId: weight.weightId,
    strategy: {
      type: weight.strategyType,
      segment: weight.segment,
      channel: weight.channel,
    },
    metrics: {
      previousWinRate,
      newWinRate: weight.winRate,
      sampleSize: weight.sampleSize,
      totalAttempts: weight.totalAttempts,
      totalSuccesses: weight.totalSuccesses,
      totalRevenue: weight.totalRevenue,
      isStatisticallySignificant: weight.isStatisticallySignificant,
    },
    performance: {
      avgConfidenceAtDecision: weight.avgConfidenceAtDecision,
      avgDurationDays: weight.avgDurationDays,
      avgInteractions: weight.avgInteractions,
    },
  };
}

// ─────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────

/**
 * Update strategy win rate based on an outcome.
 *
 * Flow:
 * 1. Fetch current weight for strategy/segment/channel combo
 * 2. Increment counters based on outcome result
 * 3. Recalculate win rate and running averages
 * 4. Persist updated weight
 * 5. Publish strategy.weights.updated event
 *
 * @param input - Outcome data with strategy context
 * @param deps  - Injected store and pubsub adapters
 * @returns Updated weight metrics
 */
export async function updateStrategyWeight(
  input: StrategyUpdateInput,
  deps: StrategyTrackerDependencies,
): Promise<StrategyTrackerResult> {
  const parsed = StrategyUpdateInputSchema.parse(input);

  // Step 1: Fetch current weight (or initialize)
  const existing = await deps.store.getWeight(
    parsed.tenantId,
    parsed.strategyType,
    parsed.segment,
    parsed.channel,
  );

  const previousWinRate = existing?.winRate ?? null;

  // Step 2: Calculate new counters
  const totalAttempts = (existing?.totalAttempts ?? 0) + 1;
  const totalSuccesses = (existing?.totalSuccesses ?? 0) + (parsed.result === 'success' ? 1 : 0);
  const totalFailures = (existing?.totalFailures ?? 0) + (parsed.result === 'failure' || parsed.result === 'expired' ? 1 : 0);
  const totalPartials = (existing?.totalPartials ?? 0) + (parsed.result === 'partial' ? 1 : 0);
  const sampleSize = totalSuccesses + totalFailures + totalPartials;
  const totalRevenue = (existing?.totalRevenue ?? 0) + (parsed.revenueAmount ?? 0);

  // Step 3: Recalculate win rate
  const winRate = calculateWinRate(totalSuccesses, totalPartials, sampleSize);
  const isStatisticallySignificant = sampleSize >= MIN_SAMPLE_SIZE;

  // Step 4: Update running averages
  const avgConfidenceAtDecision = runningAverage(
    existing?.avgConfidenceAtDecision, parsed.confidenceAtDecision, totalAttempts,
  );
  const avgDurationDays = runningAverage(
    existing?.avgDurationDays, parsed.durationDays, totalAttempts,
  );
  const avgInteractions = runningAverage(
    existing?.avgInteractions, parsed.interactions, totalAttempts,
  );

  const updatedAt = new Date().toISOString();
  const weightId = existing?.weightId ?? `sw_${crypto.randomUUID()}`;

  const weight: StrategyWeight = StrategyWeightSchema.parse({
    weightId,
    tenantId: parsed.tenantId,
    strategyType: parsed.strategyType,
    segment: parsed.segment,
    channel: parsed.channel,
    totalAttempts,
    totalSuccesses,
    totalFailures,
    totalPartials,
    winRate,
    avgConfidenceAtDecision,
    avgDurationDays,
    avgInteractions,
    totalRevenue,
    sampleSize,
    isStatisticallySignificant,
    updatedAt,
  });

  let published = false;
  let error: string | null = null;

  // Step 5: Persist updated weight
  try {
    await deps.store.upsertWeight(weight);
  } catch (err: any) {
    error = `Strategy weight upsert failed: ${err.message ?? 'Unknown error'}`;
    console.error(`[StrategyTracker] CRITICAL: Weight upsert failed for ${weightId}:`, err);
  }

  // Step 6: Publish weights updated event
  try {
    const event = buildWeightsUpdatedEvent(weight, previousWinRate);
    await deps.pubsub.publish(TOPIC_WEIGHTS_UPDATED, event);
    published = true;
  } catch (err: any) {
    const pubError = `Pub/Sub publish failed: ${err.message ?? 'Unknown error'}`;
    error = error ? `${error}; ${pubError}` : pubError;
    console.error(`[StrategyTracker] Pub/Sub publish failed for ${weightId}:`, err);
  }

  return StrategyTrackerResultSchema.parse({
    tenantId: parsed.tenantId,
    strategyType: parsed.strategyType,
    segment: parsed.segment,
    channel: parsed.channel,
    previousWinRate,
    newWinRate: winRate,
    sampleSize,
    isStatisticallySignificant,
    published,
    error,
  });
}

/**
 * Batch update strategy weights from multiple outcomes.
 */
export async function updateStrategyWeightBatch(
  inputs: StrategyUpdateInput[],
  deps: StrategyTrackerDependencies,
): Promise<StrategyTrackerResult[]> {
  // Process sequentially to avoid race conditions on the same weight row
  const results: StrategyTrackerResult[] = [];
  for (const input of inputs) {
    results.push(await updateStrategyWeight(input, deps));
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// In-Memory Adapters (for testing)
// ─────────────────────────────────────────────────────────

export class InMemoryStrategyWeightStore implements StrategyWeightStore {
  private weights: Map<string, StrategyWeight> = new Map();

  private makeKey(tenantId: string, strategyType: string, segment: string, channel?: string): string {
    return `${tenantId}:${strategyType}:${segment}:${channel ?? '_all'}`;
  }

  async getWeight(tenantId: string, strategyType: string, segment: string, channel?: string) {
    return this.weights.get(this.makeKey(tenantId, strategyType, segment, channel)) ?? null;
  }

  async upsertWeight(weight: StrategyWeight) {
    this.weights.set(
      this.makeKey(weight.tenantId, weight.strategyType, weight.segment, weight.channel),
      weight,
    );
    return { success: true };
  }

  async getWeightsByTenant(tenantId: string) {
    return Array.from(this.weights.values()).filter(w => w.tenantId === tenantId);
  }

  async getTopStrategies(tenantId: string, segment: string, limit: number) {
    return Array.from(this.weights.values())
      .filter(w => w.tenantId === tenantId && w.segment === segment)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, limit);
  }

  clear(): void { this.weights.clear(); }
}

export class InMemoryStrategyPubSubClient implements StrategyPubSubClient {
  private messages: Array<{ topic: string; data: Record<string, unknown>; messageId: string }> = [];

  async publish(topic: string, data: Record<string, unknown>) {
    const messageId = `msg_${crypto.randomUUID()}`;
    this.messages.push({ topic, data, messageId });
    return { messageId };
  }

  getMessages() { return this.messages; }

  getMessagesByTopic(topic: string) {
    return this.messages.filter(m => m.topic === topic).map(m => m.data);
  }

  clear(): void { this.messages = []; }
}

// ─────────────────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createStrategyTrackerRouter(
  deps: StrategyTrackerDependencies,
): Router {
  const router = Router();

  /**
   * POST /api/learning/strategy-weights
   * Update strategy weight from an outcome.
   */
  router.post('/strategy-weights', async (req: Request, res: Response) => {
    try {
      const input = StrategyUpdateInputSchema.parse(req.body);
      const result = await updateStrategyWeight(input, deps);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[StrategyTracker] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Strategy weight update failed',
      });
    }
  });

  /**
   * GET /api/learning/strategy-weights/:tenantId
   * Get all strategy weights for a tenant.
   */
  router.get('/strategy-weights/:tenantId', async (req: Request, res: Response) => {
    try {
      const weights = await deps.store.getWeightsByTenant(req.params.tenantId);
      res.json({ success: true, data: weights });
    } catch (err: any) {
      console.error('[StrategyTracker] Fetch error:', err);
      res.status(500).json({
        success: false,
        error: err.message ?? 'Failed to fetch strategy weights',
      });
    }
  });

  /**
   * GET /api/learning/strategy-weights/:tenantId/top/:segment
   * Get top-performing strategies for a segment.
   */
  router.get('/strategy-weights/:tenantId/top/:segment', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 5;
      const strategies = await deps.store.getTopStrategies(
        req.params.tenantId,
        req.params.segment,
        limit,
      );
      res.json({ success: true, data: strategies });
    } catch (err: any) {
      console.error('[StrategyTracker] Top strategies error:', err);
      res.status(500).json({
        success: false,
        error: err.message ?? 'Failed to fetch top strategies',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

export {
  calculateWinRate,
  buildWeightsUpdatedEvent,
  StrategyType,
  SegmentType,
  TOPIC_WEIGHTS_UPDATED,
  MIN_SAMPLE_SIZE,
};
