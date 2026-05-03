/**
 * KAN-798a — Send Policy & Validation tests (Phase 2 epic 5 of 5, sub-cohort a).
 *
 * 20+ vitest cases covering: allow happy path, deny-suppression (4 signal
 * types), per-channel suppression isolation, deny-rate-limit (boundary +
 * over-cap + per-channel separation + 24h window), defer-time-of-day (early
 * + late + UTC fallback), in-window allow, 3 skip-flag overrides, multiple-
 * violations first-deny ordering, NotFound tenant.
 *
 * Pure module — NO LLM mock needed (KAN-798 is deterministic). Prisma
 * mocked via hand-rolled vi.fn() per sibling convention.
 *
 * Time-of-day tests use vi.setSystemTime to pin Date.now to deterministic
 * UTC instants, then assert tenant-local-hour math against that pin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  evaluateSendPolicy,
  getTenantLocalHour,
  computeNextWindowOpen,
  SendPolicyTenantNotFoundError,
} from '../send-policy.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const CONTACT_A = 'contact_a';

interface PrismaMockOpts {
  /** Most recent suppression engagement to return from findFirst, or null. */
  suppressionEngagement?: { engagementType: string; occurredAt: Date } | null;
  /** Count to return from rate-limit count query. */
  rateLimitCount?: number;
  /** Tenant for tenant.findUnique, or null. */
  tenant?: { id: string; settings: unknown } | null;
}

function makePrismaMock(opts: PrismaMockOpts = {}) {
  const findFirstEngagement = vi.fn(async () => opts.suppressionEngagement ?? null);
  const countEngagement = vi.fn(async () => opts.rateLimitCount ?? 0);
  const findUniqueTenant = vi.fn(async () =>
    opts.tenant === undefined ? { id: TENANT_A, settings: {} } : opts.tenant,
  );

  const prisma = {
    engagement: { findFirst: findFirstEngagement, count: countEngagement },
    tenant: { findUnique: findUniqueTenant },
  } as unknown as PrismaClient;

  return { prisma, findFirstEngagement, countEngagement, findUniqueTenant };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Pin to a known in-window UTC instant: 2026-05-04 14:00 UTC = 2pm UTC.
  // For UTC tenants this is in window (9am-9pm).
  vi.setSystemTime(new Date('2026-05-04T14:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────
// 1. Allow happy path
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — allow happy path', () => {
  it('no suppression, no rate limit, in window → allow', async () => {
    const { prisma } = makePrismaMock({
      suppressionEngagement: null,
      rateLimitCount: 0,
    });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('allow');
    expect(result.reason).toContain('All policy checks passed');
  });
});

// ─────────────────────────────────────────────
// 2-5. Deny suppression (4 signal types)
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — deny on suppression signals', () => {
  it.each([
    ['email_unsubscribe'],
    ['email_bounce'],
    ['email_complained'],
    ['contact_optout'],
  ] as const)('most recent engagement is %s → deny with ruleViolated=suppression', async (suppressionType) => {
    const { prisma } = makePrismaMock({
      suppressionEngagement: { engagementType: suppressionType, occurredAt: new Date('2026-04-01T12:00:00Z') },
    });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('deny');
    expect((result as { ruleViolated: string }).ruleViolated).toBe('suppression');
    expect(result.reason).toContain(suppressionType);
  });
});

// ─────────────────────────────────────────────
// 6. Per-channel suppression isolation
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — per-channel suppression isolation', () => {
  it('suppression on email channel does NOT block sms send (per-channel filter)', async () => {
    const { prisma, findFirstEngagement } = makePrismaMock({
      suppressionEngagement: null, // sms-channel query returns no suppression
      rateLimitCount: 0,
    });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'sms' });
    expect(result.type).toBe('allow');
    // Verify the suppression query was filtered to channel='sms', not all channels.
    const findArgs = findFirstEngagement.mock.calls[0]![0] as { where: { channel: string } };
    expect(findArgs.where.channel).toBe('sms');
  });
});

