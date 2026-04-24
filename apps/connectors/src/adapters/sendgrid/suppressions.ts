/**
 * Per-tenant email suppression cache + hooks.
 *
 * Two tiers of suppression:
 *   1. Channel-level: Redis set per tenant, checked before every send
 *      (mirror of SendGrid's own suppression — we check ours first so
 *      we never hit their API unnecessarily and never wait for their
 *      cache to warm).
 *   2. SendGrid-level: Their global/group suppression lists.
 *      They reject sends to suppressed addresses at the API layer.
 *
 * CAN-SPAM/CASL/GDPR require honoring unsubscribes within 10 days; we do
 * it within seconds via the Event Webhook handler.
 *
 * KAN-506: Suppression list and unsubscribe management
 * KAN-608: Per-tenant suppressions table
 */

import Redis from 'ioredis';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { prisma } from '../../repository/connection-repository.js';

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
    redis.on('error', (err) => logger.warn({ err }, 'redis email suppression client error'));
  }
  return redis;
}

function key(tenantId: string): string {
  return `email:suppress:${tenantId}`;
}

export type SuppressionReason = 'bounce' | 'spam' | 'unsubscribe' | 'manual';

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** True if this email is suppressed for this tenant. Fail-open. */
export async function isSuppressed(tenantId: string, email: string): Promise<boolean> {
  try {
    const result = await getRedis().sismember(key(tenantId), normalize(email));
    return result === 1;
  } catch (err) {
    logger.error({ err, tenantId }, 'suppression check failed — allowing send');
    return false;
  }
}

/** Add an email to the suppression set. Reason captured for audit + analytics. */
export async function suppress(
  tenantId: string,
  email: string,
  reason: SuppressionReason,
): Promise<void> {
  const normalized = normalize(email);
  await getRedis().sadd(key(tenantId), normalized);
  // Also store reason in a secondary hash for later inspection
  await getRedis().hset(`${key(tenantId)}:reason`, normalized, reason);
  logger.info({ tenantId, email: normalized, reason }, 'email suppressed');
}

/** Remove from suppressions — user re-subscribed via landing page. */
export async function unsuppress(tenantId: string, email: string): Promise<void> {
  const normalized = normalize(email);
  await getRedis().srem(key(tenantId), normalized);
  await getRedis().hdel(`${key(tenantId)}:reason`, normalized);
  logger.info({ tenantId, email: normalized }, 'email un-suppressed');
}

// ─────────────────────────────────────────────
// KAN-661: Prisma-backed EmailSuppression helpers
// Used by SendGrid adapter simple-mode path and the /unsubscribe handler.
// Redis helpers above remain for KAN-473 subuser mode (unchanged).
// ─────────────────────────────────────────────

export type DbSuppressionReason = 'bounce' | 'spam' | 'unsubscribed' | 'manual';

export async function isSuppressedDb(
  tenantId: string,
  email: string,
): Promise<{ suppressed: true; reason: string } | { suppressed: false }> {
  const normalized = normalize(email);
  const row = await prisma.emailSuppression.findUnique({
    where: { tenantId_email: { tenantId, email: normalized } },
  });
  if (!row) return { suppressed: false };
  return { suppressed: true, reason: row.reason };
}

export async function suppressDb(
  tenantId: string,
  email: string,
  reason: DbSuppressionReason,
): Promise<void> {
  const normalized = normalize(email);
  await prisma.emailSuppression.upsert({
    where: { tenantId_email: { tenantId, email: normalized } },
    create: { tenantId, email: normalized, reason },
    update: {}, // first-write-wins; don't overwrite the original reason
  });
  logger.info({ tenantId, email: normalized, reason }, 'email suppressed (db)');
}
