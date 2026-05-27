/**
 * KAN-1005 M2-5 — human-review sampling module unit matrix.
 *
 * Module lives at apps/api/src/lib/human-review-sampling.ts (M2-4 pattern;
 * engine never imports it, so zero new TS6059 in the KAN-689 cohort).
 *
 * Test surface (Phase 1 sign-off):
 *   - rate=1.0 + eligible source → sampled
 *   - rate=0.0 → not sampled
 *   - rate=0.15 over N seeded draws → ~15% distribution
 *   - sampling-path throw → propagates to caller (caller catches)
 *   - sampled entry distinct (triggerType='AUTO_APPROVE_SAMPLE', severity='info')
 *   - resolveSampleRate fail-safe matrix
 *   - isDecisionSourceSampleEligible matrix (agentic_live/freeform → sample;
 *     playbook/approve_to_send/undefined → skip)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  shouldSample,
  __setShouldSampleForTest,
  resolveSampleRate,
  maybeEnqueueSampledReview,
  isDecisionSourceSampleEligible,
  SAMPLED_TRIGGER_TYPE,
  SAMPLED_SEVERITY,
  DEFAULT_SAMPLE_RATE,
} from '../lib/human-review-sampling.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CONTACT = '00000000-0000-0000-0000-000000000002';
const DECISION = 'decision_test_xyz';

function makePrismaMock() {
  const createMock = vi.fn(async () => ({ id: 'created-escalation-id' }));
  const prisma = {
    escalation: { create: createMock },
  } as unknown as PrismaClient;
  return { prisma, createMock };
}

const BASE_ARGS = {
  tenantId: TENANT,
  contactId: CONTACT,
  decisionId: DECISION,
  actionType: 'send_followup_email',
  channel: 'email',
  confidence: 0.82,
  decisionSource: 'agentic_live' as const,
  reasoning: 'Test reasoning',
};

afterEach(() => {
  __setShouldSampleForTest(null);
});

describe('KAN-1005 M2-5 — resolveSampleRate (fail-safe parse)', () => {
  it('null → default', () => expect(resolveSampleRate(null)).toBe(DEFAULT_SAMPLE_RATE));
  it('undefined → default', () => expect(resolveSampleRate(undefined)).toBe(DEFAULT_SAMPLE_RATE));
  it('empty {} → default', () => expect(resolveSampleRate({})).toBe(DEFAULT_SAMPLE_RATE));
  it('rate=0.5 honored', () => {
    expect(resolveSampleRate({ humanReviewSampling: { rate: 0.5 } })).toBe(0.5);
  });
  it('rate=1.0 honored (M2-6b validation shape)', () => {
    expect(resolveSampleRate({ humanReviewSampling: { rate: 1.0 } })).toBe(1.0);
  });
  it('rate=0.0 honored (explicit disable)', () => {
    expect(resolveSampleRate({ humanReviewSampling: { rate: 0.0 } })).toBe(0.0);
  });
  it('rate=-0.1 (out of range) → default (NOT silent 0)', () => {
    expect(resolveSampleRate({ humanReviewSampling: { rate: -0.1 } })).toBe(DEFAULT_SAMPLE_RATE);
  });
  it('rate=1.5 (out of range) → default (NOT runaway)', () => {
    expect(resolveSampleRate({ humanReviewSampling: { rate: 1.5 } })).toBe(DEFAULT_SAMPLE_RATE);
  });
  it('rate non-number → default', () => {
    expect(resolveSampleRate({ humanReviewSampling: { rate: '0.5' } })).toBe(DEFAULT_SAMPLE_RATE);
  });
  it('rate NaN → default', () => {
    expect(resolveSampleRate({ humanReviewSampling: { rate: NaN } })).toBe(DEFAULT_SAMPLE_RATE);
  });
  it('DEFAULT_SAMPLE_RATE pinned at 0.15 (founder OQ#4)', () => {
    expect(DEFAULT_SAMPLE_RATE).toBe(0.15);
  });
});

describe('KAN-1005 M2-5 — isDecisionSourceSampleEligible', () => {
  it('agentic_live → eligible', () => {
    expect(isDecisionSourceSampleEligible('agentic_live')).toBe(true);
  });
  it('freeform → eligible', () => {
    expect(isDecisionSourceSampleEligible('freeform')).toBe(true);
  });
  it('playbook → SKIP (human-curated)', () => {
    expect(isDecisionSourceSampleEligible('playbook')).toBe(false);
  });
  it('approve_to_send → SKIP (operator-curated)', () => {
    expect(isDecisionSourceSampleEligible('approve_to_send')).toBe(false);
  });
  it('undefined → SKIP (pre-M2-5 back-compat)', () => {
    expect(isDecisionSourceSampleEligible(undefined)).toBe(false);
  });
});

describe('KAN-1005 M2-5 — shouldSample (testability seam)', () => {
  it('default impl returns boolean', () => {
    expect(typeof shouldSample(0.5)).toBe('boolean');
  });
  it('__setShouldSampleForTest(() => true) → always true', () => {
    __setShouldSampleForTest(() => true);
    expect(shouldSample(0.0)).toBe(true);
  });
  it('__setShouldSampleForTest(() => false) → always false', () => {
    __setShouldSampleForTest(() => false);
    expect(shouldSample(1.0)).toBe(false);
  });
  it('__setShouldSampleForTest(null) → restores default', () => {
    __setShouldSampleForTest(() => true);
    expect(shouldSample(0)).toBe(true);
    __setShouldSampleForTest(null);
    expect(typeof shouldSample(0.5)).toBe('boolean');
  });
});

describe('KAN-1005 M2-5 — maybeEnqueueSampledReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rate=1.0 + eligible source (agentic_live) → escalation.create with sampled markers', async () => {
    __setShouldSampleForTest(() => true);
    const { prisma, createMock } = makePrismaMock();
    const r = await maybeEnqueueSampledReview(prisma, { ...BASE_ARGS, sampleRate: 1.0 });
    expect(r.sampled).toBe(true);
    expect(r.escalationId).toBe('created-escalation-id');
    expect(createMock).toHaveBeenCalledTimes(1);
    const callTuple = createMock.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    const data = callTuple[0].data;
    expect(data.triggerType).toBe(SAMPLED_TRIGGER_TYPE);
    expect(data.severity).toBe(SAMPLED_SEVERITY);
    expect(data.tenantId).toBe(TENANT);
    expect(data.decisionId).toBe(DECISION);
    expect(data.status).toBe('open');
    const ctx = data.context as Record<string, unknown>;
    expect(ctx.sampled).toBe(true);
    expect(ctx.sampleRate).toBe(1.0);
    expect(ctx.decisionSource).toBe('agentic_live');
  });

  it('rate=0.0 (forced false) → no DB call', async () => {
    __setShouldSampleForTest(() => false);
    const { prisma, createMock } = makePrismaMock();
    const r = await maybeEnqueueSampledReview(prisma, { ...BASE_ARGS, sampleRate: 0.0 });
    expect(r.sampled).toBe(false);
    expect(r.skipReason).toBe('rng_skip');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('decisionSource=playbook → SKIP (no rate roll, no DB call)', async () => {
    __setShouldSampleForTest(() => true); // would sample if eligible
    const { prisma, createMock } = makePrismaMock();
    const r = await maybeEnqueueSampledReview(prisma, {
      ...BASE_ARGS,
      decisionSource: 'playbook',
      sampleRate: 1.0,
    });
    expect(r.sampled).toBe(false);
    expect(r.skipReason).toBe('not_sample_eligible:playbook');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('decisionSource=approve_to_send → SKIP', async () => {
    __setShouldSampleForTest(() => true);
    const { prisma, createMock } = makePrismaMock();
    const r = await maybeEnqueueSampledReview(prisma, {
      ...BASE_ARGS,
      decisionSource: 'approve_to_send',
      sampleRate: 1.0,
    });
    expect(r.sampled).toBe(false);
    expect(r.skipReason).toBe('not_sample_eligible:approve_to_send');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('decisionSource=undefined → SKIP (pre-M2-5 back-compat)', async () => {
    __setShouldSampleForTest(() => true);
    const { prisma, createMock } = makePrismaMock();
    const r = await maybeEnqueueSampledReview(prisma, {
      ...BASE_ARGS,
      decisionSource: undefined,
      sampleRate: 1.0,
    });
    expect(r.sampled).toBe(false);
    expect(r.skipReason).toBe('no_decision_source');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rate=0.15 over 1000 seeded draws → ~14.2% (every-7th-call mock)', async () => {
    let callCount = 0;
    __setShouldSampleForTest((rate) => {
      callCount++;
      return callCount % Math.round(1 / rate) === 0;
    });
    const { prisma, createMock } = makePrismaMock();
    let sampledCount = 0;
    for (let i = 0; i < 1000; i++) {
      const r = await maybeEnqueueSampledReview(prisma, { ...BASE_ARGS, sampleRate: 0.15 });
      if (r.sampled) sampledCount++;
    }
    expect(sampledCount).toBe(createMock.mock.calls.length);
    expect(sampledCount).toBe(142); // 1000 / 7 = 142.86 floor
    expect(sampledCount).toBeGreaterThanOrEqual(100);
    expect(sampledCount).toBeLessThanOrEqual(200);
  });

  it('sampling DB throw → propagates to caller', async () => {
    __setShouldSampleForTest(() => true);
    const createMock = vi.fn(async () => {
      throw new Error('escalation.create DB unavailable');
    });
    const prisma = { escalation: { create: createMock } } as unknown as PrismaClient;
    await expect(
      maybeEnqueueSampledReview(prisma, { ...BASE_ARGS, sampleRate: 1.0 }),
    ).rejects.toThrow(/escalation.create DB unavailable/);
  });
});

describe('KAN-1005 M2-5 — shared constants pinned', () => {
  it('SAMPLED_TRIGGER_TYPE = "AUTO_APPROVE_SAMPLE"', () => {
    expect(SAMPLED_TRIGGER_TYPE).toBe('AUTO_APPROVE_SAMPLE');
  });
  it('SAMPLED_SEVERITY = "info"', () => {
    expect(SAMPLED_SEVERITY).toBe('info');
  });
});
