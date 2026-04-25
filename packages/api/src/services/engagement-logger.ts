/**
 * Engagement Signal Logger — Learning Service (LEARN Phase)
 *
 * Logs engagement signals from all channels: opens, clicks, replies,
 * bounces, unsubscribes, form submissions, page visits, and meeting
 * completions. These signals feed into Behavioral Learning and
 * Customer Health Scoring.
 *
 * Subscribes to: action.executed (delivery confirmations), webhook events
 *                (Resend, Twilio, channel-specific callbacks)
 * Publishes to:  growth.engagement.logged (consumed by Behavioral Learner,
 *                Health Scorer, Analytics Pipeline)
 *
 * @module learning-service/engagement-logger
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────
// Enums & Constants
// ─────────────────────────────────────────────────────────

const EngagementType = z.enum([
  'email_open',
  'email_click',
  'email_reply',
  'email_bounce',
  'email_unsubscribe',
  'sms_reply',
  'sms_opt_out',
  'whatsapp_read',
  'whatsapp_reply',
  'form_submission',
  'page_visit',
  'meeting_booked',
  'meeting_completed',
  'meeting_no_show',
  'proposal_viewed',
  'proposal_signed',
  'call_answered',
  'call_missed',
  'chat_message',
  'webhook_received',
]);

const ChannelType = z.enum([
  'email',
  'sms',
  'whatsapp',
  'web',
  'chat',
  'phone',
  'meeting',
  'webhook',
]);

const SentimentSignal = z.enum([
  'positive',    // Reply indicating interest, acceptance
  'neutral',     // Informational reply, no strong signal
  'negative',    // Complaint, objection, disinterest
  'unknown',     // Cannot determine sentiment
]);

const TOPIC_ENGAGEMENT_LOGGED = 'growth.engagement.logged';

// ─────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────

export const EngagementInputSchema = z.object({
  tenantId: z.string().min(1),
  contactId: z.string().min(1),
  actionId: z.string().optional(),
  decisionId: z.string().optional(),
  objectiveId: z.string().optional(),

  engagementType: EngagementType,
  channel: ChannelType,

  // Timing context
  occurredAt: z.string().datetime().optional(),
  timeSinceActionMs: z.number().int().min(0).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  hourOfDay: z.number().int().min(0).max(23).optional(),

  // Content context
  messageId: z.string().optional(),
  linkUrl: z.string().url().optional(),
  pageUrl: z.string().url().optional(),
  replyContent: z.string().optional(),

  // Sentiment (AI-classified for replies)
  sentiment: SentimentSignal.optional(),

  // Source metadata (webhook provider, etc.)
  source: z.string().optional(),
  rawPayload: z.record(z.unknown()).optional(),
});

export type EngagementInput = z.infer<typeof EngagementInputSchema>;

export const EngagementEntrySchema = z.object({
  engagementId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),
  actionId: z.string().optional(),
  decisionId: z.string().optional(),
  objectiveId: z.string().optional(),
  engagementType: EngagementType,
  channel: ChannelType,
  occurredAt: z.string().datetime(),
  timeSinceActionMs: z.number().optional(),
  dayOfWeek: z.number().optional(),
  hourOfDay: z.number().optional(),
  messageId: z.string().optional(),
  linkUrl: z.string().optional(),
  pageUrl: z.string().optional(),
  sentiment: SentimentSignal.optional(),
  source: z.string().optional(),
  loggedAt: z.string().datetime(),
});

export type EngagementEntry = z.infer<typeof EngagementEntrySchema>;

export const EngagementResultSchema = z.object({
  engagementId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),
  engagementType: EngagementType,
  stored: z.boolean(),
  published: z.boolean(),
  error: z.string().nullable(),
});

export type EngagementResult = z.infer<typeof EngagementResultSchema>;

// ─────────────────────────────────────────────────────────
// Interfaces (Dependency Injection)
// ─────────────────────────────────────────────────────────

export interface EngagementStore {
  append(entry: EngagementEntry): Promise<{ success: boolean }>;
}

export interface EngagementPubSubClient {
  publish(topic: string, data: Record<string, unknown>): Promise<{ messageId: string }>;
}

export interface EngagementDependencies {
  store: EngagementStore;
  pubsub: EngagementPubSubClient;
}

// ─────────────────────────────────────────────────────────
// Signal Classification
// ─────────────────────────────────────────────────────────

/**
 * Classify an engagement signal as positive, negative, or neutral
 * for behavioral learning purposes. Used when no AI sentiment
 * classification is available.
 */
