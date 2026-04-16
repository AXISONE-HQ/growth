/**
 * Audit Logger & action.executed Publisher — KAN-381
 *
 * Agent Dispatcher — EXECUTE phase, Final Step
 * Records every AI action to the immutable audit log and publishes
 * action.executed events to Pub/Sub for the Learning Service.
 *
 * Architecture reference:
 *   Agent Execution (Comms / Ops / Escalation)
 *       │
 *   Audit Logger
 *       │
 *   ┌───┴──────────────┬──────────────────┐
 *   Audit Log (DB)     action.executed     action.failed
 *                      (Pub/Sub)           (Pub/Sub)
 *
 * Audit entries are immutable — append-only with 2-year retention.
 * Every action the AI takes, blocks, or escalates is recorded.
 *
 * Event types published:
 *   - action.executed: Successful action completion
 *   - action.failed: Action failed after retries
 *   - action.blocked: Guardrail or permission check blocked the action
 *   - action.escalated: Action escalated to human
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const AuditActionType = z.enum([
  'message_sent',
  'message_failed',
  'crm_updated',
  'meeting_booked',
  'objective_closed',
  'follow_up_scheduled',
  'webhook_fired',
  'action_blocked',
  'action_escalated',
  'guardrail_violation',
]);

export const AuditActorType = z.enum([
  'ai_agent',
  'system',
  'human_operator',
]);

export const AuditEntrySchema = z.object({
  auditId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),
  decisionId: z.string(),
  actor: AuditActorType,
  actionType: AuditActionType,
  channel: z.string().nullable(),
  agentType: z.string(),
  status: z.string(),
  payload: z.record(z.unknown()),
  reasoning: z.string(),
  confidenceScore: z.number().nullable(),
  guardrailResult: z.record(z.unknown()).nullable(),
  durationMs: z.number().nullable(),
  createdAt: z.string().datetime(),
});

export const AuditLoggerInputSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  decisionId: z.string(),
  agentType: z.string(),
  channel: z.string().nullable(),

  // Action details
  actionType: z.string(),
  status: z.enum(['success', 'failed', 'blocked', 'escalated', 'partial', 'skipped']),
  payload: z.record(z.unknown()).default({}),
  reasoning: z.string().default(''),
  confidenceScore: z.number().nullable().default(null),

  // Optional enrichment
  guardrailResult: z.record(z.unknown()).nullable().default(null),
  executionResult: z.record(z.unknown()).nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  retryCount: z.number().default(0),
});

export const AuditLoggerResultSchema = z.object({
  auditId: z.string(),
  tenantId: z.string(),
  decisionId: z.string(),
  logged: z.boolean(),
  published: z.boolean(),
  publishedTopic: z.string().nullable(),
  error: z.string().nullable(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditLoggerInput = z.infer<typeof AuditLoggerInputSchema>;
export type AuditLoggerResult = z.infer<typeof AuditLoggerResultSchema>;

// ─────────────────────────────────────────────
// Storage & Pub/Sub Interfaces
// ─────────────────────────────────────────────

/**
 * Audit log storage — abstracts Cloud SQL for testability.
 * In production: Prisma insert into audit_log table.
 */
export interface AuditLogStore {
  append(entry: AuditEntry): Promise<{ success: boolean }>;
}

/**
 * Pub/Sub client — abstracts Cloud Pub/Sub for testability.
 */
export interface AuditPubSubClient {
  publish(topic: string, data: Record<string, unknown>): Promise<{ messageId: string }>;
}

// ─────────────────────────────────────────────
// Action Type Resolution
// ─────────────────────────────────────────────

/**
 * Map the raw action type + status to an audit action type.
 */
