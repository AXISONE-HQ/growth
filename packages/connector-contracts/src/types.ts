/**
 * Core types shared across all channel integrations.
 */

import { z } from 'zod';

/** Supported channel types. Extend as new channels come online. */
export const ChannelTypeSchema = z.enum(['SMS', 'EMAIL', 'MESSENGER', 'WHATSAPP']);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

/** Provider identifier per channel. String so we can add without schema migration. */
export const ProviderSchema = z.string().min(1);
export type Provider = z.infer<typeof ProviderSchema>;

/** Lifecycle status of a ChannelConnection. */
export const ConnectionStatusSchema = z.enum([
  'PENDING', // Provisioning in flight
  'ACTIVE', // Ready to send/receive
  'SUSPENDED', // Temporarily paused (compliance, rate caps)
  'REVOKED', // Tenant-initiated disconnect
  'ERROR', // Health check failed — needs re-connect
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/** Reason classification for send failures. Drives retry decisions. */
export const ErrorClassSchema = z.enum(['transient', 'permanent']);
export type ErrorClass = z.infer<typeof ErrorClassSchema>;

/** The normalized shape every ChannelAdapter returns from send(). */
export const SendResultSchema = z.object({
  providerMessageId: z.string(),
  status: z.enum(['sent', 'queued', 'failed']),
  errorClass: ErrorClassSchema.optional(),
  errorMessage: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type SendResult = z.infer<typeof SendResultSchema>;

/** Outbound message — provider-agnostic. */
export const OutboundMessageSchema = z.object({
  tenantId: z.string().uuid(),
  actionId: z.string().uuid(),
  // KAN-657: decisionId + contactId required so the action.executed consumer
  // can correlate the executed event back to a Decision row + Contact row
  // when writing Outcome. decisionId is a Prisma cuid (not uuid). contactId
  // is a Prisma uuid.
  decisionId: z.string(),
  contactId: z.string().uuid(),
  traceId: z.string().optional(),
  recipient: z.object({
    phone: z.string().optional(),
    email: z.string().email().optional(),
    pageScopedUserId: z.string().optional(),
    displayName: z.string().optional(),
  }),
  content: z.object({
    subject: z.string().optional(),
    body: z.string(),
    html: z.string().optional(),
    attachments: z
      .array(z.object({ url: z.string().url(), filename: z.string() }))
      .optional(),
  }),
  categories: z.array(z.string()).optional(),
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

/** Normalized inbound event produced by adapter.handleWebhook(). */
export const InboundEventSchema = z.object({
  tenantId: z.string().uuid(),
  channel: ChannelTypeSchema,
  provider: ProviderSchema,
  fromIdentifier: z.string(), // phone, email, PSID, etc.
  threadKey: z.string().optional(), // stable per conversation
  rawMessage: z.string(),
  receivedAt: z.string().datetime(),
  providerMessageId: z.string(),
  raw: z.record(z.unknown()).optional(),
});
export type InboundEvent = z.infer<typeof InboundEventSchema>;

/** Health-check output. */
export const HealthStatusSchema = z.object({
  healthy: z.boolean(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  checkedAt: z.string().datetime(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/** Input to connect() — shape is adapter-specific (form fields, OAuth data). */
export const ConnectInputSchema = z.object({
  tenantId: z.string().uuid(),
  channel: ChannelTypeSchema,
  provider: ProviderSchema,
  params: z.record(z.unknown()), // per-adapter schema validates internally
});
export type ConnectInput = z.infer<typeof ConnectInputSchema>;

/** Minimal tenant shape adapters need — full Tenant lives in @growth/db. */
export const TenantRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  planTier: z.string(),
});
export type TenantRef = z.infer<typeof TenantRefSchema>;

/** ChannelConnection as returned across the wire. Mirrors the Prisma model. */
export const ChannelConnectionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  channelType: ChannelTypeSchema,
  provider: ProviderSchema,
  providerAccountId: z.string(),
  status: ConnectionStatusSchema,
  metadata: z.record(z.unknown()),
  complianceStatus: z.record(z.unknown()).nullable(),
  connectedAt: z.string().datetime().nullable(),
  lastHealthCheck: z.string().datetime().nullable(),
  healthStatus: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // credentialsRef intentionally NOT exposed on the wire
});
export type ChannelConnection = z.infer<typeof ChannelConnectionSchema>;
