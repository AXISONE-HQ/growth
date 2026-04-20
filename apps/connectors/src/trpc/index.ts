/**
 * Connectors tRPC router — exposed on private VPC to the main app.
 * Manages ChannelConnection lifecycle on behalf of tenants.
 *
 * KAN-489: Connection Manager tRPC router
 * KAN-558: Implement connect/disconnect/list/health/reconnect
 */

import { initTRPC, TRPCError } from '@trpc/server';
import { ConnectorsRouterInputs } from '@growth/connector-contracts';
import { registry } from '../adapters/index.js';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create();

const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.isAuthed) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' });
  }
  return next({ ctx });
});

export const connectorsRouter = t.router({
  connect: authedProcedure.input(ConnectorsRouterInputs.connect).mutation(async ({ input }) => {
    const adapter = registry.get(input.channel, input.provider);
    // TODO(KAN-558): load TenantRef from DB, call adapter.connect, persist ChannelConnection
    throw new TRPCError({
      code: 'NOT_IMPLEMENTED',
      message: `connect() stub — real impl lands with the ${input.provider} adapter`,
    });
  }),

  disconnect: authedProcedure.input(ConnectorsRouterInputs.disconnect).mutation(async () => {
    // TODO(KAN-558): load connection, call adapter.disconnect, mark REVOKED
    throw new TRPCError({ code: 'NOT_IMPLEMENTED' });
  }),

  list: authedProcedure.input(ConnectorsRouterInputs.list).query(async () => {
    // TODO(KAN-558): SELECT from channel_connections WHERE tenant_id = ...
    return [];
  }),

  health: authedProcedure.input(ConnectorsRouterInputs.health).query(async () => {
    // TODO(KAN-558, KAN-560): load connection, call adapter.healthCheck
    return { healthy: false, reason: 'stub', checkedAt: new Date().toISOString() };
  }),

  reconnect: authedProcedure.input(ConnectorsRouterInputs.reconnect).mutation(async () => {
    throw new TRPCError({ code: 'NOT_IMPLEMENTED' });
  }),
});

export type ConnectorsRouter = typeof connectorsRouter;