function resolveAuditActionType(
  actionType: string,
  status: string,
): z.infer<typeof AuditActionType> {
  // Status-based overrides
  if (status === 'blocked') return 'action_blocked';
  if (status === 'escalated') return 'action_escalated';

  // Action type mapping
  const actionMap: Record<string, z.infer<typeof AuditActionType>> = {
    send_email: status === 'success' ? 'message_sent' : 'message_failed',
    send_sms: status === 'success' ? 'message_sent' : 'message_failed',
    send_whatsapp: status === 'success' ? 'message_sent' : 'message_failed',
    update_crm: 'crm_updated',
    book_meeting: 'meeting_booked',
    close_objective: 'objective_closed',
    schedule_follow_up: 'follow_up_scheduled',
    webhook: 'webhook_fired',
  };

  return actionMap[actionType] ?? (status === 'success' ? 'message_sent' : 'message_failed');
}

// ─────────────────────────────────────────────
// Topic Resolution
// ─────────────────────────────────────────────

const TOPIC_PREFIX = 'growth';

/**
 * Determine which Pub/Sub topic to publish to based on status.
 */
function resolvePublishTopic(status: string): string {
  switch (status) {
    case 'success':
    case 'partial':
      return `${TOPIC_PREFIX}.action.executed`;
    case 'failed':
    case 'skipped':
      return `${TOPIC_PREFIX}.action.failed`;
    case 'blocked':
      return `${TOPIC_PREFIX}.action.blocked`;
    case 'escalated':
      return `${TOPIC_PREFIX}.action.escalated`;
    default:
      return `${TOPIC_PREFIX}.action.executed`;
  }
}

// ─────────────────────────────────────────────
// Event Builders
// ─────────────────────────────────────────────

/**
 * Build the Pub/Sub event payload for action execution events.
 */
function buildActionEvent(input: AuditLoggerInput, auditId: string): Record<string, unknown> {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: resolvePublishTopic(input.status).replace(`${TOPIC_PREFIX}.`, ''),
    timestamp: new Date().toISOString(),
    tenantId: input.tenantId,
    contactId: input.contactId,
    decisionId: input.decisionId,
    auditId,
    action: {
      type: input.actionType,
      agentType: input.agentType,
      channel: input.channel,
      status: input.status,
      confidenceScore: input.confidenceScore,
    },
    execution: {
      result: input.executionResult,
      error: input.errorMessage,
      durationMs: input.durationMs,
      retryCount: input.retryCount,
    },
    guardrail: input.guardrailResult,
  };
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

export interface AuditDependencies {
  store: AuditLogStore;
  pubsub: AuditPubSubClient;
}

/**
 * Log an action to the audit log and publish the execution event.
 *
 * @param input - Action execution details
 * @param deps - Injected store and pubsub adapters
 * @returns Audit result with log and publish status
 */
export async function logAndPublish(
  input: AuditLoggerInput,
  deps: AuditDependencies,
): Promise<AuditLoggerResult> {
  const parsed = AuditLoggerInputSchema.parse(input);
  const auditId = `aud_${crypto.randomUUID()}`;
  const auditActionType = resolveAuditActionType(parsed.actionType, parsed.status);

  // Step 1: Build audit entry
  const entry: AuditEntry = AuditEntrySchema.parse({
    auditId,
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    decisionId: parsed.decisionId,
    actor: 'ai_agent',
    actionType: auditActionType,
    channel: parsed.channel,
    agentType: parsed.agentType,
    status: parsed.status,
    payload: {
      ...parsed.payload,
      executionResult: parsed.executionResult,
      errorMessage: parsed.errorMessage,
    },
    reasoning: parsed.reasoning,
    confidenceScore: parsed.confidenceScore,
    guardrailResult: parsed.guardrailResult,
    durationMs: parsed.durationMs,
    createdAt: new Date().toISOString(),
  });

  let logged = false;
  let published = false;
  let publishedTopic: string | null = null;
  let error: string | null = null;

  // Step 2: Append to audit log (MUST succeed — this is the system of record)
  try {
    const storeResult = await deps.store.append(entry);
    logged = storeResult.success;
  } catch (err: any) {
    error = `Audit log write failed: ${err.message ?? 'Unknown error'}`;
    // Log write failures are critical — log to stderr as fallback
    console.error(`[AuditLogger] CRITICAL: Failed to write audit log entry ${auditId}:`, err);
  }

  // Step 3: Publish event to Pub/Sub (best-effort — audit log is primary)
  try {
    const topic = resolvePublishTopic(parsed.status);
    const event = buildActionEvent(parsed, auditId);
    await deps.pubsub.publish(topic, event);
    published = true;
    publishedTopic = topic;
  } catch (err: any) {
    const pubError = `Pub/Sub publish failed: ${err.message ?? 'Unknown error'}`;
    error = error ? `${error}; ${pubError}` : pubError;
    console.error(`[AuditLogger] Pub/Sub publish failed for ${auditId}:`, err);
  }

  return AuditLoggerResultSchema.parse({
    auditId,
    tenantId: parsed.tenantId,
    decisionId: parsed.decisionId,
    logged,
    published,
    publishedTopic,
    error,
  });
}

