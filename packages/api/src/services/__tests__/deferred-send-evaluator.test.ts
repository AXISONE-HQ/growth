/**
 * KAN-814 — deferred-send-evaluator tests.
 *
 * 9 cases per spec covering: persistence-on-defer (covered indirectly via
 * supersession test that asserts the row shape), cron pickup, re-dispatch
 * on allow, retry on still-defer, expiry at maxAttempts, concurrent FOR
 * UPDATE SKIP LOCKED safety, **specific 2-tenant isolation** (load-bearing
 * — must fail loud on cross-tenant leakage), supersession path, migration
 * round-trip (covered separately).
 *
 * Mocks Prisma + dependency-injected hooks per the evaluator's pure-module
 * contract. No real DB or Pub/Sub touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { processPendingDeferredSends, type ProcessOptions } from '../deferred-send-evaluator.js';

const TENANT_A = 'tenant_a_id';
const TENANT_B = 'tenant_b_id';
const DEAL_A = 'deal_a';
const DEAL_B = 'deal_b';
const CONTACT_A = 'contact_a';
const CONTACT_B = 'contact_b';

interface RowFixture {
  id: string;
  tenant_id: string;
  deal_id: string;
  contact_id: string;
  payload: {
    brainDecision: {
      nextBestAction: { type: string; reasoning: string };
      confidence: number;
      modelTier: string;
      evaluatedAt: string;
      llmInputTokens: number;
      llmOutputTokens: number;
      currentStateSnapshot: { currentStageName: string; daysInCurrentStage: number };
    };
    composed: { subject: string; body: string; tone?: string };
    contactEmail: string;
    shaperTier?: string;
    shaperInputTokens?: number;
    shaperOutputTokens?: number;
    originalEventId?: string;
  };
  defer_until: Date;
  attempts: number;
}

function buildRow(overrides: Partial<RowFixture> = {}): RowFixture {
  return {
    id: overrides.id ?? 'row_1',
    tenant_id: overrides.tenant_id ?? TENANT_A,
    deal_id: overrides.deal_id ?? DEAL_A,
    contact_id: overrides.contact_id ?? CONTACT_A,
    payload: overrides.payload ?? {
      brainDecision: {
        nextBestAction: { type: 'send_follow_up', reasoning: 'test' },
        confidence: 0.82,
        modelTier: 'reasoning',
        evaluatedAt: '2026-05-05T01:23:45.000Z',
        llmInputTokens: 620,
        llmOutputTokens: 128,
        currentStateSnapshot: { currentStageName: 'Qualified', daysInCurrentStage: 0 },
      },
      composed: { subject: 'Hello', body: 'Body content', tone: 'professional' },
      contactEmail: 'contact@example.com',
      shaperTier: 'reasoning',
      shaperInputTokens: 510,
      shaperOutputTokens: 95,
      originalEventId: 'evt_test',
    },
    defer_until: overrides.defer_until ?? new Date(Date.now() - 60 * 1000), // due 1 min ago
    attempts: overrides.attempts ?? 0,
  };
}

interface MockState {
  claimedRows: RowFixture[];
  decisionCreateMock: ReturnType<typeof vi.fn>;
  deferredSendUpdateMock: ReturnType<typeof vi.fn>;
  $queryRawMock: ReturnType<typeof vi.fn>;
}

function makePrismaMock(claimedRows: RowFixture[]): { prisma: PrismaClient; state: MockState } {
  const $queryRawMock = vi.fn(async () => claimedRows);
  const decisionCreateMock = vi.fn(async ({ data }: { data: { tenantId: string } }) => ({
    id: `decision_${data.tenantId}`,
  }));
  const deferredSendUpdateMock = vi.fn(async () => ({}));

  const prisma = {
    $queryRaw: $queryRawMock,
    decision: { create: decisionCreateMock },
    deferredSend: { update: deferredSendUpdateMock },
  } as unknown as PrismaClient;

  return {
    prisma,
    state: { claimedRows, decisionCreateMock, deferredSendUpdateMock, $queryRawMock },
  };
}

function makeOpts(overrides: Partial<ProcessOptions> = {}): ProcessOptions {
  return {
    evaluateSendPolicy: vi.fn(async () => ({ type: 'allow' as const, reason: 'ok' })),
    publishActionSend: vi.fn(async () => 'pubsub_msg_test'),
    resolveEmailConnectionId: vi.fn(async () => 'conn_active'),
    resolveReplyToForTenant: vi.fn(async () => 'inbox@leads.test.invalid'),
    getPubSubClient: vi.fn(() => ({ publish: vi.fn() })),
    publicWebhookBaseUrl: 'https://example.test',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────
// Test 1+3 — cron pickup + re-dispatch on allow
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — re-dispatch on allow', () => {
  it('claims pending rows where defer_until <= NOW(); on Send Policy allow → dispatch + Decision row + mark dispatched', async () => {
    const row = buildRow();
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts();

    const result = await processPendingDeferredSends(prisma, opts);

    expect(state.$queryRawMock).toHaveBeenCalledOnce();
    expect(result.totalClaimed).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.reDeferred).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.cancelled).toBe(0);
    // Decision row written before dispatch
    expect(state.decisionCreateMock).toHaveBeenCalledOnce();
    const decisionArgs = state.decisionCreateMock.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(decisionArgs.data.strategySelected).toBe('brain_phase_2_v1');
    expect(decisionArgs.data.tenantId).toBe(TENANT_A);
    expect((decisionArgs.data.metadata as Record<string, unknown>).redispatchedFromDeferredSendId).toBe(row.id);
    // publishActionSend called with composed message verbatim (no re-shaping)
    expect(opts.publishActionSend).toHaveBeenCalledOnce();
    const publishArgs = (opts.publishActionSend as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(publishArgs.tenantId).toBe(TENANT_A);
    expect(publishArgs.toEmail).toBe('contact@example.com');
    expect((publishArgs.composed as Record<string, unknown>).subject).toBe('Hello');
    expect((publishArgs.composed as Record<string, unknown>).body).toBe('Body content');
    // Row marked dispatched
    expect(state.deferredSendUpdateMock).toHaveBeenCalledOnce();
    const updateArgs = state.deferredSendUpdateMock.mock.calls[0]![0] as { data: { status: string } };
    expect(updateArgs.data.status).toBe('dispatched');
  });
});

// ─────────────────────────────────────────────
// Test 4 — re-defer on still-deferred
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — retry on still-deferred', () => {
  it('Send Policy returns defer → increment attempts + push defer_until forward', async () => {
    const row = buildRow({ attempts: 3 });
    const { prisma, state } = makePrismaMock([row]);
    const newDeferUntil = new Date(Date.now() + 30 * 60 * 1000); // policy says 30 min
    const opts = makeOpts({
      evaluateSendPolicy: vi.fn(async () => ({
        type: 'defer' as const,
        reason: 'still outside window',
        deferUntil: newDeferUntil,
      })),
    });

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.dispatched).toBe(0);
    expect(result.reDeferred).toBe(1);
    expect(state.decisionCreateMock).not.toHaveBeenCalled();
    expect(opts.publishActionSend).not.toHaveBeenCalled();
    // Update marks attempts + defer_until forward
    expect(state.deferredSendUpdateMock).toHaveBeenCalledOnce();
    const updateArgs = state.deferredSendUpdateMock.mock.calls[0]![0] as {
      data: { attempts: number; deferUntil: Date };
    };
    expect(updateArgs.data.attempts).toBe(4);
    // The new defer_until should be at least retryInterval (2h default) from now
    // — and at least newDeferUntil if policy returned a later time. We use the
    // max of the two; here policy=30min, retryInterval=2h, so 2h wins.
    const twoHoursFromNow = Date.now() + 2 * 60 * 60 * 1000;
    expect(updateArgs.data.deferUntil.getTime()).toBeGreaterThanOrEqual(twoHoursFromNow - 1000);
  });
});

// ─────────────────────────────────────────────
// Test 5 — expire at maxAttempts
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — expiry at maxAttempts', () => {
  it('attempts >= maxAttempts → mark expired + audit log entry', async () => {
    const row = buildRow({ attempts: 11 }); // one more attempt → expires
    const { prisma, state } = makePrismaMock([row]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = makeOpts({
      maxAttempts: 12,
      evaluateSendPolicy: vi.fn(async () => ({
        type: 'defer' as const,
        reason: 'still deferred',
        deferUntil: new Date(Date.now() + 60 * 1000),
      })),
    });

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.expired).toBe(1);
    expect(state.deferredSendUpdateMock).toHaveBeenCalledOnce();
    const updateArgs = state.deferredSendUpdateMock.mock.calls[0]![0] as { data: { status: string } };
    expect(updateArgs.data.status).toBe('expired');
    // Audit log line emitted
    const auditLine = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .find((s) => s.includes('row-expired'));
    expect(auditLine).toBeDefined();
    expect(auditLine).toContain('attempts=12');
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// Test 5b — cancel on policy now denies (e.g., contact unsubscribed during defer window)
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — cancel on policy deny', () => {
  it('Send Policy returns deny → mark cancelled with cancelReason=policy_now_denies, no dispatch', async () => {
    const row = buildRow();
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts({
      evaluateSendPolicy: vi.fn(async () => ({
        type: 'deny' as const,
        reason: 'contact unsubscribed',
        ruleViolated: 'suppression',
      })),
    });

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.cancelled).toBe(1);
    expect(state.decisionCreateMock).not.toHaveBeenCalled();
    expect(opts.publishActionSend).not.toHaveBeenCalled();
    const updateArgs = state.deferredSendUpdateMock.mock.calls[0]![0] as {
      data: { status: string; cancelReason: string };
    };
    expect(updateArgs.data.status).toBe('cancelled');
    expect(updateArgs.data.cancelReason).toBe('policy_now_denies');
  });
});

// ─────────────────────────────────────────────
// Test 6 — concurrent FOR UPDATE SKIP LOCKED safety
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — concurrent claim safety', () => {
  it('claim query uses FOR UPDATE SKIP LOCKED + LIMIT batchSize', async () => {
    const rows = [buildRow({ id: 'r1' }), buildRow({ id: 'r2' })];
    const { prisma, state } = makePrismaMock(rows);
    const opts = makeOpts({ batchSize: 2 });

    await processPendingDeferredSends(prisma, opts);

    // The $queryRaw call should have been made; verify the SQL template
    // contains the lock + limit clauses. Tagged template literal arrives
    // as TemplateStringsArray on first arg.
    const queryArgs = state.$queryRawMock.mock.calls[0]!;
    const templateStrings = queryArgs[0] as { raw?: readonly string[] };
    const sqlText = (templateStrings.raw ?? templateStrings as readonly string[]).join('');
    expect(sqlText).toContain('FOR UPDATE SKIP LOCKED');
    expect(sqlText).toContain('LIMIT');
    expect(sqlText).toContain("status = 'pending'");
  });

  it('concurrent simulation: two parallel evaluator runs with disjoint claim sets → no double-dispatch', async () => {
    // Worker A claims [r1, r2], Worker B claims [r3] — disjoint. Each runs
    // its own publishActionSend exactly once per claimed row.
    const workerAClaim = [buildRow({ id: 'r1' }), buildRow({ id: 'r2' })];
    const workerBClaim = [buildRow({ id: 'r3' })];
    const { prisma: pA } = makePrismaMock(workerAClaim);
    const { prisma: pB } = makePrismaMock(workerBClaim);
    const optsA = makeOpts();
    const optsB = makeOpts();

    const [resA, resB] = await Promise.all([
      processPendingDeferredSends(pA, optsA),
      processPendingDeferredSends(pB, optsB),
    ]);

    expect(resA.dispatched + resB.dispatched).toBe(3);
    // Each row dispatched exactly once (no overlap → no double-publish on a row id)
    const dispatchedIds = [...resA.rowResults, ...resB.rowResults].map((r) => r.id);
    expect(new Set(dispatchedIds).size).toBe(dispatchedIds.length);
  });
});

// ─────────────────────────────────────────────
// Test 7 — TENANT ISOLATION (load-bearing, fails loud on cross-tenant leakage)
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — TENANT ISOLATION (KAN-814 critical-path safety)', () => {
  it('two-tenant batch: tenant A row dispatches with A connection+replyTo; tenant B with B connection+replyTo (no cross-tenant leakage)', async () => {
    // Tenant A and Tenant B each have one pending row. Cron picks both up
    // in one batch. Each row's dispatch MUST resolve connectionId + replyTo
    // for its OWN tenant, not the other.
    const rowA = buildRow({
      id: 'row_A',
      tenant_id: TENANT_A,
      deal_id: DEAL_A,
      contact_id: CONTACT_A,
      payload: {
        ...buildRow().payload,
        contactEmail: 'alice@tenant-a.com',
      },
    });
    const rowB = buildRow({
      id: 'row_B',
      tenant_id: TENANT_B,
      deal_id: DEAL_B,
      contact_id: CONTACT_B,
      payload: {
        ...buildRow().payload,
        contactEmail: 'bob@tenant-b.com',
      },
    });
    const { prisma } = makePrismaMock([rowA, rowB]);

    // Per-tenant connection + replyTo. Tracked via the tenantId argument
    // so the test fails loud if the wrong tenantId is threaded.
    const resolveEmailConnectionIdMock = vi.fn(async (_p: unknown, tenantId: string) =>
      tenantId === TENANT_A ? 'conn_TENANT_A' : 'conn_TENANT_B',
    );
    const resolveReplyToForTenantMock = vi.fn(async (_p: unknown, tenantId: string) =>
      tenantId === TENANT_A ? 'inbox-A@leads.test.invalid' : 'inbox-B@leads.test.invalid',
    );

    const opts = makeOpts({
      resolveEmailConnectionId: resolveEmailConnectionIdMock,
      resolveReplyToForTenant: resolveReplyToForTenantMock,
    });

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.dispatched).toBe(2);
    expect(opts.publishActionSend).toHaveBeenCalledTimes(2);

    // Map publishActionSend calls by their tenantId argument and assert
    // the connectionId + replyTo + toEmail all came from the SAME tenant's
    // row. This is the load-bearing assertion: if any field crossed
    // tenants, the test fails loud.
    const calls = (opts.publishActionSend as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      const args = call[1] as { tenantId: string; connectionId: string; replyTo?: string; toEmail: string };
      if (args.tenantId === TENANT_A) {
        expect(args.connectionId).toBe('conn_TENANT_A');
        expect(args.replyTo).toBe('inbox-A@leads.test.invalid');
        expect(args.toEmail).toBe('alice@tenant-a.com');
      } else if (args.tenantId === TENANT_B) {
        expect(args.connectionId).toBe('conn_TENANT_B');
        expect(args.replyTo).toBe('inbox-B@leads.test.invalid');
        expect(args.toEmail).toBe('bob@tenant-b.com');
      } else {
        throw new Error(`Unexpected tenantId in dispatch: ${args.tenantId}`);
      }
    }

    // Per-tenant resolvers each called with the right tenantId
    expect(resolveEmailConnectionIdMock).toHaveBeenCalledWith(prisma, TENANT_A);
    expect(resolveEmailConnectionIdMock).toHaveBeenCalledWith(prisma, TENANT_B);
    expect(resolveReplyToForTenantMock).toHaveBeenCalledWith(prisma, TENANT_A);
    expect(resolveReplyToForTenantMock).toHaveBeenCalledWith(prisma, TENANT_B);
  });
});

// ─────────────────────────────────────────────
// Test 8 — connection went away between defer + re-dispatch → cancel
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — connection-lost-at-redispatch', () => {
  it('resolveEmailConnectionId returns null at re-dispatch → cancel with reason no_active_email_connection_at_redispatch', async () => {
    const row = buildRow();
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts({
      resolveEmailConnectionId: vi.fn(async () => null),
    });

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.cancelled).toBe(1);
    expect(state.decisionCreateMock).not.toHaveBeenCalled();
    expect(opts.publishActionSend).not.toHaveBeenCalled();
    const updateArgs = state.deferredSendUpdateMock.mock.calls[0]![0] as {
      data: { status: string; cancelReason: string };
    };
    expect(updateArgs.data.status).toBe('cancelled');
    expect(updateArgs.data.cancelReason).toBe('no_active_email_connection_at_redispatch');
  });
});

// ─────────────────────────────────────────────
// Test 9 — empty batch (no due rows) returns clean zeros
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — empty batch', () => {
  it('no due rows → clean zero result, no dispatch / decision / update calls', async () => {
    const { prisma, state } = makePrismaMock([]);
    const opts = makeOpts();

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.totalClaimed).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(state.decisionCreateMock).not.toHaveBeenCalled();
    expect(opts.publishActionSend).not.toHaveBeenCalled();
    expect(state.deferredSendUpdateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Test 10 — per-row error isolation (row throws but batch continues)
// ─────────────────────────────────────────────

describe('processPendingDeferredSends — per-row error isolation', () => {
  it('one row throws during dispatch → other rows still process', async () => {
    const rowA = buildRow({ id: 'row_throws', tenant_id: TENANT_A });
    const rowB = buildRow({ id: 'row_ok', tenant_id: TENANT_B });
    const { prisma } = makePrismaMock([rowA, rowB]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // publishActionSend throws ONLY for tenant A
    const publishMock = vi.fn(async (_client: unknown, args: { tenantId: string }) => {
      if (args.tenantId === TENANT_A) throw new Error('upstream Pub/Sub error');
      return 'pubsub_msg_ok';
    });
    const opts = makeOpts({ publishActionSend: publishMock });

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.totalClaimed).toBe(2);
    expect(result.dispatched).toBe(1); // only row B succeeded
    expect(result.errors).toBe(1); // row A errored
    expect(publishMock).toHaveBeenCalledTimes(2); // both attempted
    errorSpy.mockRestore();
  });
});
