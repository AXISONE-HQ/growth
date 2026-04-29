/**
 * KAN-742 — Idempotency-Key dedup for /api/v1/leads.
 *
 * Pattern matches KAN-684 + KAN-741: Redis SET with NX flag, 24h TTL.
 *
 * On duplicate replay (same tenant + same idempotency key within 24h):
 * the prior response's leadId is returned; the request is NOT re-processed.
 * This makes the API safe for client retries on network errors.
 *
 * Idempotency-Key is OPTIONAL. Requests without one bypass the dedup
 * check entirely.
 *
 * Failure posture (Redis unavailable): fail-open. Same trade-off as
 * api-rate-limit — Redis outages shouldn't lock the whole API surface.
 */
import { getRedisClient } from "./redis-client.js";

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const KEY_PREFIX = "idempotency:lead-api:";

export interface IdempotencyResult {
  /** True if this is the first time we've seen the key. */
  fresh: boolean;
  /** When duplicate (fresh=false), the previously-stored leadId. */
  storedLeadId?: string;
}

/**
 * Check + claim an idempotency key. If fresh, the caller is responsible
 * for completing the request and then calling `recordIdempotencyResult`
 * with the resulting leadId. If duplicate, `storedLeadId` is the result
 * from the original request.
 */
export async function claimIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<IdempotencyResult> {
  const redisKey = `${KEY_PREFIX}${tenantId}:${idempotencyKey}`;
  try {
    // SET NX with placeholder; we'll overwrite with the leadId on success.
    const setResult = await getRedisClient().set(redisKey, "PENDING", "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
    if (setResult === null) {
      // Duplicate — fetch the stored value
      const stored = await getRedisClient().get(redisKey);
      if (stored && stored !== "PENDING") {
        return { fresh: false, storedLeadId: stored };
      }
      // Stored is PENDING (concurrent request still in flight) or null
      // (race after expiry) — return as duplicate with no leadId; caller
      // returns 409 with "request in flight" message.
      return { fresh: false };
    }
    return { fresh: true };
  } catch (err) {
    console.error("[api-idempotency] redis claim failed — fail-open:", err);
    return { fresh: true };
  }
}

/**
 * Record the leadId for a previously-claimed idempotency key. Called
 * AFTER the request completes successfully. Future calls with the same
 * key return this leadId.
 *
 * Best-effort — never fails the response if Redis is unavailable.
 */
export async function recordIdempotencyResult(
  tenantId: string,
  idempotencyKey: string,
  leadId: string,
): Promise<void> {
  const redisKey = `${KEY_PREFIX}${tenantId}:${idempotencyKey}`;
  try {
    // Overwrite the PENDING placeholder with the actual leadId,
    // preserving the 24h TTL.
    await getRedisClient().set(redisKey, leadId, "EX", IDEMPOTENCY_TTL_SECONDS);
  } catch (err) {
    console.error("[api-idempotency] redis record failed (best-effort):", err);
  }
}
