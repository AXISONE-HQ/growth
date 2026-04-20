/**
 * tRPC router input/output schemas for Connection Manager.
 *
 * The Connectors Service exposes this router on a private VPC port.
 * The main app (@growth-ai/api) calls it to manage channel
 * connections on behalf of tenants (from the Settings UI).
 *
 * We export the Zod schemas here so both sides agree on shape;
 * the actual router is built inside apps/connectors.
 */

import { z } from 'zod';
import { ChannelConnectionSchema, ChannelTypeSchema, ProviderSchema } from './types.js';

export const ConnectorsRouterInputs = {
  connect: z.object({
    tenantId: z.string().uuid(),
    channel: ChannelTypeSchema,
    provider: ProviderSchema,
    params: z.record(z.unknown()),
  }),
  disconnect: z.object({
    connectionId: z.string().uuid(),
  }),
  list: z.object({
    tenantId: z.string().uuid(),
  }),
  health: z.object({
    connectionId: z.string().uuid(),
  }),
  reconnect: z.object({
    connectionId: z.string().uuid(),
    params: z.record(z.unknown()).optional(),
  }),
} as const;

export const ConnectorsRouterOutputs = {
  connect: ChannelConnectionSchema,
  disconnect: z.object({ success: z.boolean() }),
  list: z.array(ChannelConnectionSchema),
  health: z.object({
    healthy: z.boolean(),
    reason: z.string().optional(),
    checkedAt: z.string().datetime(),
  }),
  reconnect: ChannelConnectionSchema,
} as const;
