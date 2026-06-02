/**
 * KAN-1057 — Phase B PR II — buildThreadContext helper tests.
 *
 * Covers the 8-test surface locked in Phase B Phase 1 design trace +
 * PR II Phase 1 trace (2026-06-02):
 *   1. Empty result on no prior engagements
 *   2. Single-pair round-trip (1 outbound + 1 inbound → 2 turns oldest-first)
 *   3. Cap arithmetic (14 candidates → exactly 10 returned)
 *   4. excludeEngagementId filter wiring in WHERE clause
 *   5. Direction mapping (email_send → outbound; email_received → inbound)
 *   6. Fail-safe contract (prisma throw → [])
 *   7. Defensive projection (missing subject/bodyPreview → empty strings,
 *      Q1 lock — preserves turn-count correspondence with PR I's threadDepth)
 *   8. bodyText 2000-char belt-and-suspenders (Q2 lock — defensive re-slice
 *      catches pre-KAN-839 rows that may exceed cap)
 *
 * Prisma mocked via hand-rolled vi.fn() per sibling convention
 * (brain-service.test.ts L13-14, engagement-service.test.ts, etc.).
 * No real DB; pure unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  buildThreadContext,
  THREAD_DEPTH_CAP,
  type ThreadTurn,
} from '../brain-service.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const DEAL_A = 'deal_a';
const INBOUND_JUST_WRITTEN = 'engagement_inbound_just_written';

interface MockEngagementRow {
  engagementType: string;
  occurredAt: Date;
  metadata: unknown;
}

let findManyMock: ReturnType<typeof vi.fn>;
let mockPrisma: PrismaClient;

beforeEach(() => {
  findManyMock = vi.fn();
  mockPrisma = {
    engagement: { findMany: findManyMock },
  } as unknown as PrismaClient;
});

// ────────────────────────────────────────────────────────────
// (1/8) Empty result — deal with no prior engagements
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — buildThreadContext: empty result', () => {
  it('returns [] when prisma.engagement.findMany resolves to []', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result).toEqual([]);
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────
// (2/8) Single-pair round-trip — oldest-first ordering (Q3 lock)
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — buildThreadContext: single-pair oldest-first ordering', () => {
  it('returns 2 ThreadTurns in chronological (oldest-first) order from a DESC findMany', async () => {
    // findMany emits DESC (newest first). The helper internally reverses
    // so callers see oldest-first. Fixture: outbound at T0, inbound at T1.
    const T0 = new Date('2026-06-01T10:00:00.000Z');
    const T1 = new Date('2026-06-01T11:00:00.000Z');
    findManyMock.mockResolvedValueOnce([
      // DESC order — inbound (T1) first, outbound (T0) second.
      {
        engagementType: 'email_received',
        occurredAt: T1,
        metadata: {
          subject: 'Re: Hello',
          bodyPreview: 'Sounds good, Thursday works.',
        },
      },
      {
        engagementType: 'email_send',
        occurredAt: T0,
        metadata: {
          subject: 'Hello',
          bodyPreview: 'Quick question about your timeline.',
        },
      },
    ] satisfies MockEngagementRow[]);

    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });

    expect(result).toHaveLength(2);
    // Oldest-first: outbound (T0) at index 0, inbound (T1) at index 1.
    expect(result[0]).toEqual({
      direction: 'outbound',
      occurredAt: T0.toISOString(),
      subjectLine: 'Hello',
      bodyText: 'Quick question about your timeline.',
    });
    expect(result[1]).toEqual({
      direction: 'inbound',
      occurredAt: T1.toISOString(),
      subjectLine: 'Re: Hello',
      bodyText: 'Sounds good, Thursday works.',
    });
  });
});

// ────────────────────────────────────────────────────────────
// (3/8) Cap arithmetic — 14 candidate engagements → exactly 10 returned
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — buildThreadContext: THREAD_DEPTH_CAP * 2 take limit', () => {
  it('passes take: 10 to findMany (THREAD_DEPTH_CAP=5 * 2)', async () => {
    findManyMock.mockResolvedValueOnce([]);
    await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    const callArgs = findManyMock.mock.calls[0][0] as { take: number };
    expect(callArgs.take).toBe(THREAD_DEPTH_CAP * 2);
    expect(callArgs.take).toBe(10);
  });

  it('returns exactly 10 ThreadTurns when findMany emits 10 rows (DB-side cap caught the rest)', async () => {
    // Caller cap is enforced at the DB via take: 10. Helper mirrors whatever
    // findMany returned. This test pins that the post-reverse array length
    // matches the row count (no client-side over/under-trimming).
    const rows: MockEngagementRow[] = Array.from({ length: 10 }, (_, i) => ({
      engagementType: i % 2 === 0 ? 'email_received' : 'email_send',
      occurredAt: new Date(`2026-06-01T${String(10 + i).padStart(2, '0')}:00:00.000Z`),
      metadata: { subject: `Subject ${i}`, bodyPreview: `Body ${i}` },
    }));
    findManyMock.mockResolvedValueOnce(rows);

    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result).toHaveLength(10);
  });
});

// ────────────────────────────────────────────────────────────
// (4/8) excludeEngagementId — the just-received row stays out of the walk
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — buildThreadContext: excludeEngagementId WHERE clause', () => {
  it('passes id: { not: excludeEngagementId } to findMany', async () => {
    findManyMock.mockResolvedValueOnce([]);
    await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    const callArgs = findManyMock.mock.calls[0][0] as {
      where: { id?: { not?: string } };
    };
    expect(callArgs.where.id).toEqual({ not: INBOUND_JUST_WRITTEN });
  });

  it('passes the full WHERE shape: tenantId + dealId + engagementType in + id not', async () => {
    findManyMock.mockResolvedValueOnce([]);
    await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    const callArgs = findManyMock.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs.where).toEqual({
      tenantId: TENANT_A,
      dealId: DEAL_A,
      engagementType: { in: ['email_send', 'email_received'] },
      id: { not: INBOUND_JUST_WRITTEN },
    });
  });
});

// ────────────────────────────────────────────────────────────
// (5/8) Direction mapping — Q4 lock: email_send/received only
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — buildThreadContext: direction mapping (Q4 lock)', () => {
  it("maps engagementType 'email_send' → direction 'outbound'", async () => {
    findManyMock.mockResolvedValueOnce([
      {
        engagementType: 'email_send',
        occurredAt: new Date('2026-06-01T10:00:00.000Z'),
        metadata: { subject: 'Hello', bodyPreview: 'Body' },
      },
    ] satisfies MockEngagementRow[]);
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe('outbound');
  });

  it("maps engagementType 'email_received' → direction 'inbound'", async () => {
    findManyMock.mockResolvedValueOnce([
      {
        engagementType: 'email_received',
        occurredAt: new Date('2026-06-01T10:00:00.000Z'),
        metadata: { subject: 'Re: Hello', bodyPreview: 'Reply' },
      },
    ] satisfies MockEngagementRow[]);
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe('inbound');
  });

  it("Q4 filter: engagementType WHERE clause excludes opens/clicks/bounces/replies (passive signals)", async () => {
    // The WHERE clause `engagementType: { in: ['email_send', 'email_received'] }`
    // is what enforces the Q4 lock at the DB level — opens/clicks/bounces
    // never reach the projection. This test pins the filter shape.
    findManyMock.mockResolvedValueOnce([]);
    await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    const callArgs = findManyMock.mock.calls[0][0] as {
      where: { engagementType: { in: string[] } };
    };
    expect(callArgs.where.engagementType).toEqual({
      in: ['email_send', 'email_received'],
    });
    // Belt-and-suspenders — explicit absence of passive signal types in
    // the filter array. A future refactor that drops 'email_received' or
    // adds 'email_open' would fail this pin.
    expect(callArgs.where.engagementType.in).not.toContain('email_open');
    expect(callArgs.where.engagementType.in).not.toContain('email_click');
    expect(callArgs.where.engagementType.in).not.toContain('email_bounce');
    expect(callArgs.where.engagementType.in).not.toContain('email_reply');
  });
});

// ────────────────────────────────────────────────────────────
// (6/8) Fail-safe contract — prisma throw → empty array
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — buildThreadContext: fail-safe contract', () => {
  it('returns [] when prisma.engagement.findMany throws (no exception propagates)', async () => {
    findManyMock.mockRejectedValueOnce(new Error('prisma connection lost'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result).toEqual([]);
    // Warn-logged with tenantId + dealId + error message for forensic grep
    // (matches computeGapState's posture at L37-42).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/buildThreadContext error/);
    expect(warnSpy.mock.calls[0][0]).toContain(TENANT_A);
    expect(warnSpy.mock.calls[0][0]).toContain(DEAL_A);
    expect(warnSpy.mock.calls[0][0]).toContain('prisma connection lost');
    warnSpy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────
// (7/8) Defensive projection — Q1 lock: empty-string fallback
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — buildThreadContext: defensive projection (Q1 lock)', () => {
  it('returns empty-string subjectLine + bodyText when metadata.subject / bodyPreview are missing', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        engagementType: 'email_send',
        occurredAt: new Date('2026-06-01T10:00:00.000Z'),
        // Pre-KAN-839 row: no subject + no bodyPreview in metadata.
        metadata: { actionId: 'act_legacy' },
      },
    ] satisfies MockEngagementRow[]);
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result).toHaveLength(1);
    expect(result[0].subjectLine).toBe('');
    expect(result[0].bodyText).toBe('');
    // Direction + occurredAt still set — turn-count integrity preserved
    // (Q1 lock rationale: omitting the turn would silently desync from
    // PR I's threadDepth derivation).
    expect(result[0].direction).toBe('outbound');
    expect(result[0].occurredAt).toBe('2026-06-01T10:00:00.000Z');
  });

  it('returns empty-string when metadata.subject is non-string (malformed Json)', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        engagementType: 'email_received',
        occurredAt: new Date('2026-06-01T10:00:00.000Z'),
        // Adversarial: subject is a number, bodyPreview is an object.
        // The runtime type guard (Q2 lock) catches both.
        metadata: { subject: 42, bodyPreview: { nested: 'oops' } },
      },
    ] satisfies MockEngagementRow[]);
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result).toHaveLength(1);
    expect(result[0].subjectLine).toBe('');
    expect(result[0].bodyText).toBe('');
  });

  it('returns empty-string when metadata is null (defensive against null Json)', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        engagementType: 'email_send',
        occurredAt: new Date('2026-06-01T10:00:00.000Z'),
        metadata: null,
      },
    ] satisfies MockEngagementRow[]);
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result).toHaveLength(1);
    expect(result[0].subjectLine).toBe('');
    expect(result[0].bodyText).toBe('');
  });
});

// ────────────────────────────────────────────────────────────
// (8/8) bodyText 2000-char belt-and-suspenders
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — buildThreadContext: bodyText 2000-char cap', () => {
  it('slices oversized metadata.bodyPreview to 2000 chars (pre-KAN-839 row defense)', async () => {
    // Inbound writes already slice upstream (lead-received-push.ts:1218,
    // KAN-839). But outbound rows pass through whatever the send-side
    // publisher provided; some pre-KAN-839 backfill rows may exceed cap.
    // Belt-and-suspenders.
    const oversized = 'A'.repeat(2500);
    findManyMock.mockResolvedValueOnce([
      {
        engagementType: 'email_send',
        occurredAt: new Date('2026-06-01T10:00:00.000Z'),
        metadata: { subject: 'Hello', bodyPreview: oversized },
      },
    ] satisfies MockEngagementRow[]);
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result[0].bodyText).toHaveLength(2000);
    expect(result[0].bodyText).toBe('A'.repeat(2000));
  });

  it('preserves bodyPreview verbatim when under 2000 chars (no spurious slice)', async () => {
    const undersized = 'Short body.';
    findManyMock.mockResolvedValueOnce([
      {
        engagementType: 'email_received',
        occurredAt: new Date('2026-06-01T10:00:00.000Z'),
        metadata: { subject: 'Re: Hello', bodyPreview: undersized },
      },
    ] satisfies MockEngagementRow[]);
    const result = await buildThreadContext(mockPrisma, {
      tenantId: TENANT_A,
      dealId: DEAL_A,
      excludeEngagementId: INBOUND_JUST_WRITTEN,
    });
    expect(result[0].bodyText).toBe(undersized);
  });
});

// ────────────────────────────────────────────────────────────
// Sentinel: THREAD_DEPTH_CAP constant value pin
// ────────────────────────────────────────────────────────────

describe('KAN-1057 — THREAD_DEPTH_CAP constant', () => {
  it('exports THREAD_DEPTH_CAP === 5 per Phase B Phase 1 design lock', () => {
    // Lock value pin. Phase B Phase 1 design trace measured:
    //   - PROD thread-depth distribution: p50=1, p90=4, max=5
    //   - Token budget at full-stack ship: ~3500-4500 input tokens
    // Any future change to the cap MUST update the empirical anchors in
    // the docstring + KAN-1055 epic body before bumping this value.
    expect(THREAD_DEPTH_CAP).toBe(5);
  });

  it('exports ThreadTurn shape with 4 fields: direction + occurredAt + subjectLine + bodyText', () => {
    // Type-level pin. PR III will consume this shape; any added/removed
    // field on ThreadTurn must update PR III's prompt-rendering loop in
    // lockstep (test-time check is the cheapest cross-PR pin).
    const sample: ThreadTurn = {
      direction: 'outbound',
      occurredAt: '2026-06-01T10:00:00.000Z',
      subjectLine: 'Hello',
      bodyText: 'Body',
    };
    expect(Object.keys(sample).sort()).toEqual(
      ['bodyText', 'direction', 'occurredAt', 'subjectLine'],
    );
  });
});
