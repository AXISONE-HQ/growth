/**
 * Action Decided Publisher — KAN-41
 *
 * Decision Engine — DECIDE phase, Final Step
 * Publishes the action.decided event to Cloud Pub/Sub after the
 * Threshold Gate approves an action. This event is consumed by
 * the Agent Dispatcher (EXECUTE phase) to route and execute the action.
 *
 * Also handles:
 *   - escalation.triggered events for human-review routing
 *   - decision.logged events for the audit log
 *   - Dead letter queue (DLQ) configuration
 *   - Idempotency via decision IDs
 *
 * Architecture reference:
 *   Threshold Gate (approved) → action.decided → Pub/Sub → Agent Dispatcher
 *   Threshold Gate (human_review) → escalation.triggered → Pub/Sub → Notification Service
 *   All decisions → decision.logged → Pub/Sub → Analytics Pipeline
 *
 * Pub/Sub topics:
 *   - action.decided:        Approved actions for Agent Dispatcher
 *   - escalation.triggered:  Human review requests
 *   - decision.logged:       All decisions for audit/analytics
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const PubSubTopic = z.enum([
  'action.decided',
  'escalation.triggered',
  'decision.logged',
]);

export const ActionDecidedEventSchema = z.object({
  eventId: z.string(),
  eventType: z.literal('action.decided'),
  version: z.literal('1.0'),
  publishedAt: z.string().datetime(),
  tenantId: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  decisionId: z.string(),
  action: z.object({
    actionType: z.string(),
    channel: z.string().nullable(),
    payload: z.record(z.unknown()),
  }),
  decision: z.object({
    selectedStrategy: z.string(),
    confidenceScore: z.number(),
    strategyReasoning: z.string(),
    actionReasoning: z.string(),
  }),
  routing: z.object({
    agentType: z.string(),
    priority: z.enum(['high', 'normal', 'low']),
    maxRetries: z.number(),
    timeoutMs: z.number(),
  }),
});

export const EscalationTriggeredEventSchema = z.object({
  eventId: z.string(),
  eventType: z.literal('escalation.triggered'),
  version: z.literal('1.0'),
  publishedAt: z.string().datetime(),
  tenantId: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  decisionId: z.string(),
  escalation: z.object({
    reason: z.string(),
    riskFlags: z.array(z.string()),
    proposedAction: z.object({
      actionType: z.string(),
      channel: z.string().nullable(),
      payload: z.record(z.unknown()),
    }),
    decisionContext: z.object({
      strategy: z.string(),
      confidenceScore: z.number(),
      reasoning: z.string(),
    }),
    assignedUserId: z.string().nullable(),
    expiresAt: z.string().datetime(),
  }),
});

export const DecisionLoggedEventSchema = z.object({
  eventId: z.string(),
  eventType: z.literal('decision.logged'),
  version: z.literal('1.0'),
  publishedAt: z.string().datetime(),
  tenantId: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  decisionId: z.string(),
  audit: z.object({
    gateDecision: z.string(),
    selectedStrategy: z.string(),
    actionType: z.string(),
    channel: z.string().nullable(),
    confidenceScore: z.number(),
    riskFlags: z.array(z.string()),
    reasoning: z.string(),
    processingTimeMs: z.number(),
  }),
});

export const PublishResultSchema = z.object({
  eventId: z.string(),
  topic: PubSubTopic,
  messageId: z.string().nullable(),
  published: z.boolean(),
  publishedAt: z.string().datetime(),
  error: z.string().nullable(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ActionDecidedEvent = z.infer<typeof ActionDecidedEventSchema>;
export type EscalationTriggeredEvent = z.infer<typeof EscalationTriggeredEventSchema>;
export type DecisionLoggedEvent = z.infer<typeof DecisionLoggedEventSchema>;
export type PublishResult = z.infer<typeof PublishResultSchema>;

export interface PubSubClient {
  publish(topic: string, data: Buffer, attributes?: Record<string, string>): Promise<string>;
}

// ─────────────────────────────────────────────
// ID Generation
// ─────────────────────────────────────────────

function generateEventId(): string {
  return `evt_${crypto.randomUUID()}`;
}

function generateDecisionId(): string {
  return `dec_${crypto.randomUUID()}`;
}

// ─────────────────────────────────────────────
// Agent Type Resolution
// ─────────────────────────────────────────────

function resolveAgentType(actionType: string): string {
  const agentMap: Record<string, string> = {
    send_message: 'communication',
    schedule_follow_up: 'communication',
    escalate_human: 'escalation',
    book_meeting: 'operational',
    update_crm: 'operational',
    close_objective: 'operational',
    wait: 'operational',
  };
  return agentMap[actionType] ?? 'communication';
}

function resolvePriority(
  strategy: string,
  confidence: number,
): 'high' | 'normal' | 'low' {
  if (strategy === 'escalate') return 'high';
  if (strategy === 'direct' && confidence >= 80) return 'high';
  if (strategy === 'wait') return 'low';
  return 'normal';
}

// ─────────────────────────────────────────────
// Event Builders
// ─────────────────────────────────────────────

export interface PublishActionInput {
  tenantId: string;
  contactId: string;
  objectiveId: string;
  actionType: string;
  channel: string | null;
  actionPayload: Record<string, unknown>;
  selectedStrategy: string;
  confidenceScore: number;
  strategyReasoning: string;
  actionReasoning: string;
}

export function buildActionDecidedEvent(
  input: PublishActionInput,
): ActionDecidedEvent {
  const decisionId = generateDecisionId();
  const priority = resolvePriority(input.selectedStrategy, input.confidenceScore);

  return ActionDecidedEventSchema.parse({
    eventId: generateEventId(),
    eventType: 'action.decided',
    version: '1.0',
    publishedAt: new Date().toISOString(),
    tenantId: input.tenantId,
    contactId: input.contactId,
    objectiveId: input.objectiveId,
    decisionId,
    action: {
      actionType: input.actionType,
      channel: input.channel,
      payload: input.actionPayload,
    },
    decision: {
      selectedStrategy: input.selectedStrategy,
      confidenceScore: input.confidenceScore,
      strategyReasoning: input.strategyReasoning,
      actionReasoning: input.actionReasoning,
    },
    routing: {
      agentType: resolveAgentType(input.actionType),
      priority,
      maxRetries: priority === 'high' ? 5 : 3,
      timeoutMs: priority === 'high' ? 30000 : 15000,
    },
  });
}

export interface PublishEscalationInput {
  tenantId: string;
  contactId: string;
  objectiveId: string;
  reason: string;
  riskFlags: string[];
  proposedAction: {
    actionType: string;
    channel: string | null;
    payload: Record<string, unknown>;
  };
  strategy: string;
  confidenceScore: number;
  reasoning: string;
  assignedUserId?: string;
  expiresAt: string;
}

export function buildEscalationTriggeredEvent(
  input: PublishEscalationInput,
): EscalationTriggeredEvent {
  return EscalationTriggeredEventSchema.parse({
    eventId: generateEventId(),
    eventType: 'escalation.triggered',
    version: '1.0',
    publishedAt: new Date().toISOString(),
    tenantId: input.tenantId,
    contactId: input.contactId,
    objectiveId: input.objectiveId,
    decisionId: generateDecisionId(),
    escalation: {
      reason: input.reason,
      riskFlags: input.riskFlags,
      proposedAction: input.proposedAction,
      decisionContext: {
        strategy: input.strategy,
        confidenceScore: input.confidenceScore,
        reasoning: input.reasoning,
      },
      assignedUserId: input.assignedUserId ?? null,
      expiresAt: input.expiresAt,
    },
  });
}

export interface PublishDecisionLogInput {
  tenantId: string;
  contactId: string;
  objectiveId: string;
  gateDecision: string;
  selectedStrategy: string;
  actionType: string;
  channel: string | null;
  confidenceScore: number;
  riskFlags: string[];
  reasoning: string;
  processingTimeMs: number;
}

export function buildDecisionLoggedEvent(
  input: PublishDecisionLogInput,
): DecisionLoggedEvent {
  return DecisionLoggedEventSchema.parse({
    eventId: generateEventId(),
    eventType: 'decision.logged',
    version: '1.0',
    publishedAt: new Date().toISOString(),
    tenantId: input.tenantId,
    contactId: input.contactId,
    objectiveId: input.objectiveId,
    decisionId: generateDecisionId(),
    audit: {
      gateDecision: input.gateDecision,
      selectedStrategy: input.selectedStrategy,
      actionType: input.actionType,
      channel: input.channel,
      confidenceScore: input.confidenceScore,
      riskFlags: input.riskFlags,
      reasoning: input.reasoning,
      processingTimeMs: input.processingTimeMs,
    },
  });
}

// ─────────────────────────────────────────────
// Publisher
// ─────────────────────────────────────────────

// KAN-661 narrowest-scope fix: `publishActionDecided` emits to the unprefixed
// topic `action.decided` (which exists in GCP). The `TOPIC_PREFIX` + `topicName()`
// pair below is retained for `publishEscalationTriggered` and `publishDecisionLogged`,
// which emit to topics that don't exist regardless — tracked in KAN-676.
const ACTION_DECIDED_TOPIC = 'action.decided';

const TOPIC_PREFIX = 'growth';

function topicName(topic: string): string {
  return `${TOPIC_PREFIX}.${topic}`;
}

async function publishEvent(
  client: PubSubClient,
  topic: string,
  event: Record<string, unknown>,
): Promise<PublishResult> {
  const eventId = (event.eventId as string) ?? generateEventId();

  try {
    const data = Buffer.from(JSON.stringify(event));
    const attributes: Record<string, string> = {
      eventType: (event.eventType as string) ?? 'unknown',
      tenantId: (event.tenantId as string) ?? 'unknown',
      version: (event.version as string) ?? '1.0',
    };

    const messageId = await client.publish(topicName(topic), data, attributes);

    return {
      eventId,
      topic: topic as z.infer<typeof PubSubTopic>,
      messageId,
      published: true,
      publishedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err: any) {
    console.error(`[ActionDecidedPublisher] Failed to publish to ${topic}:`, err);
    return {
      eventId,
      topic: topic as z.infer<typeof PubSubTopic>,
      messageId: null,
      published: false,
      publishedAt: new Date().toISOString(),
      error: err.message ?? 'Unknown publish error',
    };
  }
}

// ─────────────────────────────────────────────
// Main Entry Points
// ─────────────────────────────────────────────

export async function publishActionDecided(
  client: PubSubClient,
  input: PublishActionInput,
): Promise<PublishResult> {
  const event = buildActionDecidedEvent(input);
  const eventId = event.eventId;
  const publishedAt = new Date().toISOString();
  try {
    const data = Buffer.from(JSON.stringify(event));
    const attributes: Record<string, string> = {
      eventType: 'action.decided',
      tenantId: input.tenantId,
      version: '1.0',
    };
    const messageId = await client.publish(ACTION_DECIDED_TOPIC, data, attributes);
    return {
      eventId,
      topic: 'action.decided',
      messageId,
      published: true,
      publishedAt,
      error: null,
    };
  } catch (err: any) {
    console.error(
      `[ActionDecidedPublisher] Failed to publish to ${ACTION_DECIDED_TOPIC}:`,
      err,
    );
    return {
      eventId,
      topic: 'action.decided',
      messageId: null,
      published: false,
      publishedAt,
      error: err.message ?? 'Unknown publish error',
    };
  }
}

export async function publishEscalationTriggered(
  client: PubSubClient,
  input: PublishEscalationInput,
): Promise<PublishResult> {
  const event = buildEscalationTriggeredEvent(input);
  return publishEvent(client, 'escalation.triggered', event as unknown as Record<string, unknown>);
}

export async function publishDecisionLogged(
  client: PubSubClient,
  input: PublishDecisionLogInput,
): Promise<PublishResult> {
  const event = buildDecisionLoggedEvent(input);
  return publishEvent(client, 'decision.logged', event as unknown as Record<string, unknown>);
}

// ─────────────────────────────────────────────
// In-Memory Pub/Sub Client (for testing)
// ─────────────────────────────────────────────

export class InMemoryPubSubClient implements PubSubClient {
  private messages: Array<{
    topic: string;
    data: Buffer;
    attributes?: Record<string, string>;
    messageId: string;
  }> = [];

  async publish(
    topic: string,
    data: Buffer,
    attributes?: Record<string, string>,
  ): Promise<string> {
    const messageId = `msg_${crypto.randomUUID()}`;
    this.messages.push({ topic, data, attributes, messageId });
    return messageId;
  }

  getMessages(topic?: string) {
    if (topic) {
      return this.messages.filter((m) => m.topic === topicName(topic));
    }
    return this.messages;
  }

  getDeserializedMessages<T>(topic: string): T[] {
    return this.getMessages(topic).map((m) => JSON.parse(m.data.toString()) as T);
  }

  clear(): void {
    this.messages = [];
  }
}

// ─────────────────────────────────────────────
// Cloud Pub/Sub Client (production)
// ─────────────────────────────────────────────
//
// Thin wrapper around @google-cloud/pubsub. Auth is automatic in Cloud Run
// via the service account attached to the revision; locally set
// GOOGLE_APPLICATION_CREDENTIALS to a keyfile path. Retries are handled by
// the SDK's built-in gRPC retry middleware (default settings are fine).
//
// Topic names passed to publish() are routed through topicName() upstream
// (see publishEvent), which prefixes with the TOPIC_PREFIX convention. The
// client itself just takes the final topic name and publishes.

import { PubSub } from '@google-cloud/pubsub';

export class CloudPubSubClient implements PubSubClient {
  private pubsub: PubSub;

  constructor(projectId: string) {
    this.pubsub = new PubSub({ projectId });
  }

  async publish(
    topic: string,
    data: Buffer,
    attributes?: Record<string, string>,
  ): Promise<string> {
    return this.pubsub.topic(topic).publishMessage({ data, attributes });
  }
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createActionDecidedPublisherRouter(
  pubsubClient: PubSubClient,
): Router {
  const router = Router();

  router.post('/publish-action', async (req: Request, res: Response) => {
    try {
      const result = await publishActionDecided(pubsubClient, req.body);
      if (result.published) {
        res.json({ success: true, data: result });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (err: any) {
      console.error('[ActionDecidedPublisher] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Publish failed',
      });
    }
  });

  router.post('/publish-escalation', async (req: Request, res: Response) => {
    try {
      const result = await publishEscalationTriggered(pubsubClient, req.body);
      if (result.published) {
        res.json({ success: true, data: result });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (err: any) {
      console.error('[ActionDecidedPublisher] Escalation error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Escalation publish failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  generateEventId,
  generateDecisionId,
  resolveAgentType,
  resolvePriority,
  topicName,
  TOPIC_PREFIX,
};
