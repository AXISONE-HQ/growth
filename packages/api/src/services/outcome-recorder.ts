/**
 * Outcome Recorder — Learning Service (LEARN Phase)
 *
 * Records objective completion/failure events and publishes outcome.recorded
 * events to Pub/Sub. This is the entry point for the learning loop: every
 * objective resolution (success, failure, expired, cancelled) flows through
 * here before feeding into strategy optimization and behavioral learning.
 *
 * Subscribes to: action.executed, action.failed, action.escalated (from Agent Dispatcher)
 * Publishes to:  growth.outcome.recorded (consumed by Brain Service, Learning Service, Analytics)
 *
 * @module learning-service/outcome-recorder
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────
// Enums & Constants
// ─────────────────────────────────────────────────────────

const OutcomeResult = z.enum([
  'success',        // Objective fully achieved
  'partial',        // Some sub-objectives met, not all
  'failure',        // Objective not achieved within window
  'expired',        // Time-based expiration
  'cancelled',      // Manually cancelled by user or system
]);

const ReasonCategory = z.enum([
  'converted',             // Contact converted (purchase, signup, etc.)
  'meeting_booked',        // Meeting/demo scheduled
  'proposal_accepted',     // Proposal or quote accepted
  're_engaged',            // Previously cold contact re-engaged
  'trust_built',           // Trust threshold reached (engagement score)
  'no_response',           // Contact never responded
  'opted_out',             // Contact unsubscribed / opted out
  'competitor_lost',       // Lost to competitor
  'budget_constraint',     // Contact cited budget issues
  'timing_not_right',      // Contact deferred / not ready
  'wrong_fit',             // Contact was not a good fit
  'escalated_unresolved',  // Escalated to human, never resolved
  'manual_close',          // Manually closed by tenant user
  'system_expiry',         // System TTL expired
]);

const TOPIC_OUTCOME_RECORDED = 'growth.outcome.recorded';

// ─────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────

export const OutcomeInputSchema = z.object({
  tenantId: z.string().min(1),
  contactId: z.string().min(1),
  objectiveId: z.string().min(1),
  decisionId: z.string().optional(),
  actionId: z.string().optional(),

  result: OutcomeResult,
  reasonCategory: ReasonCategory,
  reasonDetail: z.string().optional(),

  // Sub-objective completion snapshot at time of outcome
  subObjectiveSnapshot: z.array(z.object({
    subObjectiveId: z.string(),
    label: z.string(),
    completed: z.boolean(),
    completedAt: z.string().datetime().optional(),
  })).optional(),

  // Revenue attribution (if applicable)
  revenue: z.object({
    amount: z.number().min(0),
    currency: z.string().default('USD'),
    type: z.enum(['one_time', 'recurring', 'expansion']),
  }).optional(),

  // Strategy that was active when outcome occurred
  strategyUsed: z.string().optional(),
  channelUsed: z.string().optional(),
  confidenceAtDecision: z.number().min(0).max(100).optional(),

  // Timing
  objectiveStartedAt: z.string().datetime().optional(),
  totalInteractions: z.number().int().min(0).optional(),
  totalDurationDays: z.number().min(0).optional(),

  // Source of outcome resolution
  resolvedBy: z.enum(['ai_agent', 'human', 'system', 'webhook']).default('ai_agent'),
  metadata: z.record(z.unknown()).optional(),
});

export type OutcomeInput = z.infer<typeof OutcomeInputSchema>;

export const OutcomeEntrySchema = z.object({
  outcomeId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  decisionId: z.string().optional(),
  actionId: z.string().optional(),
  result: OutcomeResult,
  reasonCategory: ReasonCategory,
  reasonDetail: z.string().optional(),
  subObjectiveSnapshot: z.array(z.object({
    subObjectiveId: z.string(),
    label: z.string(),
    completed: z.boolean(),
    completedAt: z.string().datetime().optional(),
  })).optional(),
  revenue: z.object({
    amount: z.number(),
    currency: z.string(),
    type: z.enum(['one_time', 'recurring', 'expansion']),
  }).optional(),
  strategyUsed: z.string().optional(),
  channelUsed: z.string().optional(),
  confidenceAtDecision: z.number().optional(),
  objectiveStartedAt: z.string().datetime().optional(),
  totalInteractions: z.number().optional(),
  totalDurationDays: z.number().optional(),
  resolvedBy: z.string(),
  metadata: z.record(z.unknown()).optional(),
  recordedAt: z.string().datetime(),
});

export type OutcomeEntry = z.infer<typeof OutcomeEntrySchema>;

export const OutcomeResultSchema = z.object({
  outcomeId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  result: OutcomeResult,
  stored: z.boolean(),
  published: z.boolean(),
  publishedTopic: z.string().nullable(),
  error: z.string().nullable(),
});

export type OutcomeRecorderResult = z.infer<typeof OutcomeResultSchema>;

// ─────────────────────────────────────────────────────────
// Interfaces (Dependency Injection)
// ─────────────────────────────────────────────────────────

export interface OutcomeStore {
  /** Persist an outcome entry to the database */
  append(entry: OutcomeEntry): Promise<{ success: boolean }>;
  /** Update contact_state after outcome resolution */
  updateContactState(
    tenantId: string,
    contactId: string,
    objectiveId: string,
    result: string,
  ): Promise<{ success: boolean }>;
}