// ─────────────────────────────────────────────
// 7-10. Rate limit boundaries + per-channel separation
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — rate limit', () => {
  it('3 prior email_send in last 24h, attempting 4th → deny with ruleViolated=rate_limit', async () => {
    const { prisma } = makePrismaMock({ rateLimitCount: 3 });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('deny');
    expect((result as { ruleViolated: string }).ruleViolated).toBe('rate_limit');
    expect(result.reason).toContain('3/3');
  });

  it('2 prior email_send (just under cap of 3) → allow', async () => {
    const { prisma } = makePrismaMock({ rateLimitCount: 2 });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('allow');
  });

  it('rate-limit query filters by occurredAt >= NOW - 24h (rolling window)', async () => {
    const { prisma, countEngagement } = makePrismaMock({ rateLimitCount: 0 });
    await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    const countArgs = countEngagement.mock.calls[0]![0] as {
      where: { occurredAt: { gte: Date }; channel: string };
    };
    const expectedSince = new Date('2026-05-04T14:00:00Z').getTime() - 24 * 60 * 60 * 1000;
    expect(countArgs.where.occurredAt.gte.getTime()).toBe(expectedSince);
    expect(countArgs.where.channel).toBe('email');
  });

  it('rate-limit query filters by engagementType startsWith "<channel>_send" (per-channel separation)', async () => {
    const { prisma, countEngagement } = makePrismaMock({ rateLimitCount: 0 });
    await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'sms' });
    const countArgs = countEngagement.mock.calls[0]![0] as {
      where: { engagementType: { startsWith: string } };
    };
    expect(countArgs.where.engagementType.startsWith).toBe('sms_send');
  });
});

// ─────────────────────────────────────────────
// 11-13. Time-of-day defer (UTC tenant)
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — time-of-day defer (UTC)', () => {
  it('UTC tenant, current UTC is 6am → defer until 9am today', async () => {
    vi.setSystemTime(new Date('2026-05-04T06:00:00Z'));
    const { prisma } = makePrismaMock({ tenant: { id: TENANT_A, settings: {} } });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('defer');
    const deferUntil = (result as { deferUntil: Date }).deferUntil;
    expect(deferUntil.toISOString()).toBe('2026-05-04T09:00:00.000Z');
  });

  it('UTC tenant, current UTC is 10pm → defer until 9am tomorrow', async () => {
    vi.setSystemTime(new Date('2026-05-04T22:00:00Z'));
    const { prisma } = makePrismaMock({ tenant: { id: TENANT_A, settings: {} } });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('defer');
    const deferUntil = (result as { deferUntil: Date }).deferUntil;
    expect(deferUntil.toISOString()).toBe('2026-05-05T09:00:00.000Z');
  });

  it('UTC tenant, current UTC is 2pm → in window → allow', async () => {
    vi.setSystemTime(new Date('2026-05-04T14:00:00Z'));
    const { prisma } = makePrismaMock({ tenant: { id: TENANT_A, settings: {} }, rateLimitCount: 0 });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('allow');
  });
});

// ─────────────────────────────────────────────
// 14. Time-of-day with custom timezone in Tenant.settings
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — custom timezone via Tenant.settings', () => {
  it('America/New_York tenant, current UTC is 6am (= 2am ET) → defer until 9am ET (= 13:00 UTC)', async () => {
    vi.setSystemTime(new Date('2026-05-04T06:00:00Z'));
    const { prisma } = makePrismaMock({
      tenant: { id: TENANT_A, settings: { timezone: 'America/New_York' } },
    });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('defer');
    const deferUntil = (result as { deferUntil: Date }).deferUntil;
    // 9am EDT = 13:00 UTC (May = EDT = UTC-4).
    expect(deferUntil.toISOString()).toBe('2026-05-04T13:00:00.000Z');
  });
});

// ─────────────────────────────────────────────
// 15-17. Skip-flag overrides
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — skip-flag overrides', () => {
  it('skipSuppression=true → allow even when suppressed', async () => {
    const { prisma } = makePrismaMock({
      suppressionEngagement: { engagementType: 'email_unsubscribe', occurredAt: new Date() },
    });
    const result = await evaluateSendPolicy(
      prisma,
      TENANT_A,
      CONTACT_A,
      { channel: 'email' },
      { skipSuppression: true },
    );
    expect(result.type).toBe('allow');
  });

  it('skipRateLimit=true → allow even when over rate limit', async () => {
    const { prisma } = makePrismaMock({ rateLimitCount: 99 });
    const result = await evaluateSendPolicy(
      prisma,
      TENANT_A,
      CONTACT_A,
      { channel: 'email' },
      { skipRateLimit: true },
    );
    expect(result.type).toBe('allow');
  });

  it('skipTimeOfDay=true → allow even outside window', async () => {
    vi.setSystemTime(new Date('2026-05-04T03:00:00Z')); // 3am UTC
    const { prisma } = makePrismaMock({ tenant: { id: TENANT_A, settings: {} } });
    const result = await evaluateSendPolicy(
      prisma,
      TENANT_A,
      CONTACT_A,
      { channel: 'email' },
      { skipTimeOfDay: true },
    );
    expect(result.type).toBe('allow');
  });
});

