/**
 * KAN-742 — API key authentication for /api/v1/leads.
 *
 * Plaintext key shape: `axone_live_<32hex>`
 *   - 11-char brand prefix: `axone_live_` (constant — not entropy)
 *   - 32-char hex remainder: 128 bits of entropy
 *
 * Storage:
 *   - keyPrefix:   first 12 hex of the entropy portion (after stripping
 *                  the brand prefix). 48 bits → genuinely O(1) indexed
 *                  lookup per request.
 *   - keyHash:     bcrypt of the remaining 20 hex.
 *
 * Why split this way: if we used "first 12 chars of the full key" naively,
 * we'd get `axone_live_X` (1 hex of entropy) — useless for indexing because
 * every live key would share the same 11-char prefix and we'd be back to a
 * full table scan. Stripping the brand BEFORE slicing the prefix gives 48
 * bits of entropy in the indexed column.
 *
 * Plaintext-once contract: the key value is shown ONCE at creation time.
 * Server NEVER returns it after, not even via admin endpoints. Lost keys
 * must be revoked + recreated.
 *
 * Revoke is IMMEDIATE: the auth lookup filters `revokedAt: null`. No grace
 * period, no caching layer between revoke and the next request.
 */
import bcrypt from "bcrypt";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../prisma.js";

export const BRAND_PREFIX = "axone_live_";
const BRAND_PREFIX_LEN = BRAND_PREFIX.length;
const ENTROPY_HEX_LEN = 32;
const KEY_PREFIX_LEN = 12; // 12 hex = 48 bits
const BCRYPT_COST = 12;

export interface AuthenticatedApiKey {
  apiKeyId: string;
  tenantId: string;
  keyPrefix: string;
  apiKeyName: string;
}

/**
 * Generate a fresh API key. Returns the plaintext (shown to user ONCE) +
 * the storage shape (keyPrefix + keyHash) for persistence.
 */
export async function generateApiKey(): Promise<{
  plaintext: string;
  keyPrefix: string;
  keyHash: string;
}> {
  const entropy = randomBytes(16).toString("hex"); // 32 hex chars
  const plaintext = `${BRAND_PREFIX}${entropy}`;
  const keyPrefix = entropy.slice(0, KEY_PREFIX_LEN);
  const remainder = entropy.slice(KEY_PREFIX_LEN);
  const keyHash = await bcrypt.hash(remainder, BCRYPT_COST);
  return { plaintext, keyPrefix, keyHash };
}

/**
 * Verify a plaintext API key against the storage. Returns the tenant +
 * key metadata on match, null on any failure (timing-safe).
 *
 * Failures all return null (not throw) so the auth middleware emits a
 * uniform 401 with neutral message — never leaks whether prefix-not-found
 * vs hash-mismatch.
 */
export async function verifyApiKey(plaintext: string): Promise<AuthenticatedApiKey | null> {
  // Step 1: validate brand prefix.
  if (!plaintext.startsWith(BRAND_PREFIX)) return null;
  const stripped = plaintext.slice(BRAND_PREFIX_LEN);

  // Step 2: validate entropy length.
  if (stripped.length !== ENTROPY_HEX_LEN) return null;
  if (!/^[0-9a-f]+$/i.test(stripped)) return null;

  // Step 3: extract keyPrefix (first 12 hex of entropy — NOT including brand).
  const keyPrefix = stripped.slice(0, KEY_PREFIX_LEN);
  const remainder = stripped.slice(KEY_PREFIX_LEN);

  // Step 4: O(1) indexed lookup. revokedAt: null filters revoked keys
  // immediately — no grace period.
  const candidate = await (prisma as unknown as {
    tenantApiKey: {
      findFirst: (args: unknown) => Promise<{ id: string; tenantId: string; name: string; keyPrefix: string; keyHash: string } | null>;
    };
  }).tenantApiKey.findFirst({
    where: { keyPrefix, revokedAt: null },
    select: { id: true, tenantId: true, name: true, keyPrefix: true, keyHash: true },
  });
  if (!candidate) {
    // Constant-time delay to mitigate prefix-existence timing attacks —
    // mirror the bcrypt.compare cost so attackers can't distinguish
    // "no row matched" from "row matched but bad remainder". Uses a
    // valid bcrypt hash format (60 chars total: $2b$12$ + 22 salt + 31 hash).
    await bcrypt.compare(
      "dummy",
      "$2b$12$AAAAAAAAAAAAAAAAAAAAAuPGTtxpVe6lUfn/7B2wKBXiDsmCBDLR.",
    );
    return null;
  }

  // Step 5: bcrypt.compare on the matched candidate's stored hash.
  const ok = await bcrypt.compare(remainder, candidate.keyHash);
  if (!ok) return null;

  return {
    apiKeyId: candidate.id,
    tenantId: candidate.tenantId,
    keyPrefix: candidate.keyPrefix,
    apiKeyName: candidate.name,
  };
}

/**
 * Fire-and-forget update of lastUsedAt. Never fails the auth path.
 */
export function touchLastUsedAt(apiKeyId: string): void {
  void (async () => {
    try {
      await (prisma as unknown as {
        tenantApiKey: { update: (args: unknown) => Promise<unknown> };
      }).tenantApiKey.update({
        where: { id: apiKeyId },
        data: { lastUsedAt: new Date() },
      });
    } catch (err) {
      console.error("[api-key-auth] touchLastUsedAt failed:", err);
    }
  })();
}

/** Used in tests — verify the timing-safe equality helper is wired properly. */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
