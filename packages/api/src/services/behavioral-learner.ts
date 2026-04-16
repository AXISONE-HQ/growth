/**
 * Behavioral Learning Aggregator — Learning Service (LEARN Phase)
 *
 * Aggregates behavioral patterns from engagement signals to learn
 * optimal timing, channel preferences, and message type effectiveness
 * per contact and segment. Feeds updated behavioral models back to
 * the Brain Service for smarter Decision Engine context.
 *
 * Subscribes to: growth.engagement.logged (from Engagement Logger)
 * Publishes to:  growth.behavioral.updated (consumed by Brain Service)
 *
 * @module learning-service/behavioral-learner
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const TOPIC_BEHAVIORAL_UPDATED = 'growth.behavioral.updated';

// Decay factor for exponential moving average (recent signals weighted higher)
const EMA_ALPHA = 0.3;

// ─────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────

/**
 * Per-contact behavioral profile learned from engagement signals.
 * Stored per tenant + contact, updated incrementally.
 */
export const BehavioralProfileSchema = z.object({
  profileId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),

  // Best time to reach this contact
  timing: z.object({
    bestDayOfWeek: z.number().int().min(0).max(6).nullable(),
    bestHourOfDay: z.number().int().min(0).max(23).nullable(),
    dayDistribution: z.array(z.number()).length(7),     // engagement count per day (Sun–Sat)
    hourDistribution: z.array(z.number()).length(24),    // engagement count per hour (0–23)
    avgResponseTimeMs: z.number().nullable(),
  }),

  // Channel preference ranking
  channels: z.object({
    preferred: z.string().nullable(),
    scores: z.record(z.number()),       // channel → engagement score
    responseCounts: z.record(z.number()),  // channel → positive response count
  }),

  // Message/content type effectiveness
  contentPreferences: z.object({
    engagementByType: z.record(z.number()),   // engagementType → count
    positiveSignals: z.number(),
    negativeSignals: z.number(),
    neutralSignals: z.number(),
  }),

  // Engagement velocity (how frequently this contact engages)
  velocity: z.object({
    totalEngagements: z.number().int().min(0),
    last7Days: z.number().int().min(0),
    last30Days: z.number().int().min(0),
    engagementRate: z.number().min(0),   // EMA-smoothed engagement rate
  }),

  lastEngagementAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export type BehavioralProfile = z.infer<typeof BehavioralProfileSchema>;

export const BehavioralUpdateInputSchema = z.object({
  tenantId: z.string().min(1),
  contactId: z.string().min(1),

  engagementType: z.string(),
  channel: z.string(),
  signalClass: z.enum(['positive', 'negative', 'neutral']),

  // Timing data
  dayOfWeek: z.number().int().min(0).max(6),
  hourOfDay: z.number().int().min(0).max(23),
  responseTimeMs: z.number().int().min(0).optional(),

  occurredAt: z.string().datetime(),
});

export type BehavioralUpdateInput = z.infer<typeof BehavioralUpdateInputSchema>;

export const BehavioralLearnerResultSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  profileUpdated: z.boolean(),
  published: z.boolean(),
  bestDayOfWeek: z.number().nullable(),
  bestHourOfDay: z.number().nullable(),
  preferredChannel: z.string().nullable(),
  totalEngagements: z.number(),
  error: z.string().nullable(),
});

export type BehavioralLearnerResult = z.infer<typeof BehavioralLearnerResultSchema>;

// ─────────────────────────────────────────────────────────
// Interfaces (Dependency Injection)
// ─────────────────────────────────────────────────────────

export interface BehavioralProfileStore {
  getProfile(tenantId: string, contactId: string): Promise<BehavioralProfile | null>;
  upsertProfile(profile: BehavioralProfile): Promise<{ success: boolean }>;
}

export interface BehavioralPubSubClient {
  publish(topic: string, data: Record<string, unknown>): Promise<{ messageId: string }>;
}

export interface BehavioralLearnerDependencies {
  store: BehavioralProfileStore;
  pubsub: BehavioralPubSubClient;
}

// ─────────────────────────────────────────────────────────
// Profile Initialization
// ─────────────────────────────────────────────────────────

function createEmptyProfile(tenantId: string, contactId: string): BehavioralProfile {
  return {
    profileId: `bp_${crypto.randomUUID()}`,
    tenantId,
    contactId,
    timing: {
      bestDayOfWeek: null,
      bestHourOfDay: null,
      dayDistribution: [0, 0, 0, 0, 0, 0, 0],
      hourDistribution: Array(24).fill(0),
      avgResponseTimeMs: null,
    },
    channels: {
      preferred: null,
      scores: {},
      responseCounts: {},
    },
    contentPreferences: {
      engagementByType: {},
      positiveSignals: 0,
      negativeSignals: 0,
      neutralSignals: 0,
    },
    velocity: {
      totalEngagements: 0,
      last7Days: 0,
      last30Days: 0,
      engagementRate: 0,
    },
    lastEngagementAt: null,
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────
// Learning Algorithms
// ─────────────────────────────────────────────────────────

/**
 * Find the index of the maximum value in an array.
 * Returns null if all values are zero.
 */
function findPeakIndex(arr: number[]): number | null {
  let maxVal = 0;
  let maxIdx: number | null = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > maxVal) {
      maxVal = arr[i];
      maxIdx = i;
    }
  }
  return maxIdx;
}

