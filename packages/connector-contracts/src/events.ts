/**
 * Pub/Sub event schemas.
 *
 * Every event crossing the bus is validated against these Zod schemas
 * on both the publish and subscribe sides. This prevents schema drift
 * between services and gives us runtime type safety.
 */

import { z } from 'zod';
import {
  ChannelTypeSchema,
  InboundEventSchema,
  OutboundMessageSchema,
  ProviderSchema,
} from './types.js';

/** Topic names — keep as const for autocomplete. */
export const PUBSUB_TOPICS = {
  ACTION_SEND: 'action.send',
  ACTION_EXECUTED: 'action.executed',
  INBOUND_RAW: 'inbound.raw',
  CONNECTION_HEALTH_CHANGED: 'connection.health.changed',
} as const;
export type PubSubTopic = (typeof PUBSUB_TOPICS)[keyof typeof PUBSUB_TOPICS];

/** action.send — main app → Connectors. Wraps an OutboundMessage. */
export const ActionSendEventSchema = z.object({
  topic: z.literal(PUBSUB_TOPICS.ACTION_SEND),
  timestamp: z.string().datetime(),
  connectionId: z.string().uuid(),
  message: OutboundMessageSchema,
});
export type ActionSendEvent = z.infer<typeof ActionSendEventSchema>;

/** action.executed — Connectors → Agent Dispatcher + Learning Service. */
export const ActionExecutedEventSchema = z.object({
  topic: z.literal(PUBSUB_TOPICS.ACTION_EXECUTED),
  timestamp: z.string().datetime(),
  tenantId: z.string().uuid(),
  actionId: z.string().uuid(),
  // KAN-657: decisionId + contactId required so the outcome-writer can
  // construct Outcome rows linked to Decision + Contact. decisionId is
  // Prisma cuid (not uuid).
  decisionId: z.string(),
  contactId: z.string().uuid(),
  connectionId: z.string().uuid(),
  channel: ChannelTypeSchema,
  provider: ProviderSchema,
  status: z.enum(['sent', 'delivered', 'failed', 'suppressed']),
  providerMessageId: z.string().optional(),
  errorClass: z.enum(['transient', 'permanent']).optional(),
  errorMessage: z.string().optional(),
  attemptNumber: z.number().int().min(1).default(1),
});
export type ActionExecutedEvent = z.infer<typeof ActionExecutedEventSchema>;

/** inbound.raw — Connectors → Ingestion Service. Wraps InboundEvents. */
export const InboundRawEventSchema = z.object({
  topic: z.literal(PUBSUB_TOPICS.INBOUND_RAW),
  timestamp: z.string().datetime(),
  events: z.array(InboundEventSchema).min(1),
});
export type InboundRawEvent = z.infer<typeof InboundRawEventSchema>;

/** connection.health.changed — Connectors → main app (for UI + notifications). */
export const ConnectionHealthChangedEventSchema = z.object({
  topic: z.literal(PUBSUB_TOPICS.CONNECTION_HEALTH_CHANGED),
  timestamp: z.string().datetime(),
  tenantId: z.string().uuid(),
  connectionId: z.string().uuid(),
  channel: ChannelTypeSchema,
  provider: ProviderSchema,
  previousStatus: z.string(),
  newStatus: z.string(),
  reason: z.string().optional(),
});
export type ConnectionHealthChangedEvent = z.infer<
  typeof ConnectionHealthChangedEventSchema
>;

/** Discriminated union of all events — useful for typed routers. */
export const PubSubEventSchema = z.discriminatedUnion('topic', [
  ActionSendEventSchema,
  ActionExecutedEventSchema,
  InboundRawEventSchema,
  ConnectionHealthChangedEventSchema,
]);
export type PubSubEvent = z.infer<typeof PubSubEventSchema>;