export function classifyEngagementSignal(
  engagementType: string,
): 'positive' | 'negative' | 'neutral' {
  const positiveSignals = new Set([
    'email_click', 'email_reply', 'sms_reply', 'whatsapp_reply',
    'form_submission', 'meeting_booked', 'meeting_completed',
    'proposal_viewed', 'proposal_signed', 'call_answered',
    'chat_message', 'whatsapp_read',
  ]);

  const negativeSignals = new Set([
    'email_bounce', 'email_unsubscribe', 'sms_opt_out',
    'meeting_no_show', 'call_missed',
  ]);

  if (positiveSignals.has(engagementType)) return 'positive';
  if (negativeSignals.has(engagementType)) return 'negative';
  return 'neutral';
}

/**
 * Compute time-of-day context for behavioral learning.
 * Returns day of week (0=Sunday) and hour of day.
 */
function computeTimeContext(occurredAt: string): { dayOfWeek: number; hourOfDay: number } {
  const date = new Date(occurredAt);
  return {
    dayOfWeek: date.getUTCDay(),
    hourOfDay: date.getUTCHours(),
  };
}

// ─────────────────────────────────────────────────────────
// Event Builder
// ─────────────────────────────────────────────────────────

function buildEngagementEvent(entry: EngagementEntry): Record<string, unknown> {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'engagement.logged',
    timestamp: entry.loggedAt,
    tenantId: entry.tenantId,
    contactId: entry.contactId,
    engagementId: entry.engagementId,
    engagement: {
      type: entry.engagementType,
      channel: entry.channel,
      sentiment: entry.sentiment,
      signalClass: classifyEngagementSignal(entry.engagementType),
    },
    timing: {
      occurredAt: entry.occurredAt,
      timeSinceActionMs: entry.timeSinceActionMs,
      dayOfWeek: entry.dayOfWeek,
      hourOfDay: entry.hourOfDay,
    },
    context: {
      actionId: entry.actionId,
      decisionId: entry.decisionId,
      objectiveId: entry.objectiveId,
      messageId: entry.messageId,
    },
  };
}

// ─────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────

/**
 * Log an engagement signal and publish the event.
 *
 * Flow:
 * 1. Validate and enrich input with time context
 * 2. Persist to engagement log
 * 3. Publish engagement.logged event to Pub/Sub
 *
 * @param input - Engagement signal from webhook or system event
 * @param deps  - Injected store and pubsub adapters
 * @returns Engagement result with storage and publish status
 */