export interface OutcomePubSubClient {
  publish(topic: string, data: Record<string, unknown>): Promise<{ messageId: string }>;
}

export interface OutcomeDependencies {
  store: OutcomeStore;
  pubsub: OutcomePubSubClient;
}

// ─────────────────────────────────────────────────────────
// Event Builder
// ─────────────────────────────────────────────────────────

/**
 * Build the Pub/Sub event payload for outcome.recorded events.
 * Consumed by: Brain Service (update behavioral/outcome model),
 *              Strategy Tracker, Behavioral Learner, Analytics Pipeline.
 */
function buildOutcomeEvent(entry: OutcomeEntry): Record<string, unknown> {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'outcome.recorded',
    timestamp: entry.recordedAt,
    tenantId: entry.tenantId,
    contactId: entry.contactId,
    objectiveId: entry.objectiveId,
    outcomeId: entry.outcomeId,
    outcome: {
      result: entry.result,
      reasonCategory: entry.reasonCategory,
      reasonDetail: entry.reasonDetail,
    },
    strategy: {
      strategyUsed: entry.strategyUsed,
      channelUsed: entry.channelUsed,
      confidenceAtDecision: entry.confidenceAtDecision,
    },
    revenue: entry.revenue ?? null,
    timing: {
      objectiveStartedAt: entry.objectiveStartedAt,
      recordedAt: entry.recordedAt,
      totalInteractions: entry.totalInteractions,
      totalDurationDays: entry.totalDurationDays,
    },
    subObjectiveSnapshot: entry.subObjectiveSnapshot ?? [],
    resolvedBy: entry.resolvedBy,
  };
}

// ─────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────

/**
 * Record an objective outcome and publish the event.
 *
 * Flow:
 * 1. Validate and parse input
 * 2. Build outcome entry with generated outcomeId
 * 3. Persist to outcomes table (MUST succeed — system of record)
 * 4. Update contact_state to reflect objective resolution
 * 5. Publish outcome.recorded event to Pub/Sub (best-effort)
 *
 * @param input - Outcome details from Agent Dispatcher or human resolution
 * @param deps  - Injected store and pubsub adapters
 * @returns Outcome result with storage and publish status
 */
export async function recordOutcome(
  input: OutcomeInput,
  deps: OutcomeDependencies,
): Promise<OutcomeRecorderResult> {
  const parsed = OutcomeInputSchema.parse(input);
  const outcomeId = `out_${crypto.randomUUID()}`;
  const recordedAt = new Date().toISOString();

  // Step 1: Build outcome entry
  const entry: OutcomeEntry = OutcomeEntrySchema.parse({
    outcomeId,
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    objectiveId: parsed.objectiveId,
    decisionId: parsed.decisionId,
    actionId: parsed.actionId,
    result: parsed.result,
    reasonCategory: parsed.reasonCategory,
    reasonDetail: parsed.reasonDetail,
    subObjectiveSnapshot: parsed.subObjectiveSnapshot,
    revenue: parsed.revenue,
    strategyUsed: parsed.strategyUsed,
    channelUsed: parsed.channelUsed,
    confidenceAtDecision: parsed.confidenceAtDecision,
    objectiveStartedAt: parsed.objectiveStartedAt,
    totalInteractions: parsed.totalInteractions,
    totalDurationDays: parsed.totalDurationDays,
    resolvedBy: parsed.resolvedBy,
    metadata: parsed.metadata,
    recordedAt,
  });

  let stored = false;
  let published = false;
  let publishedTopic: string | null = null;
  let error: string | null = null;

  // Step 2: Persist outcome entry (MUST succeed)
  try {
    const storeResult = await deps.store.append(entry);
    stored = storeResult.success;
  } catch (err: any) {
    error = `Outcome store write failed: ${err.message ?? 'Unknown error'}`;
    console.error(`[OutcomeRecorder] CRITICAL: Failed to write outcome ${outcomeId}:`, err);
  }

  // Step 3: Update contact state to reflect resolution
  try {
    await deps.store.updateContactState(
      parsed.tenantId,
      parsed.contactId,
      parsed.objectiveId,
      parsed.result,
    );
  } catch (err: any) {
    const stateError = `Contact state update failed: ${err.message ?? 'Unknown error'}`;
    error = error ? `${error}; ${stateError}` : stateError;
    console.error(`[OutcomeRecorder] Contact state update failed for ${outcomeId}:`, err);
  }

  // Step 4: Publish outcome.recorded event (best-effort)
  try {
    const event = buildOutcomeEvent(entry);
    await deps.pubsub.publish(TOPIC_OUTCOME_RECORDED, event);
    published = true;
    publishedTopic = TOPIC_OUTCOME_RECORDED;
  } catch (err: any) {
    const pubError = `Pub/Sub publish failed: ${err.message ?? 'Unknown error'}`;
    error = error ? `${error}; ${pubError}` : pubError;
    console.error(`[OutcomeRecorder] Pub/Sub publish failed for ${outcomeId}:`, err);
  }

  return OutcomeResultSchema.parse({
    outcomeId,
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    objectiveId: parsed.objectiveId,
    result: parsed.result,
    stored,
    published,
    publishedTopic,
    error,
  });
}

