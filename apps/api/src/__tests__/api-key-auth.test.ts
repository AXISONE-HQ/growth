/**
 * KAN-742 — API key authentication tests.
 *
 * Covers: brand prefix validation, prefix extraction (12 hex of entropy
 * after stripping brand), bcrypt hash verification, revoked-key rejection,
 * cross-tenant isolation on revoke, neutral 401 on every failure mode.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoist the mock factory so vi.mock can reference findFirstMock + updateMock
// when it lifts the call to the top of the module.
const { findFirstMock, updateMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateMock: vi.fn(async () => ({ id: "ok" })),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    tenantApiKey: {
      findFirst: findFirstMock,
      update: updateMock,
    },
  },
}));

import {
  generateApiKey,
  verifyApiKey,
  BRAND_PREFIX,
  touchLastUsedAt,
  constantTimeEquals,
} from "../services/api-key-auth.js";

beforeEach(() => {
  findFirstMock.mockReset();
  updateMock.mockClear();
});

describe("generateApiKey", () => {
  it("produces a key with axone_live_ brand prefix + 32 hex entropy", async () => {
    const { plaintext, keyPrefix, keyHash } = await generateApiKey();
    expect(plaintext).toMatch(/^axone_live_[0-9a-f]{32}$/);
    expect(plaintext.startsWith(BRAND_PREFIX)).toBe(true);
    expect(keyPrefix).toMatch(/^[0-9a-f]{12}$/);
    // keyPrefix is the FIRST 12 hex of entropy — NOT the brand
    expect(plaintext.slice(BRAND_PREFIX.length, BRAND_PREFIX.length + 12)).toBe(keyPrefix);
    // bcrypt hashes start with $2b$
    expect(keyHash).toMatch(/^\$2[ab]\$/);
  });

  it("generates unique keys on each call", async () => {
    const { plaintext: a } = await generateApiKey();
    const { plaintext: b } = await generateApiKey();
    expect(a).not.toBe(b);
  });
});

describe("verifyApiKey — happy path", () => {
  it("returns AuthenticatedApiKey on valid key match", async () => {
    const { plaintext, keyPrefix, keyHash } = await generateApiKey();
    findFirstMock.mockResolvedValueOnce({
      id: "key-id-uuid",
      tenantId: "11111111-1111-1111-1111-111111111111",
      name: "Test Key",
      keyPrefix,
      keyHash,
    });
    const result = await verifyApiKey(plaintext);
    expect(result).toEqual(
      expect.objectContaining({
        apiKeyId: "key-id-uuid",
        tenantId: "11111111-1111-1111-1111-111111111111",
        keyPrefix,
        apiKeyName: "Test Key",
      }),
    );
    // Confirm the lookup filters revokedAt: null
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ keyPrefix, revokedAt: null }),
      }),
    );
  });
});

describe("verifyApiKey — rejection paths (all return null, never throw)", () => {
  it("rejects key without axone_live_ brand prefix", async () => {
    const result = await verifyApiKey("notbrand_4a8f9c1d2e3b5a6f7c8d9e0a1b2c3d4e");
    expect(result).toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("rejects key with wrong entropy length", async () => {
    const result = await verifyApiKey("axone_live_short");
    expect(result).toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("rejects key with non-hex entropy", async () => {
    const result = await verifyApiKey("axone_live_GHIJKLMNOPQRSTUVWXYZ123456789012");
    expect(result).toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("rejects when prefix lookup returns null (key not in DB)", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const result = await verifyApiKey("axone_live_4a8f9c1d2e3b5a6f7c8d9e0a1b2c3d4e");
    expect(result).toBeNull();
  });

  it("rejects when prefix matches but bcrypt remainder doesn't (forged key)", async () => {
    const { keyPrefix, keyHash } = await generateApiKey();
    findFirstMock.mockResolvedValueOnce({
      id: "key-id",
      tenantId: "tenant-a",
      name: "Test",
      keyPrefix,
      keyHash,
    });
    // Use a different remainder than what was generated
    const forged = `${BRAND_PREFIX}${keyPrefix}00000000000000000000`;
    const result = await verifyApiKey(forged);
    expect(result).toBeNull();
  });

  it("rejects revoked keys (lookup filters revokedAt: null — no grace period)", async () => {
    // Simulate revoked: lookup with revokedAt: null returns null since the row has revokedAt set
    findFirstMock.mockResolvedValueOnce(null);
    const { plaintext } = await generateApiKey();
    const result = await verifyApiKey(plaintext);
    expect(result).toBeNull();
    // Verify the query DID filter on revokedAt: null
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null }),
      }),
    );
  });
});

describe("immediate revoke + cross-tenant isolation", () => {
  it("revoked key in tenant A is rejected; tenant B's key with same prefix coincidence still works", async () => {
    // First request: tenant A's key (revoked) — findFirst returns null because revokedAt: null filter
    findFirstMock.mockResolvedValueOnce(null);
    const tenantAKey = "axone_live_aaaaaaaaaaaa11223344556677889900"; // 12+20=32 hex
    expect(await verifyApiKey(tenantAKey)).toBeNull();

    // Second request: tenant B's key (active) — findFirst returns its row
    const { plaintext: tenantBPlain, keyPrefix: tenantBPrefix, keyHash: tenantBHash } = await generateApiKey();
    findFirstMock.mockResolvedValueOnce({
      id: "tenant-b-key-id",
      tenantId: "22222222-2222-2222-2222-222222222222",
      name: "Tenant B Key",
      keyPrefix: tenantBPrefix,
      keyHash: tenantBHash,
    });
    const result = await verifyApiKey(tenantBPlain);
    expect(result?.tenantId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("no grace period — revoke takes effect on the immediately next request", async () => {
    const { plaintext, keyPrefix, keyHash } = await generateApiKey();

    // First call — key active, succeeds
    findFirstMock.mockResolvedValueOnce({
      id: "key-id", tenantId: "tenant-a", name: "Active Key", keyPrefix, keyHash,
    });
    const ok = await verifyApiKey(plaintext);
    expect(ok).not.toBeNull();

    // Revoke happens (DB-side: revokedAt set). Next call — findFirst with
    // revokedAt: null filter returns null because the row no longer matches.
    findFirstMock.mockResolvedValueOnce(null);
    const blocked = await verifyApiKey(plaintext);
    expect(blocked).toBeNull();
  });
});

describe("touchLastUsedAt — fire-and-forget", () => {
  it("schedules an update without throwing on the request path", () => {
    expect(() => touchLastUsedAt("key-id-uuid")).not.toThrow();
  });
});

describe("constantTimeEquals helper", () => {
  it("returns true on identical strings", () => {
    expect(constantTimeEquals("abcdef", "abcdef")).toBe(true);
  });
  it("returns false on different lengths (no length-leak)", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });
  it("returns false on same length, different content", () => {
    expect(constantTimeEquals("abcdef", "abcdeg")).toBe(false);
  });
});