export async function logEngagement(
  input: EngagementInput,
  deps: EngagementDependencies,
): Promise<EngagementResult> {
  const parsed = EngagementInputSchema.parse(input);
  const engagementId = `eng_${crypto.randomUUID()}`;
  const loggedAt = new Date().toISOString();
  const occurredAt = parsed.occurredAt ?? loggedAt;

  // Enrich with time context if not provided
  const timeContext = computeTimeContext(occurredAt);
  const dayOfWeek = parsed.dayOfWeek ?? timeContext.dayOfWeek;
  const hourOfDay = parsed.hourOfDay ?? timeContext.hourOfDay;

  const entry: EngagementEntry = EngagementEntrySchema.parse({
    engagementId,
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    actionId: parsed.actionId,
    decisionId: parsed.decisionId,
    objectiveId: parsed.objectiveId,
    engagementType: parsed.engagementType,
    channel: parsed.channel,
    occurredAt,
    timeSinceActionMs: parsed.timeSinceActionMs,
    dayOfWeek,
    hourOfDay,
    messageId: parsed.messageId,
    linkUrl: parsed.linkUrl,
    pageUrl: parsed.pageUrl,
    sentiment: parsed.sentiment,
    source: parsed.source,
    loggedAt,
  });

  let stored = false;
  let published = false;
  let error: string | null = null;

  // Step 1: Persist engagement entry
  try {
    const storeResult = await deps.store.append(entry);
    stored = storeResult.success;
  } catch (err: any) {
    error = `Engagement store write failed: ${err.message ?? 'Unknown error'}`;
    console.error(`[EngagementLogger] CRITICAL: Failed to write engagement ${engagementId}:`, err);
  }

  // Step 2: Publish engagement.logged event (best-effort)
  try {
    const event = buildEngagementEvent(entry);
    await deps.pubsub.publish(TOPIC_ENGAGEMENT_LOGGED, event);
    published = true;
  } catch (err: any) {
    const pubError = `Pub/Sub publish failed: ${err.message ?? 'Unknown error'}`;
    error = error ? `${error}; ${pubError}` : pubError;
    console.error(`[EngagementLogger] Pub/Sub publish failed for ${engagementId}:`, err);
  }

  return EngagementResultSchema.parse({
    engagementId,
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    engagementType: parsed.engagementType,
    stored,
    published,
    error,
  });
}

/**
 * Log multiple engagement signals in a batch.
 * Used for webhook batches (e.g., Resend event webhooks).
 */
export async function logEngagementBatch(
  inputs: EngagementInput[],
  deps: EngagementDependencies,
): Promise<EngagementResult[]> {
  return Promise.all(inputs.map(input => logEngagement(input, deps)));
}

// ─────────────────────────────────────────────────────────
// In-Memory Adapters (for testing)
// ─────────────────────────────────────────────────────────

export class InMemoryEngagementStore implements EngagementStore {
  private entries: EngagementEntry[] = [];


  async append(entry: EngagementEntry) {
    this.entries.push(entry);
    return { success: true };
  }

  getEntries(): EngagementEntry[] { return this.entries; }

  getByTenant(tenantId: string): EngagementEntry[] {
    return this.entries.filter(e => e.tenantId === tenantId);
  }

  getByContact(contactId: string): EngagementEntry[] {
    return this.entries.filter(e => e.contactId === contactId);
  }

  getByType(engagementType: string): EngagementEntry[] {
    return this.entries.filter(e => e.engagementType === engagementType);
  }

  getByChannel(channel: string): EngagementEntry[] {
    return this.entries.filter(e => e.channel === channel);
  }

  clear(): void { this.entries = []; }
}

export class InMemoryEngagementPubSubClient implements EngagementPubSubClient {
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

export function createEngagementLoggerRouter(
  deps: EngagementDependencies,
): Router {
  const router = Router();

  /**
   * POST /api/learning/engagements
   * Log a single engagement signal.
   */
  router.post('/engagements', async (req: Request, res: Response) => {
    try {
      const input = EngagementInputSchema.parse(req.body);
      const result = await logEngagement(input, deps);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[EngagementLogger] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Engagement logging failed',
      });
    }
  });

  /**
   * POST /api/learning/engagements/batch
   * Log multiple engagement signals (e.g., Resend webhook batch).
   */
  router.post('/engagements/batch', async (req: Request, res: Response) => {
    try {
      const inputs = z.array(EngagementInputSchema).parse(req.body);
      const results = await logEngagementBatch(inputs, deps);
      res.json({ success: true, data: results });
    } catch (err: any) {
      console.error('[EngagementLogger] Batch error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Batch engagement logging failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

export {
  classifyEngagementSignal as classifySignal,
  computeTimeContext,
  buildEngagementEvent,
  EngagementType,
  ChannelType,
  SentimentSignal,
  TOPIC_ENGAGEMENT_LOGGED,
};