// ─────────────────────────────────────────────
// 18. Multiple violations — first-deny wins (suppression beats rate limit)
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — first-deny ordering', () => {
  it('suppression + rate limit both apply → suppression wins (first-deny ordering)', async () => {
    const { prisma } = makePrismaMock({
      suppressionEngagement: { engagementType: 'email_unsubscribe', occurredAt: new Date() },
      rateLimitCount: 99, // would also trigger rate-limit deny
    });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('deny');
    expect((result as { ruleViolated: string }).ruleViolated).toBe('suppression');
  });
});

// ─────────────────────────────────────────────
// 19. NotFound tenant
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — NotFound tenant', () => {
  it('tenant.findUnique returns null → SendPolicyTenantNotFoundError', async () => {
    const { prisma } = makePrismaMock({ tenant: null });
    await expect(
      evaluateSendPolicy(prisma, 'missing-tenant', CONTACT_A, { channel: 'email' }),
    ).rejects.toThrow(SendPolicyTenantNotFoundError);
  });
});

// ─────────────────────────────────────────────
// 20. SMS channel: rate limit only counts sms_send, not email_send
// ─────────────────────────────────────────────

describe('evaluateSendPolicy — per-channel rate-limit separation', () => {
  it('sms-channel rate query filters by engagementType startsWith "sms_send" (not email_send)', async () => {
    const { prisma, countEngagement } = makePrismaMock({ rateLimitCount: 0 });
    await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'sms' });
    const countArgs = countEngagement.mock.calls[0]![0] as {
      where: { engagementType: { startsWith: string }; channel: string };
    };
    expect(countArgs.where.engagementType.startsWith).toBe('sms_send');
    expect(countArgs.where.channel).toBe('sms');
  });
});

// ─────────────────────────────────────────────
// Helper unit tests (exported for introspection)
// ─────────────────────────────────────────────

describe('getTenantLocalHour', () => {
  it('UTC at noon → 12', () => {
    expect(getTenantLocalHour(new Date('2026-05-04T12:00:00Z'), 'UTC')).toBe(12);
  });

  it('America/New_York at UTC noon (= 8am EDT in May) → 8', () => {
    expect(getTenantLocalHour(new Date('2026-05-04T12:00:00Z'), 'America/New_York')).toBe(8);
  });

  it('Asia/Tokyo at UTC noon (= 9pm JST) → 21', () => {
    expect(getTenantLocalHour(new Date('2026-05-04T12:00:00Z'), 'Asia/Tokyo')).toBe(21);
  });

  it('invalid timezone string → UTC fallback', () => {
    expect(getTenantLocalHour(new Date('2026-05-04T15:00:00Z'), 'Not/A_Real_Zone')).toBe(15);
  });
});

describe('computeNextWindowOpen', () => {
  it('UTC tenant, currently 6am → today at 9am UTC', () => {
    const now = new Date('2026-05-04T06:00:00Z');
    const next = computeNextWindowOpen(now, 6, 9, 21, 'UTC');
    expect(next.toISOString()).toBe('2026-05-04T09:00:00.000Z');
  });

  it('UTC tenant, currently 10pm → tomorrow at 9am UTC', () => {
    const now = new Date('2026-05-04T22:00:00Z');
    const next = computeNextWindowOpen(now, 22, 9, 21, 'UTC');
    expect(next.toISOString()).toBe('2026-05-05T09:00:00.000Z');
  });

  it('America/New_York tenant, currently 2am ET (6am UTC) → today at 9am ET (13:00 UTC)', () => {
    const now = new Date('2026-05-04T06:00:00Z'); // 2am EDT
    const next = computeNextWindowOpen(now, 2, 9, 21, 'America/New_York');
    expect(next.toISOString()).toBe('2026-05-04T13:00:00.000Z');
  });
});
