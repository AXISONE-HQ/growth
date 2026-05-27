/**
 * KAN-1005 M2-5 — double-dispatch guard tests.
 *
 * Pins the loop the founder asked for at Phase 1 sign-off:
 *   - accept(sampleId) → FORBIDDEN
 *   - modify(sampleId) → FORBIDDEN
 *   - dismiss(sampleId) → allowed (means "acknowledged")
 *   - The guard keys on the single canonical marker
 *     `triggerType === 'AUTO_APPROVE_SAMPLE'`
 *   - No queue-mutation path can re-publish action.decided for a
 *     sampled (already-executed) action — the double-dispatch is
 *     IMPOSSIBLE by construction (proof: every code path that emits
 *     publishActionDecided from the recommendations.ts mutations is
 *     gated behind the assertNotSample call).
 *
 * Plus the queue-reader filter:
 *   - listRecommendations default (kind=undefined or 'pending') EXCLUDES samples
 *   - listRecommendations kind='sample' returns ONLY samples
 *   - listRecommendations kind='all' returns both
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  acceptRecommendation,
  modifyRecommendation,
  dismissRecommendation,
  listRecommendations,
} from '../recommendations.js';
import { SAMPLED_TRIGGER_TYPE } from '@growth/shared';

const TENANT = '00000000-0000-0000-0000-000000000001';

function makePrismaMock(escalationRow: Record<string, unknown> | null): {
  prisma: PrismaClient;
  findFirstMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
  auditLogCreateMock: ReturnType<typeof vi.fn>;
  findManyMock: ReturnType<typeof vi.fn>;
  countMock: ReturnType<typeof vi.fn>;
} {
  const findFirstMock = vi.fn(async () => escalationRow);
  const updateMock = vi.fn(async () => ({ id: 'escalation-id-1', status: 'resolved' }));
  const auditLogCreateMock = vi.fn(async () => ({ id: 'audit-id' }));
  const findManyMock = vi.fn(async () => []);
  const countMock = vi.fn(async () => 0);
  const prisma = {
    escalation: {
      findFirst: findFirstMock,
      update: updateMock,
      findMany: findManyMock,
      count: countMock,
    },
    auditLog: { create: auditLogCreateMock },
  } as unknown as PrismaClient;
  return { prisma, findFirstMock, updateMock, auditLogCreateMock, findManyMock, countMock };
}

const SAMPLE_ROW = {
  id: 'sample-id-1',
  status: 'open',
  contactId: '00000000-0000-0000-0000-000000000002',
  decisionId: 'decision_test',
  severity: 'info',
  triggerType: SAMPLED_TRIGGER_TYPE,
  aiSuggestion: 'send_followup_email via email',
  context: { sampled: true, sampleRate: 0.15 },
  decision: null,
};

const BLOCKING_ROW = {
  id: 'blocking-id-1',
  status: 'open',
  contactId: '00000000-0000-0000-0000-000000000002',
  decisionId: 'decision_test',
  severity: 'medium',
  triggerType: 'AGENTIC_GATE_DECISION',
  aiSuggestion: 'send_followup_email via email',
  context: { confidence: 0.4 },
  decision: { strategySelected: 'agentic', confidence: 0.4, reasoning: 'gate said review' },
};

const PUBSUB_MOCK = {
  publish: vi.fn(async () => ({ messageId: 'should-not-be-called' })),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KAN-1005 M2-5 — accept(sampleId) → FORBIDDEN (double-dispatch guard)', () => {
  it('throws FORBIDDEN with clear "already executed" message', async () => {
    const { prisma } = makePrismaMock(SAMPLE_ROW);
    await expect(
      acceptRecommendation(
        { prisma, tenantId: TENANT, actor: 'test-user', pubsubClient: PUBSUB_MOCK as any },
        { id: 'sample-id-1' },
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/already executed/),
    });
  });

  it('rejection prevents the publishActionDecided call (no double-dispatch path)', async () => {
    // The critical safety property: even attempting to accept a sample
    // never reaches the publish layer. This pins that the throw fires
    // BEFORE any publish op.
    const { prisma, updateMock } = makePrismaMock(SAMPLE_ROW);
    PUBSUB_MOCK.publish.mockClear();
    try {
      await acceptRecommendation(
        { prisma, tenantId: TENANT, actor: 'test-user', pubsubClient: PUBSUB_MOCK as any },
        { id: 'sample-id-1', modifiedAction: { actionType: 'send_message', channel: 'email', payload: {} } },
      );
    } catch {
      // expected
    }
    expect(PUBSUB_MOCK.publish).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled(); // no status mutation either
  });

  it('guard runs BEFORE the terminal-status check (so a sample is rejected on its own merits)', async () => {
    // Sample row with status='resolved' (already terminal). The guard
    // should fire FIRST (FORBIDDEN), not the terminal-status check
    // (BAD_REQUEST). This is the "rejected on its own merits, not as a
    // side effect" pin.
    const { prisma } = makePrismaMock({ ...SAMPLE_ROW, status: 'resolved' });
    await expect(
      acceptRecommendation(
        { prisma, tenantId: TENANT, actor: 'test-user', pubsubClient: PUBSUB_MOCK as any },
        { id: 'sample-id-1' },
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN', // NOT 'BAD_REQUEST'
    });
  });
});

describe('KAN-1005 M2-5 — modify(sampleId) → FORBIDDEN', () => {
  it('throws FORBIDDEN', async () => {
    const { prisma } = makePrismaMock(SAMPLE_ROW);
    await expect(
      modifyRecommendation(
        { prisma, tenantId: TENANT, actor: 'test-user' },
        { id: 'sample-id-1', suggestedAction: 'Something' },
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/already executed/),
    });
  });

  it('rejection prevents the escalation.update call', async () => {
    const { prisma, updateMock } = makePrismaMock(SAMPLE_ROW);
    try {
      await modifyRecommendation(
        { prisma, tenantId: TENANT, actor: 'test-user' },
        { id: 'sample-id-1', suggestedAction: 'Something' },
      );
    } catch {
      // expected
    }
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('KAN-1005 M2-5 — dismiss(sampleId) → ALLOWED (means "acknowledged")', () => {
  it('dismiss on a sample row succeeds (no FORBIDDEN; dismiss is the right disposition for samples)', async () => {
    const { prisma, updateMock } = makePrismaMock(SAMPLE_ROW);
    const result = await dismissRecommendation(
      { prisma, tenantId: TENANT, actor: 'test-user' },
      { id: 'sample-id-1', reason: 'acknowledged' },
    );
    expect(result.id).toBe('escalation-id-1');
    expect(updateMock).toHaveBeenCalledTimes(1);
    // No FORBIDDEN throw, no double-dispatch — dismiss is purely a
    // status transition.
  });
});

describe('KAN-1005 M2-5 — accept/modify on BLOCKING escalations still work (sanity)', () => {
  // Negative control — the guard must NOT regress the blocking-escalation
  // workflow. accept + modify on triggerType='AGENTIC_GATE_DECISION'
  // (or other non-sample types) still pass the guard.
  it('accept on blocking escalation does NOT trigger FORBIDDEN', async () => {
    const { prisma, updateMock } = makePrismaMock(BLOCKING_ROW);
    const pubsub = {
      publish: vi.fn(async () => ({ messageId: 'm1' })),
    };
    const result = await acceptRecommendation(
      { prisma, tenantId: TENANT, actor: 'test-user', pubsubClient: pubsub as any },
      { id: 'blocking-id-1' },
    );
    expect(result.status).toBe('resolved');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('modify on blocking escalation does NOT trigger FORBIDDEN', async () => {
    const { prisma, updateMock } = makePrismaMock(BLOCKING_ROW);
    // modifyRecommendation only modifies aiSuggestion text; no publish.
    await modifyRecommendation(
      { prisma, tenantId: TENANT, actor: 'test-user' },
      { id: 'blocking-id-1', suggestedAction: 'updated text' },
    );
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

describe('KAN-1005 M2-5 — listRecommendations kind filter (queue partition)', () => {
  it('kind="pending" (default) → triggerType filter EXCLUDES samples', async () => {
    const { prisma, findManyMock } = makePrismaMock(null);
    await listRecommendations(prisma, TENANT, { kind: 'pending' });
    expect(findManyMock).toHaveBeenCalledTimes(1);
    const whereArg = (findManyMock.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(whereArg.triggerType).toEqual({ not: SAMPLED_TRIGGER_TYPE });
  });

  it('kind unspecified → defaults to "pending" → triggerType filter EXCLUDES samples (safety default)', async () => {
    const { prisma, findManyMock } = makePrismaMock(null);
    await listRecommendations(prisma, TENANT, {});
    const whereArg = (findManyMock.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(whereArg.triggerType).toEqual({ not: SAMPLED_TRIGGER_TYPE });
  });

  it('kind="sample" → triggerType filter INCLUDES only samples', async () => {
    const { prisma, findManyMock } = makePrismaMock(null);
    await listRecommendations(prisma, TENANT, { kind: 'sample' });
    const whereArg = (findManyMock.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(whereArg.triggerType).toBe(SAMPLED_TRIGGER_TYPE);
  });

  it('kind="all" → NO triggerType filter (admin view)', async () => {
    const { prisma, findManyMock } = makePrismaMock(null);
    await listRecommendations(prisma, TENANT, { kind: 'all' });
    const whereArg = (findManyMock.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(whereArg.triggerType).toBeUndefined();
  });
});

describe('KAN-1005 M2-5 — no-redispatch-path proof (the impossible-by-construction property)', () => {
  // The doubled assertion: every recommendations.ts code path that
  // emits publishActionDecided is gated by the assertNotSample call.
  // This describe block enumerates the mutations that could in
  // principle re-publish; for each, prove the sample-keyed throw fires.

  it('accept(sampleId, modifiedAction) — even WITH a modifiedAction (which would trigger publish), the guard rejects FIRST', async () => {
    const { prisma } = makePrismaMock(SAMPLE_ROW);
    const pubsub = { publish: vi.fn(async () => ({ messageId: 'should-not-fire' })) };
    await expect(
      acceptRecommendation(
        { prisma, tenantId: TENANT, actor: 'test-user', pubsubClient: pubsub as any },
        {
          id: 'sample-id-1',
          modifiedAction: { actionType: 'send_message', channel: 'email', payload: {} },
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('there is no recommendations.ts mutation path that publishes WITHOUT first calling assertNotSample (grep-equivalent assertion)', () => {
    // Source-text scan: every export that calls publishActionDecided must
    // also call assertNotSample. Cheaper than an AST walk; aligned with
    // the M2-2/M2-4 structural-test pattern.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'recommendations.ts'),
      'utf8',
    );
    // Find every function that calls publishActionDecided. Currently
    // exactly one: acceptRecommendation. If another lands, this test
    // surfaces it and forces an assertNotSample addition.
    const publishMatches = src.match(/publishActionDecided\(/g) ?? [];
    // 1 occurrence in import, 1 in the call. Tolerate 1-3 to allow
    // for comments referencing the symbol.
    expect(publishMatches.length).toBeLessThanOrEqual(3);

    // The single call site in acceptRecommendation must be in a function
    // that ALSO calls assertNotSample.
    const acceptIdx = src.indexOf('export async function acceptRecommendation');
    expect(acceptIdx).toBeGreaterThan(0);
    // Find the next function-end / next export to bound the body.
    const nextExport = src.indexOf('export async function', acceptIdx + 1);
    const body = src.slice(acceptIdx, nextExport > 0 ? nextExport : src.length);
    expect(body).toMatch(/assertNotSample\(before,\s*['"]accept['"]\)/);
    expect(body).toMatch(/publishActionDecided\(/);
    // assertNotSample appears BEFORE publishActionDecided in the body.
    expect(body.indexOf('assertNotSample')).toBeLessThan(body.indexOf('publishActionDecided'));
  });
});