// ─────────────────────────────────────────────────────────
// Batch Recorder (for bulk imports / migrations)
// ─────────────────────────────────────────────────────────

/**
 * Record multiple outcomes in a batch. Used for bulk imports,
 * historical data migration, or system-triggered expirations.
 */
export async function recordOutcomeBatch(
  inputs: OutcomeInput[],
  deps: OutcomeDependencies,
): Promise<OutcomeRecorderResult[]> {
  return Promise.all(inputs.map(input => recordOutcome(input, deps)));
}

// ─────────────────────────────────────────────────────────
// In-Memory Adapters (for testing)
// ─────────────────────────────────────────────────────────

export class InMemoryOutcomeStore implements OutcomeStore {
  private entries: OutcomeEntry[] = [];
  private contactStates: Map<string, { result: string }> = new Map();

  async append(entry: OutcomeEntry) {
    this.entries.push(entry);
    return { success: true };
  }

  async updateContactState(
    tenantId: string,
    contactId: string,
    objectiveId: string,
    result: string,
  ) {
    const key = `${tenantId}:${contactId}:${objectiveId}`;
    this.contactStates.set(key, { result });
    return { success: true };
  }

  getEntries(): OutcomeEntry[] { return this.entries; }

  getByTenant(tenantId: string): OutcomeEntry[] {
    return this.entries.filter(e => e.tenantId === tenantId);
  }

  getByContact(contactId: string): OutcomeEntry[] {
    return this.entries.filter(e => e.contactId === contactId);
  }

  getByObjective(objectiveId: string): OutcomeEntry[] {
    return this.entries.filter(e => e.objectiveId === objectiveId);
  }

  getByResult(result: string): OutcomeEntry[] {
    return this.entries.filter(e => e.result === result);
  }

  getContactState(tenantId: string, contactId: string, objectiveId: string) {
    return this.contactStates.get(`${tenantId}:${contactId}:${objectiveId}`);
  }

  clear(): void {
    this.entries = [];
    this.contactStates.clear();
  }
}

export class InMemoryOutcomePubSubClient implements OutcomePubSubClient {
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

export function createOutcomeRecorderRouter(
  deps: OutcomeDependencies,
): Router {
  const router = Router();

  /**
   * POST /api/learning/outcomes
   * Record an objective outcome.
   */
  router.post('/outcomes', async (req: Request, res: Response) => {
    try {
      const input = OutcomeInputSchema.parse(req.body);
      const result = await recordOutcome(input, deps);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[OutcomeRecorder] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Outcome recording failed',
      });
    }
  });

  /**
   * POST /api/learning/outcomes/batch
   * Record multiple outcomes in a batch.
   */
  router.post('/outcomes/batch', async (req: Request, res: Response) => {
    try {
      const inputs = z.array(OutcomeInputSchema).parse(req.body);
      const results = await recordOutcomeBatch(inputs, deps);
      res.json({ success: true, data: results });
    } catch (err: any) {
      console.error('[OutcomeRecorder] Batch error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Batch outcome recording failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

export { buildOutcomeEvent, OutcomeResult, ReasonCategory, TOPIC_OUTCOME_RECORDED };

