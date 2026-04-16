/**
 * Customer Health Scorer — Learning Service (LEARN Phase)
 *
 * Computes a composite health score (0–100) for each contact based on
 * engagement recency, frequency, sentiment, objective progress, and
 * revenue signals. Publishes customer.health.changed events when scores
 * cross tier boundaries, enabling proactive re-engagement or escalation.
 *
 * Subscribes to: growth.engagement.logged, growth.outcome.recorded,
 *                growth.behavioral.updated
 * Publishes to:  growth.customer.health.changed (consumed by Decision Engine,
 *                Brain Service, Analytics)
 *
 * @module learning-service/health-scorer
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const TOPIC_HEALTH_CHANGED = 'growth.customer.health.changed';

// Health tier boundaries
const HEALTH_TIERS = {
  critical: { min: 0, max: 20 },
  at_risk: { min: 21, max: 40 },
  needs_attention: { min: 41, max: 60 },
  healthy: { min: 61, max: 80 },
  thriving: { min: 81, max: 100 },
} as const;

// Score component weights (must sum to 1.0)
const WEIGHTS = {
  recency: 0.25,       // How recently did the contact engage?
  frequency: 0.20,     // How often does the contact engage?
  sentiment: 0.20,     // Net positive vs negative signals
  objectiveProgress: 0.20, // Sub-objective completion rate
  revenue: 0.15,       // Revenue signals and conversion indicators
} as const;

// Recency decay: days since last engagement → score
const RECENCY_DECAY = [
  { maxDays: 1, score: 100 },
  { maxDays: 3, score: 90 },
  { maxDays: 7, score: 75 },
  { maxDays: 14, score: 55 },
  { maxDays: 30, score: 35 },
  { maxDays: 60, score: 15 },
  { maxDays: Infinity, score: 5 },
];

// ─────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────

const HealthTier = z.enum(['critical', 'at_risk', 'needs_attention', 'healthy', 'thriving']);

export const HealthScoreSchema = z.object({
  scoreId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),

  // Composite score
  score: z.number().int().min(0).max(100),
  tier: HealthTier,
  previousScore: z.number().int().min(0).max(100).nullable(),
  previousTier: HealthTier.nullable(),
  tierChanged: z.boolean(),

  // Component breakdown
  components: z.object({
    recency: z.number().min(0).max(100),
    frequency: z.number().min(0).max(100),
    sentiment: z.number().min(0).max(100),
    objectiveProgress: z.number().min(0).max(100),
    revenue: z.number().min(0).max(100),
  }),

  // Input signals used for computation
  signals: z.object({
    daysSinceLastEngagement: z.number().nullable(),
    engagementCountLast30Days: z.number(),
    positiveSignals: z.number(),
    negativeSignals: z.number(),
    subObjectivesCompleted: z.number(),
    subObjectivesTotal: z.number(),
    hasRevenue: z.boolean(),
    revenueAmount: z.number(),
  }),

  computedAt: z.string().datetime(),
});

export type HealthScore = z.infer<typeof HealthScoreSchema>;

export const HealthScoreInputSchema = z.object({
  tenantId: z.string().min(1),
  contactId: z.string().min(1),

  // Engagement signals
  lastEngagementAt: z.string().datetime().nullable(),
  engagementCountLast30Days: z.number().int().min(0).default(0),
  positiveSignals: z.number().int().min(0).default(0),
  negativeSignals: z.number().int().min(0).default(0),

  // Objective progress
  subObjectivesCompleted: z.number().int().min(0).default(0),
  subObjectivesTotal: z.number().int().min(0).default(0),

  // Revenue signals
  hasRevenue: z.boolean().default(false),
  revenueAmount: z.number().min(0).default(0),
});

export type HealthScoreInput = z.infer<typeof HealthScoreInputSchema>;

export const HealthScorerResultSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  score: z.number(),
  tier: HealthTier,
  tierChanged: z.boolean(),
  stored: z.boolean(),
  published: z.boolean(),
  error: z.string().nullable(),
});

export type HealthScorerResult = z.infer<typeof HealthScorerResultSchema>;

// ─────────────────────────────────────────────────────────
// Interfaces (Dependency Injection)
// ─────────────────────────────────────────────────────────

export interface HealthScoreStore {
  getLatestScore(tenantId: string, contactId: string): Promise<HealthScore | null>;
  saveScore(score: HealthScore): Promise<{ success: boolean }>;
}

export interface HealthPubSubClient {
  publish(topic: string, data: Record<string, unknown>): Promise<{ messageId: string }>;
}

export interface HealthScorerDependencies {
  store: HealthScoreStore;
  pubsub: HealthPubSubClient;
}

// ─────────────────────────────────────────────────────────
// Score Computation
// ─────────────────────────────────────────────────────────

/**
 * Compute recency score based on days since last engagement.
 * Uses a stepped decay curve.
 */