/**
 * Determine preferred channel from scores.
 * Only positive signals count toward channel preference.
 */
function resolvePreferredChannel(scores: Record<string, number>): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const [channel, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = channel;
    }
  }
  return best;
}

/**
 * Exponential moving average update.
 */
function emaUpdate(current: number, newValue: number): number {
  return EMA_ALPHA * newValue + (1 - EMA_ALPHA) * current;
}

/**
 * Running average with new data point.
 */
function updateRunningAvg(currentAvg: number | null, newValue: number, count: number): number {
  if (currentAvg === null || count <= 1) return newValue;
  return ((currentAvg * (count - 1)) + newValue) / count;
}

// ─────────────────────────────────────────────────────────
// Event Builder
// ─────────────────────────────────────────────────────────

function buildBehavioralEvent(profile: BehavioralProfile): Record<string, unknown> {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'behavioral.updated',
    timestamp: profile.updatedAt,
    tenantId: profile.tenantId,
    contactId: profile.contactId,
    profileId: profile.profileId,
    timing: {
      bestDayOfWeek: profile.timing.bestDayOfWeek,
      bestHourOfDay: profile.timing.bestHourOfDay,
      avgResponseTimeMs: profile.timing.avgResponseTimeMs,
    },
    channels: {
      preferred: profile.channels.preferred,
      scores: profile.channels.scores,
    },
    velocity: {
      totalEngagements: profile.velocity.totalEngagements,
      engagementRate: profile.velocity.engagementRate,
    },
    sentiment: {
      positiveSignals: profile.contentPreferences.positiveSignals,
      negativeSignals: profile.contentPreferences.negativeSignals,
      neutralSignals: profile.contentPreferences.neutralSignals,
    },
  };
}

// ─────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────

/**
 * Update a contact's behavioral profile based on an engagement signal.
 *
 * Flow:
 * 1. Fetch existing profile or create empty
 * 2. Update timing distributions
 * 3. Update channel scores
 * 4. Update content preferences and signal counts
 * 5. Update engagement velocity
 * 6. Recalculate best time/channel
 * 7. Persist updated profile
 * 8. Publish behavioral.updated event to Pub/Sub → Brain Service
 */
export async function updateBehavioralProfile(
  input: BehavioralUpdateInput,
  deps: BehavioralLearnerDependencies,
): Promise<BehavioralLearnerResult> {
  const parsed = BehavioralUpdateInputSchema.parse(input);
  const updatedAt = new Date().toISOString();

  // Step 1: Fetch or initialize profile
  let profile = await deps.store.getProfile(parsed.tenantId, parsed.contactId);
  if (!profile) {
    profile = createEmptyProfile(parsed.tenantId, parsed.contactId);
  }

  // Step 2: Update timing distributions (only positive/neutral signals improve timing)
  if (parsed.signalClass !== 'negative') {
    profile.timing.dayDistribution[parsed.dayOfWeek] += 1;
    profile.timing.hourDistribution[parsed.hourOfDay] += 1;
  }

  // Update response time average
  if (parsed.responseTimeMs !== undefined) {
    profile.timing.avgResponseTimeMs = updateRunningAvg(
      profile.timing.avgResponseTimeMs,
      parsed.responseTimeMs,
      profile.velocity.totalEngagements + 1,
    );
  }

  // Step 3: Update channel scores
  const channelWeight = parsed.signalClass === 'positive' ? 1 : parsed.signalClass === 'neutral' ? 0.3 : -0.5;
  profile.channels.scores[parsed.channel] = (profile.channels.scores[parsed.channel] ?? 0) + channelWeight;

  if (parsed.signalClass === 'positive') {
    profile.channels.responseCounts[parsed.channel] = (profile.channels.responseCounts[parsed.channel] ?? 0) + 1;
  }

  // Step 4: Update content preferences
  profile.contentPreferences.engagementByType[parsed.engagementType] =
    (profile.contentPreferences.engagementByType[parsed.engagementType] ?? 0) + 1;

  if (parsed.signalClass === 'positive') profile.contentPreferences.positiveSignals += 1;
  else if (parsed.signalClass === 'negative') profile.contentPreferences.negativeSignals += 1;
  else profile.contentPreferences.neutralSignals += 1;

  // Step 5: Update velocity
  profile.velocity.totalEngagements += 1;
  profile.velocity.engagementRate = emaUpdate(profile.velocity.engagementRate, 1);

  // Step 6: Recalculate peaks
  profile.timing.bestDayOfWeek = findPeakIndex(profile.timing.dayDistribution);
  profile.timing.bestHourOfDay = findPeakIndex(profile.timing.hourDistribution);
  profile.channels.preferred = resolvePreferredChannel(profile.channels.scores);

  // Step 7: Update timestamps
  profile.lastEngagementAt = parsed.occurredAt;
  profile.updatedAt = updatedAt;

  let profileUpdated = false;
  let published = false;
  let error: string | null = null;

  // Step 8: Persist
  try {
    await deps.store.upsertProfile(profile);
    profileUpdated = true;
  } catch (err: any) {
    error = `Profile upsert failed: ${err.message ?? 'Unknown error'}`;
    console.error(`[BehavioralLearner] CRITICAL: Profile upsert failed for ${profile.profileId}:`, err);
  }

  // Step 9: Publish to Brain Service
  try {
    const event = buildBehavioralEvent(profile);
    await deps.pubsub.publish(TOPIC_BEHAVIORAL_UPDATED, event);
    published = true;
  } catch (err: any) {
    const pubError = `Pub/Sub publish failed: ${err.message ?? 'Unknown error'}`;
    error = error ? `${error}; ${pubError}` : pubError;
    console.error(`[BehavioralLearner] Pub/Sub publish failed for ${profile.profileId}:`, err);
  }

  return BehavioralLearnerResultSchema.parse({
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    profileUpdated,
    published,
    bestDayOfWeek: profile.timing.bestDayOfWeek,
    bestHourOfDay: profile.timing.bestHourOfDay,
    preferredChannel: profile.channels.preferred,
    totalEngagements: profile.velocity.totalEngagements,
    error,
  });
}

