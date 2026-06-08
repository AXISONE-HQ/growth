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
  resolveSendWindowHours,
  resolveTenantTimezone,
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
  /**
   * KAN-1131 PR 1 — AccountProfile.timeZone row returned by findFirst, or
   * null. Default null matches PROD reality: the relation is OPTIONAL on
   * Tenant; tenants that have not interacted with /settings/account have
   * no AccountProfile row, so checkTimeOfDay falls back to settingsTz.
   */
  accountProfile?: { timeZone: string } | null;
}

function makePrismaMock(opts: PrismaMockOpts = {}) {
  const findFirstEngagement = vi.fn(async () => opts.suppressionEngagement ?? null);
  const countEngagement = vi.fn(async () => opts.rateLimitCount ?? 0);
  const findUniqueTenant = vi.fn(async () =>
    opts.tenant === undefined ? { id: TENANT_A, settings: {} } : opts.tenant,
  );
  const findFirstAccountProfile = vi.fn(async () => opts.accountProfile ?? null);

  const prisma = {
    engagement: { findFirst: findFirstEngagement, count: countEngagement },
    tenant: { findUnique: findUniqueTenant },
    accountProfile: { findFirst: findFirstAccountProfile },
  } as unknown as PrismaClient;

  return {
    prisma,
    findFirstEngagement,
    countEngagement,
    findUniqueTenant,
    findFirstAccountProfile,
  };
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

// ─────────────────────────────────────────────
// KAN-814 sub-cohort 0 — per-tenant send-window override
// ─────────────────────────────────────────────

describe('resolveSendWindowHours — KAN-814 sub-cohort 0', () => {
  // Test 1 — happy path: settings.sendWindow.{start,end} populated → reads those values
  it('settings.sendWindow populated → reads start (round-down) + end (round-up)', () => {
    const result = resolveSendWindowHours(
      { sendWindow: { start: '08:00', end: '23:59', timezone: 'America/Toronto' } },
      TENANT_A,
    );
    expect(result.startHour).toBe(8);
    // "23:59" rounds UP to 24 — sentinel for "all day"; inWindow check
    // `hour < 24` always true → window stays open through hour 23.
    expect(result.endHour).toBe(24);
  });

  // Test 1b — start "00:00" + end "23:59" → 0 / 24 (the dev-tenant widening case)
  it('settings.sendWindow start=00:00 end=23:59 → 0 / 24 (always-in-window dev posture)', () => {
    const result = resolveSendWindowHours(
      { sendWindow: { start: '00:00', end: '23:59', timezone: 'America/Toronto' } },
      TENANT_A,
    );
    expect(result.startHour).toBe(0);
    expect(result.endHour).toBe(24);
  });

  // Test 1c — minute-rounding semantics: end with minute>0 rounds up; start drops minutes
  it('end="21:30" rounds up to 22 (more permissive); start="09:30" rounds down to 9', () => {
    const result = resolveSendWindowHours(
      { sendWindow: { start: '09:30', end: '21:30' } },
      TENANT_A,
    );
    expect(result.startHour).toBe(9);
    expect(result.endHour).toBe(22);
  });

  // Test 2 — backwards compat: no sendWindow → falls back to 9/21 silently (no log)
  it('no sendWindow on settings → 9/21 fallback (no log spam — silent default path)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveSendWindowHours({}, TENANT_A);
    expect(result.startHour).toBe(9);
    expect(result.endHour).toBe(21);
    // Silent default — no log line for tenants that simply haven't configured.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Test 3 — malformed sendWindow → falls back + logs send-policy-window-fallback
  it('malformed sendWindow.start="abc" → 9/21 fallback + warn log with send-policy-window-fallback marker', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveSendWindowHours(
      { sendWindow: { start: 'abc', end: '21:00' } },
      TENANT_A,
    );
    expect(result.startHour).toBe(9);
    expect(result.endHour).toBe(21);
    expect(warnSpy).toHaveBeenCalledOnce();
    const logLine = warnSpy.mock.calls[0]![0] as string;
    expect(logLine).toContain('send-policy-window-fallback');
    expect(logLine).toContain(`tenantId=${TENANT_A}`);
    expect(logLine).toContain('reason=malformed_sendWindow');
    warnSpy.mockRestore();
  });

  // Test 3b — additional malformed shapes (out-of-range hour, non-string, missing field)
  it.each([
    ['out-of-range hour', { start: '25:00', end: '21:00' }],
    ['non-string start', { start: 1300, end: '21:00' }],
    ['missing end field', { start: '09:00' }],
    ['sendWindow as array', { sendWindow: [] } as never],
  ])('malformed shape (%s) → falls back to 9/21', (_label, badShape) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settingsObj =
      'sendWindow' in (badShape as object)
        ? (badShape as Record<string, unknown>)
        : { sendWindow: badShape };
    const result = resolveSendWindowHours(settingsObj, TENANT_A);
    expect(result.startHour).toBe(9);
    expect(result.endHour).toBe(21);
    warnSpy.mockRestore();
  });

  // Test 4 — end-to-end: tenant with custom window → evaluateSendPolicy honors it
  // (regression guard for the wire-through; pre-KAN-814-sub-0 the constants were hardcoded)
  it('end-to-end: tenant with sendWindow=00:00-23:59 → evaluateSendPolicy returns allow at any hour', async () => {
    // 22:00 UTC — would defer with default 9/21 window — should ALLOW with 00:00-23:59
    vi.setSystemTime(new Date('2026-05-04T22:00:00Z'));
    const { prisma } = makePrismaMock({
      suppressionEngagement: null,
      rateLimitCount: 0,
      tenant: {
        id: TENANT_A,
        settings: {
          timezone: 'UTC',
          sendWindow: { start: '00:00', end: '23:59' },
        },
      },
    });
    const result = await evaluateSendPolicy(prisma, TENANT_A, CONTACT_A, { channel: 'email' });
    expect(result.type).toBe('allow');
  });
});