export function computeRecencyScore(lastEngagementAt: string | null): number {
  if (!lastEngagementAt) return 0;
  const daysSince = (Date.now() - new Date(lastEngagementAt).getTime()) / (1000 * 60 * 60 * 24);
  for (const tier of RECENCY_DECAY) {
    if (daysSince <= tier.maxDays) return tier.score;
  }
  return 0;
}

/**
 * Compute frequency score based on engagement count in last 30 days.
 * Normalized: 0 engagements = 0, 10+ engagements = 100.
 */
export function computeFrequencyScore(engagementCount: number): number {
  const maxCount = 10; // 10+ engagements in 30 days is "max healthy"
  return Math.min(Math.round((engagementCount / maxCount) * 100), 100);
}

/**
 * Compute sentiment score from positive/negative signal ratio.
 * 100% positive = 100, 100% negative = 0, no signals = 50 (neutral).
 */
export function computeSentimentScore(positive: number, negative: number): number {
  const total = positive + negative;
  if (total === 0) return 50; // No data — neutral assumption
  const ratio = positive / total;
  return Math.round(ratio * 100);
}

/**
 * Compute objective progress score from sub-objective completion.
 * All done = 100, none done = 0, no objectives = 50 (neutral).
 */
export function computeObjectiveProgressScore(completed: number, total: number): number {
  if (total === 0) return 50; // No objectives assigned — neutral
  return Math.round((completed / total) * 100);
}

/**
 * Compute revenue score.
 * Has revenue = 100, has conversion signals = 60, neither = 20.
 */
export function computeRevenueScore(hasRevenue: boolean, revenueAmount: number): number {
  if (hasRevenue && revenueAmount > 0) return 100;
  if (hasRevenue) return 60;
  return 20;
}

/**
 * Resolve health tier from composite score.
 */
export function resolveHealthTier(score: number): z.infer<typeof HealthTier> {
  if (score <= HEALTH_TIERS.critical.max) return 'critical';
  if (score <= HEALTH_TIERS.at_risk.max) return 'at_risk';
  if (score <= HEALTH_TIERS.needs_attention.max) return 'needs_attention';
  if (score <= HEALTH_TIERS.healthy.max) return 'healthy';
  return 'thriving';
}

/**
 * Calculate days since last engagement. Returns null if no engagement.
 */
function daysSinceEngagement(lastEngagementAt: string | null): number | null {
  if (!lastEngagementAt) return null;
  return Math.round((Date.now() - new Date(lastEngagementAt).getTime()) / (1000 * 60 * 60 * 24));
}

// ─────────────────────────────────────────────────────────
// Event Builder
// ─────────────────────────────────────────────────────────

function buildHealthChangedEvent(score: HealthScore): Record<string, unknown> {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'customer.health.changed',
    timestamp: score.computedAt,
    tenantId: score.tenantId,
    contactId: score.contactId,
    scoreId: score.scoreId,
    health: {
      score: score.score,
      tier: score.tier,
      previousScore: score.previousScore,
      previousTier: score.previousTier,
      tierChanged: score.tierChanged,
    },
    components: score.components,
    signals: score.signals,
  };
}

// ─────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────

/**
 * Compute customer health score for a contact.
 *
 * Flow:
 * 1. Fetch previous score (if exists)
 * 2. Compute each component score
 * 3. Calculate weighted composite score
 * 4. Resolve tier and detect tier changes
 * 5. Persist new score
 * 6. Publish customer.health.changed if tier changed
 */
