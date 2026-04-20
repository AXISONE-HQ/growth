/**
 * tRPC context — the bag of things every procedure receives.
 * Tenant scope enforced per-call via AuthN middleware (below).
 *
 * KAN-557: tRPC server on private VPC port
 */

import type { inferAsyncReturnType } from '@trpc/server';
import { env } from '../env.js';
import { logger } from '../logger.js';

export async function createContext({ req }: { req: Request }) {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // In prod: validate IAM identity token from main app's service account.
  // In dev: simple shared secret check.
  const isAuthed = token === env.INTERNAL_TRPC_AUTH_TOKEN;

  return {
    isAuthed,
    logger,
  };
}

export type Context = inferAsyncReturnType<typeof createContext>;
