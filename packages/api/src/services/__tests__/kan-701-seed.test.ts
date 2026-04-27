/**
 * Tests for KAN-701 — platform-default MicroObjective seed module.
 *
 * Coverage:
 *   - PLATFORM_DEFAULT_MICRO_OBJECTIVES: exactly 5 entries, unique IDs,
 *     stable name set matching Fred's V1 list
 *   - seedPlatformDefaults: upsert called 5x with tenantId=null + isDefault=true
 *   - seedPlatformDefaults: idempotent (re-run = same upsert calls, update={})
 *   - materializeDefaultsForTenant: skips existing per-tenant rows
 *   - materializeDefaultsForTenant: creates missing per-tenant rows with
 *     tenantId=<id> + isDefault=false (NOT a platform default)
 *   - materializeDefaultsForTenant: returns accurate {created, skipped} counts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  PLATFORM_DEFAULT_MICRO_OBJECTIVES,
  seedPlatformDefaults,
  materializeDefaultsForTenant,
} from '../../../../db/prisma/seeds/micro-objectives.js';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const EXPECTED_NAMES = [
  'Consumer engagement',
  'Have all relevant contact info',
  "Understand what they're trying to accomplish",
  'Know when they want to buy',
  'Looking for similar products (competitors)',
];

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────
// Source-of-truth list
// ─────────────────────────────────────────────

describe('PLATFORM_DEFAULT_MICRO_OBJECTIVES', () => {
  it('contains exactly 5 platform defaults', () => {
    expect(PLATFORM_DEFAULT_MICRO_OBJECTIVES).toHaveLength(5);
  });

  it('all 5 names match Fred\'s V1 list (stable contract for the seed migration)', () => {
    expect(PLATFORM_DEFAULT_MICRO_OBJECTIVES.map((m) => m.name).sort()).toEqual(
      EXPECTED_NAMES.slice().sort(),
    );
  });

  it('all IDs are unique fixed UUIDs (deterministic for ON CONFLICT idempotency)', () => {
    const ids = PLATFORM_DEFAULT_MICRO_OBJECTIVES.map((m) => m.id);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) {
      expect(id).toMatch(/^8df2c0d3-0001-4001-8001-00000000000[1-5]$/);
    }
  });

  it('order values are 1..5 (used for stable UI sort)', () => {
    expect(PLATFORM_DEFAULT_MICRO_OBJECTIVES.map((m) => m.order).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('every entry has a non-empty completionCriteria with a "type" field', () => {
    for (const mo of PLATFORM_DEFAULT_MICRO_OBJECTIVES) {
      expect(mo.completionCriteria).toBeTypeOf('object');
      expect((mo.completionCriteria as { type?: unknown }).type).toBeTypeOf('string');
    }
  });
});

// ─────────────────────────────────────────────
// seedPlatformDefaults — upserts the 5 defaults
// ─────────────────────────────────────────────

describe('seedPlatformDefaults', () => {
  it('calls upsert exactly 5 times with tenantId=null + isDefault=true', async () => {
    const upsert = vi.fn(async () => ({}));
    const prisma = { microObjective: { upsert } } as unknown as PrismaClient;

    await seedPlatformDefaults(prisma);

    expect(upsert).toHaveBeenCalledTimes(5);
    for (const call of upsert.mock.calls) {
      const args = call[0] as { create: { tenantId: string | null; isDefault: boolean } };
      expect(args.create.tenantId).toBeNull();
      expect(args.create.isDefault).toBe(true);
    }
  });

  it('uses update:{} so existing rows are never overwritten (preserves customizations)', async () => {
    const upsert = vi.fn(async () => ({}));
    const prisma = { microObjective: { upsert } } as unknown as PrismaClient;

    await seedPlatformDefaults(prisma);

    for (const call of upsert.mock.calls) {
      const args = call[0] as { update: object };
      expect(args.update).toEqual({});
    }
  });

  it('keys upserts on the fixed UUID (id)', async () => {
    const upsert = vi.fn(async () => ({}));
    const prisma = { microObjective: { upsert } } as unknown as PrismaClient;

    await seedPlatformDefaults(prisma);

    const whereIds = upsert.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id).sort();
    const expectedIds = PLATFORM_DEFAULT_MICRO_OBJECTIVES.map((m) => m.id).sort();
    expect(whereIds).toEqual(expectedIds);
  });
});

// ─────────────────────────────────────────────
// materializeDefaultsForTenant — clones to per-tenant rows
// ─────────────────────────────────────────────

describe('materializeDefaultsForTenant', () => {
  it('creates 5 per-tenant rows when none exist (created=5, skipped=0)', async () => {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async () => ({}));
    const prisma = { microObjective: { findFirst, create } } as unknown as PrismaClient;

    const result = await materializeDefaultsForTenant(prisma, TENANT_ID);

    expect(result).toEqual({ created: 5, skipped: 0 });
    expect(create).toHaveBeenCalledTimes(5);
    expect(findFirst).toHaveBeenCalledTimes(5);
  });

  it('per-tenant rows have tenantId=<id> + isDefault=false (tenant-owned, not platform)', async () => {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async () => ({}));
    const prisma = { microObjective: { findFirst, create } } as unknown as PrismaClient;

    await materializeDefaultsForTenant(prisma, TENANT_ID);

    for (const call of create.mock.calls) {
      const args = call[0] as { data: { tenantId: string; isDefault: boolean } };
      expect(args.data.tenantId).toBe(TENANT_ID);
      expect(args.data.isDefault).toBe(false);
    }
  });

  it('skips per-tenant rows that already exist (idempotent re-run)', async () => {
    // All 5 already exist for this tenant
    const findFirst = vi.fn(async () => ({ id: 'existing' }));
    const create = vi.fn(async () => ({}));
    const prisma = { microObjective: { findFirst, create } } as unknown as PrismaClient;

    const result = await materializeDefaultsForTenant(prisma, TENANT_ID);

    expect(result).toEqual({ created: 0, skipped: 5 });
    expect(create).not.toHaveBeenCalled();
  });

  it('partial overlap: skips existing, creates missing (created=2, skipped=3)', async () => {
    // First 3 calls return existing, last 2 return null → 2 created, 3 skipped
    let i = 0;
    const findFirst = vi.fn(async () => (i++ < 3 ? { id: 'x' } : null));
    const create = vi.fn(async () => ({}));
    const prisma = { microObjective: { findFirst, create } } as unknown as PrismaClient;

    const result = await materializeDefaultsForTenant(prisma, TENANT_ID);

    expect(result).toEqual({ created: 2, skipped: 3 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('lookup uses (tenantId, name) — never crosses tenant boundaries', async () => {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async () => ({}));
    const prisma = { microObjective: { findFirst, create } } as unknown as PrismaClient;

    await materializeDefaultsForTenant(prisma, TENANT_ID);

    for (const call of findFirst.mock.calls) {
      const args = call[0] as { where: { tenantId: string; name: string } };
      expect(args.where.tenantId).toBe(TENANT_ID);
      expect(EXPECTED_NAMES).toContain(args.where.name);
    }
  });
});