export async function computeHealthScore(
  input: HealthScoreInput,
  deps: HealthScorerDependencies,
): Promise<HealthScorerResult> {
  const parsed = HealthScoreInputSchema.parse(input);
  const computedAt = new Date().toISOString();
  const scoreId = `hs_${crypto.randomUUID()}`;

  // Step 1: Fetch previous score
  const previous = await deps.store.getLatestScore(parsed.tenantId, parsed.contactId);

  // Step 2: Compute component scores
  const components = {
    recency: computeRecencyScore(parsed.lastEngagementAt),
    frequency: computeFrequencyScore(parsed.engagementCountLast30Days),
    sentiment: computeSentimentScore(parsed.positiveSignals, parsed.negativeSignals),
    objectiveProgress: computeObjectiveProgressScore(parsed.subObjectivesCompleted, parsed.subObjectivesTotal),
    revenue: computeRevenueScore(parsed.hasRevenue, parsed.revenueAmount),
  };

  // Step 3: Weighted composite
  const rawScore =
    components.recency * WEIGHTS.recency +
    components.frequency * WEIGHTS.frequency +
    components.sentiment * WEIGHTS.sentiment +
    components.objectiveProgress * WEIGHTS.objectiveProgress +
    components.revenue * WEIGHTS.revenue;

  const score = Math.round(Math.max(0, Math.min(100, rawScore)));

  // Step 4: Resolve tier
  const tier = resolveHealthTier(score);
  const previousScore = previous?.score ?? null;
  const previousTier = previous?.tier ?? null;
  const tierChanged = previousTier !== null && previousTier !== tier;

  const healthScore: HealthScore = HealthScoreSchema.parse({
    scoreId,
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    score,
    tier,
    previousScore,
    previousTier,
    tierChanged,
    components,
    signals: {
      daysSinceLastEngagement: daysSinceEngagement(parsed.lastEngagementAt),
      engagementCountLast30Days: parsed.engagementCountLast30Days,
      positiveSignals: parsed.positiveSignals,
      negativeSignals: parsed.negativeSignals,
      subObjectivesCompleted: parsed.subObjectivesCompleted,
      subObjectivesTotal: parsed.subObjectivesTotal,
      hasRevenue: parsed.hasRevenue,
      revenueAmount: parsed.revenueAmount,
    },
    computedAt,
  });

  let stored = false;
  let published = false;
  let error: string | null = null;

  // Step 5: Persist
  try {
    await deps.store.saveScore(healthScore);
    stored = true;
  } catch (err: any) {
    error = `Health score save failed: ${err.message ?? 'Unknown error'}`;
    console.error(`[HealthScorer] CRITICAL: Score save failed for ${scoreId}:`, err);
  }

  // Step 6: Publish if tier changed (or always on first computation)
  if (tierChanged || previous === null) {
    try {
      const event = buildHealthChangedEvent(healthScore);
      await deps.pubsub.publish(TOPIC_HEALTH_CHANGED, event);
      published = true;
    } catch (err: any) {
      const pubError = `Pub/Sub publish failed: ${err.message ?? 'Unknown error'}`;
      error = error ? `${error}; ${pubError}` : pubError;
      console.error(`[HealthScorer] Pub/Sub publish failed for ${scoreId}:`, err);
    }
  }

  return HealthScorerResultSchema.parse({
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    score,
    tier,
    tierChanged,
    stored,
    published,
    error,
  });
}

/**
 * Batch compute health scores for multiple contacts.
 * Used by scheduled jobs to refresh scores periodically.
 */
export async function computeHealthScoreBatch(
  inputs: HealthScoreInput[],
  deps: HealthScorerDependencies,
): Promise<HealthScorerResult[]> {
  return Promise.all(inputs.map(input => computeHealthScore(input, deps)));
}

// ─────────────────────────────────────────────────────────
// In-Memory Adapters (for testing)
// ─────────────────────────────────────────────────────────

export class InMemoryHealthScoreStore implements HealthScoreStore {
  private scores: Map<string, HealthScore> = new Map();

  private makeKey(tenantId: string, contactId: string): string {
    return `${tenantId}:${contactId}`;
  }

  async getLatestScore(tenantId: string, contactId: string) {
    return this.scores.get(this.makeKey(tenantId, contactId)) ?? null;
  }

  async saveScore(score: HealthScore) {
    this.scores.set(this.makeKey(score.tenantId, score.contactId), score);
    return { success: true };
  }

  getAll(): HealthScore[] { return Array.from(this.scores.values()); }

  getByTier(tier: string): HealthScore[] {
    return Array.from(this.scores.values()).filter(s => s.tier === tier);
  }

  clear(): void { this.scores.clear(); }
}

export class InMemoryHealthPubSubClient implements HealthPubSubClient {
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

export function createHealthScorerRouter(
  deps: HealthScorerDependencies,
): Router {
  const router = Router();

  /**
   * POST /api/learning/health-scores
   * Compute health score for a contact.
   */
  router.post('/health-scores', async (req: Request, res: Response) => {
    try {
      const input = HealthScoreInputSchema.parse(req.body);
      const result = await computeHealthScore(input, deps);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[HealthScorer] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Health score computation failed',
      });
    }
  });

  /**
   * GET /api/learning/health-scores/:tenantId/:contactId
   * Get latest health score for a contact.
   */
  router.get('/health-scores/:tenantId/:contactId', async (req: Request, res: Response) => {
    try {
      const score = await deps.store.getLatestScore(req.params.tenantId, req.params.contactId);
      if (!score) {
        res.status(404).json({ success: false, error: 'No health score found' });
        return;
      }
      res.json({ success: true, data: score });
    } catch (err: any) {
      console.error('[HealthScorer] Fetch error:', err);
      res.status(500).json({
        success: false,
        error: err.message ?? 'Failed to fetch health score',
      });
    }
  });

  /**
   * POST /api/learning/health-scores/batch
   * Batch compute health scores.
   */
  router.post('/health-scores/batch', async (req: Request, res: Response) => {
    try {
      const inputs = z.array(HealthScoreInputSchema).parse(req.body);
      const results = await computeHealthScoreBatch(inputs, deps);
      res.json({ success: true, data: results });
    } catch (err: any) {
      console.error('[HealthScorer] Batch error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Batch health score computation failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

export {
  buildHealthChangedEvent,
  resolveHealthTier,
  HealthTier,
  TOPIC_HEALTH_CHANGED,
  HEALTH_TIERS,
  WEIGHTS,
  RECENCY_DECAY,
};
