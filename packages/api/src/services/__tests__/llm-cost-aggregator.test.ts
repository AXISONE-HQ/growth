/**
 * KAN-745 PR B — aggregator + threshold + tag-mapping tests.
 *
 * Coverage:
 *   - tag-mapping covers all 6 prefixes + falls through to 'other'
 *   - longest-prefix-first match (agentic-tool wins over agentic)
 *   - applyEventToRollup writes correct totals
 *   - concurrent applyEventToRollup increments via UPSERT (simulated)
 *   - cross-tenant isolation in evaluateThresholdForBucket
 *   - threshold alarm fires structured warning when ratio > 2.5
 *   - threshold alarm does NOT fire when ratio ≤ 2.5
 *   - malformed event drops with structured-error log; never throws
 *   - DB error during upsert is caught + structured-logged; never throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyEventToRollup,
  evaluateThresholdForBucket,
  handleLlmCallEvent,
  toHourBucket,
  type LLMCallEventPayload,
} from '../observability/llm-cost-aggregator.js';
import {
  callerTagToPrefix,
  CALLER_TAG_PREFIXES,
} from '../observability/tag-mapping.js';
import {
  evaluateThreshold,
  emitThresholdAlarm,
} from '../observability/threshold-alarm.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makeEvent(overrides: Partial<LLMCallEventPayload> = {}): LLMCallEventPayload {
  return {
    eventId: 'evt-1',
    eventType: 'llm.call',
    publishedAt: '2026-04-29T18:30:00Z',
    tenantId: TENANT_A,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    tier: 'reasoning',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    pricingVersion: '2026-04-29-v1',
    latencyMs: 250,
    success: true,
    fallbackUsed: false,
    callerTag: 'agentic:iter1',
    ...overrides,
  };
}

interface FakeRollupRow {
  tenantId: string;
  hourBucket: Date;
  callerTagPrefix: string;
  pricingVersion: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

function makePrisma(rows: FakeRollupRow[] = []) {
  return {
    llmCostRollup: {
      upsert: vi.fn(async ({ where, create, update }: {
        where: { tenantId_hourBucket_callerTagPrefix_pricingVersion: { tenantId: string; hourBucket: Date; callerTagPrefix: string; pricingVersion: string } };
        create: FakeRollupRow;
        update: { callCount: { increment: number }; totalInputTokens: { increment: number }; totalOutputTokens: { increment: number }; totalCostUsd: { increment: number } };
      }) => {
        const k = where.tenantId_hourBucket_callerTagPrefix_pricingVersion;
        const existing = rows.find(
          (r) =>
            r.tenantId === k.tenantId &&
            r.hourBucket.getTime() === k.hourBucket.getTime() &&
            r.callerTagPrefix === k.callerTagPrefix &&
            r.pricingVersion === k.pricingVersion,
        );
        if (existing) {
          existing.callCount += update.callCount.increment;
          existing.totalInputTokens += update.totalInputTokens.increment;
          existing.totalOutputTokens += update.totalOutputTokens.increment;
          existing.totalCostUsd += update.totalCostUsd.increment;
          return existing;
        }
        rows.push({ ...create });
        return create;
      }),
      findMany: vi.fn(async ({ where }: { where: { tenantId: string; hourBucket: Date } }) =>
        rows.filter(
          (r) => r.tenantId === where.tenantId && r.hourBucket.getTime() === where.hourBucket.getTime(),
        ),
      ),
      groupBy: vi.fn(),
    },
  } as never;
}

describe('KAN-745 PR B — tag-mapping', () => {
  it('maps all 6 prefixes correctly', () => {
    expect(callerTagToPrefix('agentic:iter3')).toBe('agentic');
    expect(callerTagToPrefix('agentic-tool:get_contact_context')).toBe('agentic-tool');
    expect(callerTagToPrefix('message-composer:compose')).toBe('message-composer');
    expect(callerTagToPrefix('lead-assignment:ai-fallback')).toBe('lead-assignment');
    expect(callerTagToPrefix('recommendation.accept')).toBe('other'); // dot separator
    expect(callerTagToPrefix('recommendation:any')).toBe('recommendation');
  });

  it('agentic-tool wins over agentic (longest prefix first)', () => {
    expect(callerTagToPrefix('agentic-tool:get_contact_context')).toBe('agentic-tool');
    expect(callerTagToPrefix('agentic:iter1')).toBe('agentic');
  });

  it('falls through to "other" for unknown tags', () => {
    expect(callerTagToPrefix('csv-import:column-mapping')).toBe('other');
    expect(callerTagToPrefix('unknown-source')).toBe('other');
    expect(callerTagToPrefix(null)).toBe('other');
    expect(callerTagToPrefix(undefined)).toBe('other');
    expect(callerTagToPrefix('')).toBe('other');
  });

  it('CALLER_TAG_PREFIXES exports 5 named prefixes (other is implicit)', () => {
    expect(CALLER_TAG_PREFIXES).toHaveLength(5);
  });
});

describe('KAN-745 PR B — toHourBucket', () => {
  it('truncates to UTC hour', () => {
    const d = new Date('2026-04-29T18:37:42.123Z');
    const bucket = toHourBucket(d);
    expect(bucket.toISOString()).toBe('2026-04-29T18:00:00.000Z');
  });

  it('preserves hour boundary unchanged', () => {
    const d = new Date('2026-04-29T18:00:00.000Z');
    expect(toHourBucket(d).toISOString()).toBe('2026-04-29T18:00:00.000Z');
  });
});

describe('KAN-745 PR B — applyEventToRollup', () => {
  it('inserts a new rollup row on first event', async () => {
    const rows: FakeRollupRow[] = [];
    const prisma = makePrisma(rows);

    const result = await applyEventToRollup(prisma, makeEvent({ inputTokens: 100, outputTokens: 50, costUsd: 0.001 }));
    expect(result.applied).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].callCount).toBe(1);
    expect(rows[0].totalCostUsd).toBeCloseTo(0.001, 6);
    expect(rows[0].callerTagPrefix).toBe('agentic');
  });

  it('increments existing row on subsequent event (concurrent-safe via upsert)', async () => {
    const rows: FakeRollupRow[] = [];
    const prisma = makePrisma(rows);

    await applyEventToRollup(prisma, makeEvent({ costUsd: 0.001 }));
    await applyEventToRollup(prisma, makeEvent({ costUsd: 0.002 }));
    await applyEventToRollup(prisma, makeEvent({ costUsd: 0.003 }));

    expect(rows).toHaveLength(1); // same key collapsed via upsert
    expect(rows[0].callCount).toBe(3);
    expect(rows[0].totalCostUsd).toBeCloseTo(0.006, 6);
  });

  it('separates by callerTagPrefix within the same bucket', async () => {
    const rows: FakeRollupRow[] = [];
    const prisma = makePrisma(rows);

    await applyEventToRollup(prisma, makeEvent({ callerTag: 'agentic:iter1', costUsd: 0.01 }));
    await applyEventToRollup(prisma, makeEvent({ callerTag: 'message-composer:compose', costUsd: 0.005 }));
    await applyEventToRollup(prisma, makeEvent({ callerTag: 'agentic-tool:get_contact_context', costUsd: 0.002 }));

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.callerTagPrefix))).toEqual(
      new Set(['agentic', 'message-composer', 'agentic-tool']),
    );
  });

  it('separates by pricingVersion (audit trail unique key)', async () => {
    const rows: FakeRollupRow[] = [];
    const prisma = makePrisma(rows);

    await applyEventToRollup(prisma, makeEvent({ pricingVersion: '2026-04-29-v1' }));
    await applyEventToRollup(prisma, makeEvent({ pricingVersion: '2026-07-01-v2' }));

    expect(rows).toHaveLength(2);
  });
});

describe('KAN-745 PR B — evaluateThresholdForBucket', () => {
  it('cross-tenant isolation — only sums own-tenant rows', async () => {
    const hourBucket = toHourBucket(new Date('2026-04-29T18:00:00Z'));
    const rows: FakeRollupRow[] = [
      // tenant A
      { tenantId: TENANT_A, hourBucket, callerTagPrefix: 'agentic', pricingVersion: 'v1', callCount: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 5.0 },
      { tenantId: TENANT_A, hourBucket, callerTagPrefix: 'message-composer', pricingVersion: 'v1', callCount: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 1.0 },
      // tenant B (must NOT influence A's threshold)
      { tenantId: TENANT_B, hourBucket, callerTagPrefix: 'agentic', pricingVersion: 'v1', callCount: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 100.0 },
    ];
    const prisma = makePrisma(rows);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // A: 5 / 1 = 5x → breach
    const breach = await evaluateThresholdForBucket(prisma, TENANT_A, hourBucket);
    expect(breach).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, payload] = warnSpy.mock.calls[0];
    expect(msg).toContain('[agentic-cost]');
    expect(msg).toContain(`tenant=${TENANT_A}`);
    expect(msg).toContain('shadow_ratio=5.00x');
    expect((payload as { 'logging.googleapis.com/labels': { tenantId: string } })['logging.googleapis.com/labels'].tenantId).toBe(TENANT_A);
    expect((payload as { metric: { agenticUsd: number; nonAgenticUsd: number } }).metric.agenticUsd).toBeCloseTo(5.0, 6);

    warnSpy.mockRestore();
  });

  it('does NOT fire when ratio ≤ 2.5', async () => {
    const hourBucket = toHourBucket(new Date('2026-04-29T18:00:00Z'));
    const rows: FakeRollupRow[] = [
      { tenantId: TENANT_A, hourBucket, callerTagPrefix: 'agentic', pricingVersion: 'v1', callCount: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 2.0 },
      { tenantId: TENANT_A, hourBucket, callerTagPrefix: 'message-composer', pricingVersion: 'v1', callCount: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 1.0 },
    ];
    const prisma = makePrisma(rows);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // 2 / 1 = 2x → does not breach
    const breach = await evaluateThresholdForBucket(prisma, TENANT_A, hourBucket);
    expect(breach).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('treats agentic + agentic-tool both as numerator', async () => {
    const hourBucket = toHourBucket(new Date('2026-04-29T18:00:00Z'));
    const rows: FakeRollupRow[] = [
      { tenantId: TENANT_A, hourBucket, callerTagPrefix: 'agentic', pricingVersion: 'v1', callCount: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 2.0 },
      { tenantId: TENANT_A, hourBucket, callerTagPrefix: 'agentic-tool', pricingVersion: 'v1', callCount: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 1.5 },
      { tenantId: TENANT_A, hourBucket, callerTagPrefix: 'message-composer', pricingVersion: 'v1', callCount: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 1.0 },
    ];
    const prisma = makePrisma(rows);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // (2 + 1.5) / 1 = 3.5x → breach
    const breach = await evaluateThresholdForBucket(prisma, TENANT_A, hourBucket);
    expect(breach).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('KAN-745 PR B — handleLlmCallEvent (top-level subscriber handler)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('drops malformed event with structured-error log; never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const prisma = makePrisma([]);
    const result = await handleLlmCallEvent(prisma, { /* missing tenantId */ tier: 'cheap' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed_event');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('drops null/undefined event without throwing', async () => {
    const prisma = makePrisma([]);
    const result = await handleLlmCallEvent(prisma, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed_event');
  });

  it('catches DB upsert errors with structured-error log; never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const prisma = {
      llmCostRollup: {
        upsert: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      },
    } as never;
    const result = await handleLlmCallEvent(prisma, makeEvent());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('db_error');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('end-to-end: valid event applies + threshold evaluates', async () => {
    const rows: FakeRollupRow[] = [];
    const prisma = makePrisma(rows);
    const result = await handleLlmCallEvent(
      prisma,
      makeEvent({ callerTag: 'agentic:iter1', costUsd: 0.001 }),
    );
    expect(result.ok).toBe(true);
    expect(result.applied?.callerTagPrefix).toBe('agentic');
    expect(rows).toHaveLength(1);
  });
});

