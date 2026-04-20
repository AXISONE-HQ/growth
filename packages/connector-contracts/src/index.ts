/**
 * @growth/connector-contracts
 *
 * Shared contracts between the main app (@growth-ai/api) and the
 * Connectors Service (@growth-ai/connectors).
 *
 * This package defines:
 *   - The ChannelAdapter interface every provider implements
 *   - Zod schemas for Pub/Sub event payloads
 *   - tRPC router types for connection management
 *   - Core types (ChannelType, ConnectionStatus, etc.)
 *
 * Keep this package pure: no runtime dependencies beyond Zod,
 * no Prisma client, no Hono, no Node APIs.
 */

export * from './types.js';
export * from './adapter.js';
export * from './events.js';
export * from './trpc.js';
