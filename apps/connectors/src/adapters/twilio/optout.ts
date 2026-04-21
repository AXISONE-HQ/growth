/**
 * Per-tenant SMS opt-out cache.
 *
 * Redis-backed set of opted-out phone numbers. Provides:
 *   - Constant-time pre-send check before any Twilio API call
 *   - Instant persistence on inbound STOP (before the main app's contact
 *     flag catches up)
 *   - Survives process restarts
 *
 * This is a CHANNEL-LEVEL cache. The main app's `contact.optOut` flag
 * remains the source of truth for cross-channel suppression. Both can
 * be checked; whichever says "opted out" wins.
 *
 * KAN-580: Pre-send opt-out check
 * KAN-579: Side-effects of inbound STOP
 */

import Redis from 'ioredis';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true });
    redis.on('error', (err) => logger.warn({ err }, 'redis opt-out client error'));
  }
  return redis;
}

function key(tenantId: string): string {
  return `sms:optout:${tenantId}`;
}

/** Normalize phone numbers so +15555550123 and 15555550123 don't collide. */
function normalize(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  return digits.startsWith('1') && digits.length === 11 ? `+${digits}` : `+1${digits}`;
}

/** Return true if this phone number has opted out for this tenant. */
export async function isOptedOut(tenantId: string, phone: string): Promise<boolean> {
  try {
    const result = await getRedis().sismember(key(tenantId), normalize(phone));
    return result === 1;
  } catch (err) {
    // Fail-OPEN here would allow sending to potentially opted-out numbers.
    // Fail-CLOSED (return true) would break sends whenever Redis is down.
    // We fail-open and log loudly — Redis down is an ops emergency but
    // blocking all sends amplifies the outage.
    logger.error({ err, tenantId }, 'opt-out check failed — allowing send');
    return false;
  }
}

/** Add a number to the opt-out set. Called when STOP is received. */
export async function markOptedOut(tenantId: string, phone: string): Promise<void> {
  await getRedis().sadd(key(tenantId), normalize(phone));
  logger.info({ tenantId, phone: normalize(phone) }, 'sms number opted out');
}

/** Remove a number from the opt-out set. Called when START / YES / UNSTOP is received. */
export async function clearOptOut(tenantId: string, phone: string): Promise<void> {
  await getRedis().srem(key(tenantId), normalize(phone));
  logger.info({ tenantId, phone: normalize(phone) }, 'sms number re-opted in');
}