describe('KAN-745 PR B — evaluateThreshold (pure)', () => {
  it('infinity when nonAgentic=0 and agentic>0', () => {
    const r = evaluateThreshold({
      tenantId: TENANT_A,
      hourBucket: new Date(),
      agenticUsd: 1.0,
      nonAgenticUsd: 0,
    });
    expect(r.ratio).toBe(Infinity);
    expect(r.breach).toBe(true);
  });

  it('zero when both are zero', () => {
    const r = evaluateThreshold({
      tenantId: TENANT_A,
      hourBucket: new Date(),
      agenticUsd: 0,
      nonAgenticUsd: 0,
    });
    expect(r.ratio).toBe(0);
    expect(r.breach).toBe(false);
  });

  it('exactly 2.5 does NOT breach (must be > 2.5)', () => {
    const r = evaluateThreshold({
      tenantId: TENANT_A,
      hourBucket: new Date(),
      agenticUsd: 2.5,
      nonAgenticUsd: 1.0,
    });
    expect(r.ratio).toBe(2.5);
    expect(r.breach).toBe(false);
  });
});

describe('KAN-745 PR B — emitThresholdAlarm dual-format log', () => {
  it('emits message + structured payload when breach', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    emitThresholdAlarm({
      tenantId: TENANT_A,
      hourBucket: new Date('2026-04-29T18:00:00Z'),
      agenticUsd: 1.0,
      nonAgenticUsd: 0.3,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, payload] = warnSpy.mock.calls[0];
    // Human-grep-friendly format
    expect(msg).toMatch(/\[agentic-cost\] tenant=.+ shadow_ratio=3\.33x window=2026-04-29T18:00:00\.000Z agentic=\$1\.0000 non_agentic=\$0\.3000 threshold=2\.5/);
    // Structured payload for Cloud Logging label-based alerting
    const p = payload as {
      severity: string;
      'logging.googleapis.com/labels': { event: string; tenantId: string };
      metric: { shadowRatio: number };
    };
    expect(p.severity).toBe('WARNING');
    expect(p['logging.googleapis.com/labels'].event).toBe('agentic-cost-threshold-breach');
    expect(p['logging.googleapis.com/labels'].tenantId).toBe(TENANT_A);
    expect(p.metric.shadowRatio).toBeCloseTo(3.333, 2);
    warnSpy.mockRestore();
  });

  it('does NOT emit when no breach', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    emitThresholdAlarm({
      tenantId: TENANT_A,
      hourBucket: new Date(),
      agenticUsd: 0.1,
      nonAgenticUsd: 1.0,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