// ─────────────────────────────────────────────
// KAN-1131 PR 1 — Dual-source tenant timezone resolution
// ─────────────────────────────────────────────

describe('resolveTenantTimezone — KAN-1131 PR 1 dual-read', () => {
  // Scenario 1 — both sources populated and match → no divergence log, returns the value.
  it('both sources match → no warn, returns the agreed value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveTenantTimezone('America/Toronto', 'America/Toronto', TENANT_A);
    expect(result).toBe('America/Toronto');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Scenario 2 — both sources populated and disagree → warn logged, profileTz wins.
  it('both sources differ → warn with send-policy-tz-divergence marker, profileTz wins', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveTenantTimezone('America/New_York', 'America/Toronto', TENANT_A);
    expect(result).toBe('America/New_York');
    expect(warnSpy).toHaveBeenCalledOnce();
    const logLine = warnSpy.mock.calls[0]![0] as string;
    expect(logLine).toContain('send-policy-tz-divergence');
    expect(logLine).toContain(`tenantId=${TENANT_A}`);
    expect(logLine).toContain('profileTz=America/New_York');
    expect(logLine).toContain('settingsTz=America/Toronto');
    warnSpy.mockRestore();
  });

  // Scenario 3 — only profileTz exists (PROD path post-cutover) → no warn, returns profileTz.
  it('only profileTz populated → no warn, returns profileTz', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveTenantTimezone('Europe/Berlin', null, TENANT_A);
    expect(result).toBe('Europe/Berlin');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Scenario 4 — only settingsTz exists (PROD path pre-AccountProfile-write) → no warn,
  // returns settingsTz. This is the LOAD-BEARING fallback during cutover: any tenant
  // who has not yet interacted with /settings/account has accountProfile=null.
  it('only settingsTz populated (no AccountProfile row) → no warn, returns settingsTz', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveTenantTimezone(null, 'Asia/Tokyo', TENANT_A);
    expect(result).toBe('Asia/Tokyo');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Scenario 5 — neither populated → no warn, defensive UTC fallback.
  it('neither source populated → no warn, returns UTC defensive fallback', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveTenantTimezone(null, null, TENANT_A);
    expect(result).toBe('UTC');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