// ─────────────────────────────────────────────
// Batch Logger (for bulk operations)
// ─────────────────────────────────────────────

/**
 * Log multiple actions in a batch. Used for bulk imports or migrations.
 */
export async function logBatch(
  inputs: AuditLoggerInput[],
  deps: AuditDependencies,
): Promise<AuditLoggerResult[]> {
  return Promise.all(inputs.map(input => logAndPublish(input, deps)));
}

// ─────────────────────────────────────────────
// In-Memory Adapters (for testing)
// ─────────────────────────────────────────────

export class InMemoryAuditLogStore implements AuditLogStore {
  private entries: AuditEntry[] = [];

  async append(entry: AuditEntry) {
    this.entries.push(entry);
    return { success: true };
  }

  getEntries(): AuditEntry[] { return this.entries; }

  getByTenant(tenantId: string): AuditEntry[] {
    return this.entries.filter(e => e.tenantId === tenantId);
  }

  getByContact(contactId: string): AuditEntry[] {
    return this.entries.filter(e => e.contactId === contactId);
  }

  getByDecision(decisionId: string): AuditEntry[] {
    return this.entries.filter(e => e.decisionId === decisionId);
  }

  clear(): void { this.entries = []; }
}

export class InMemoryAuditPubSubClient implements AuditPubSubClient {
  private messages: Array<{ topic: string; data: Record<string, unknown>; messageId: string }> = [];

  async publish(topic: string, data: Record<string, unknown>) {
    const messageId = `msg_${crypto.randomUUID()}`;
    this.messages.push({ topic, data, messageId });
    return { messageId };
  }

  getMessages(): Array<{ topic: string; data: Record<string, unknown>; messageId: string }> {
    return this.messages;
  }

  getMessagesByTopic(topic: string): Array<Record<string, unknown>> {
    return this.messages.filter(m => m.topic === topic).map(m => m.data);
  }

  clear(): void { this.messages = []; }
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createAuditLoggerRouter(
  deps: AuditDependencies,
): Router {
  const router = Router();

  /**
   * POST /api/agent/audit
   * Log an action execution to the audit log.
   */
  router.post('/audit', async (req: Request, res: Response) => {
    try {
      const input = AuditLoggerInputSchema.parse(req.body);
      const result = await logAndPublish(input, deps);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[AuditLogger] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Audit logging failed',
      });
    }
  });

  /**
   * POST /api/agent/audit/batch
   * Log multiple action executions in batch.
   */
  router.post('/audit/batch', async (req: Request, res: Response) => {
    try {
      const inputs = z.array(AuditLoggerInputSchema).parse(req.body);
      const results = await logBatch(inputs, deps);
      res.json({ success: true, data: results });
    } catch (err: any) {
      console.error('[AuditLogger] Batch error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Batch audit logging failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  resolveAuditActionType,
  resolvePublishTopic,
  buildActionEvent,
};