/**
 * Batch update behavioral profiles from multiple engagement signals.
 */
export async function updateBehavioralProfileBatch(
  inputs: BehavioralUpdateInput[],
  deps: BehavioralLearnerDependencies,
): Promise<BehavioralLearnerResult[]> {
  // Group by contact to process sequentially per contact (avoid races)
  const byContact = new Map<string, BehavioralUpdateInput[]>();
  for (const input of inputs) {
    const key = `${input.tenantId}:${input.contactId}`;
    if (!byContact.has(key)) byContact.set(key, []);
    byContact.get(key)!.push(input);
  }

  const results: BehavioralLearnerResult[] = [];
  for (const [, contactInputs] of byContact) {
    for (const input of contactInputs) {
      results.push(await updateBehavioralProfile(input, deps));
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// In-Memory Adapters (for testing)
// ─────────────────────────────────────────────────────────

export class InMemoryBehavioralProfileStore implements BehavioralProfileStore {
  private profiles: Map<string, BehavioralProfile> = new Map();

  private makeKey(tenantId: string, contactId: string): string {
    return `${tenantId}:${contactId}`;
  }

  async getProfile(tenantId: string, contactId: string) {
    return this.profiles.get(this.makeKey(tenantId, contactId)) ?? null;
  }

  async upsertProfile(profile: BehavioralProfile) {
    this.profiles.set(this.makeKey(profile.tenantId, profile.contactId), profile);
    return { success: true };
  }

  getAll(): BehavioralProfile[] { return Array.from(this.profiles.values()); }

  clear(): void { this.profiles.clear(); }
}

export class InMemoryBehavioralPubSubClient implements BehavioralPubSubClient {
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

export function createBehavioralLearnerRouter(
  deps: BehavioralLearnerDependencies,
): Router {
  const router = Router();

  /**
   * POST /api/learning/behavioral
   * Update behavioral profile from an engagement signal.
   */
  router.post('/behavioral', async (req: Request, res: Response) => {
    try {
      const input = BehavioralUpdateInputSchema.parse(req.body);
      const result = await updateBehavioralProfile(input, deps);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[BehavioralLearner] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Behavioral profile update failed',
      });
    }
  });

  /**
   * GET /api/learning/behavioral/:tenantId/:contactId
   * Get a contact's behavioral profile.
   */
  router.get('/behavioral/:tenantId/:contactId', async (req: Request, res: Response) => {
    try {
      const profile = await deps.store.getProfile(req.params.tenantId, req.params.contactId);
      if (!profile) {
        res.status(404).json({ success: false, error: 'Profile not found' });
        return;
      }
      res.json({ success: true, data: profile });
    } catch (err: any) {
      console.error('[BehavioralLearner] Fetch error:', err);
      res.status(500).json({
        success: false,
        error: err.message ?? 'Failed to fetch behavioral profile',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

export {
  findPeakIndex,
  resolvePreferredChannel,
  emaUpdate,
  buildBehavioralEvent,
  TOPIC_BEHAVIORAL_UPDATED,
  EMA_ALPHA,
};
