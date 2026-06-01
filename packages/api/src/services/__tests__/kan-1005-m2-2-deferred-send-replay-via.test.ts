/**
 * KAN-1005 M2-2 — deferred-send-evaluator replay_via discriminator.
 *
 * Adds engine-path replay alongside KAN-814 Lead Inbox path:
 *   - replay_via='action_send'    (KAN-814)  → publishActionSend (existing)
 *   - replay_via='action_decided' (M2-2)     → publishActionDecided (new)
 *
 * Sibling test file to deferred-send-evaluator.test.ts (preserves 9-case
 * Lead Inbox coverage there; adds engine-path coverage here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { processPendingDeferredSends, type ProcessOptions } from '../deferred-send-evaluator.js';

const TENANT = 't1';
const CONTACT = 'c1';

interface EngineRowFixture {
  id: string;
  tenant_id: string;
  deal_id: string | null;
  contact_id: string;
  payload: { actionDecidedEvent: Record<string, unknown>; originalEventId?: string };
  defer_until: Date;
  attempts: number;
  replay_via: string;
}

function buildEngineRow(overrides: Partial<EngineRowFixture> = {}): EngineRowFixture {
  return {
    id: overrides.id ?? 'engine_row_1',
    tenant_id: overrides.tenant_id ?? TENANT,
    deal_id: overrides.deal_id ?? null, // engine path has no Deal anchor
    contact_id: overrides.contact_id ?? CONTACT,
    payload: overrides.payload ?? {
      actionDecidedEvent: {
        eventId: 'evt-original-1',
        eventType: 'action.decided',
        version: '1.0',
        tenantId: TENANT,
        contactId: CONTACT,
        decisionId: 'd-original-1',
        objectiveId: 'o1',
        publishedAt: '2026-05-26T17:00:00Z',
        action: { actionType: 'send_followup_email', channel: 'email', payload: {} },
        decision: {
          selectedStrategy: 'agentic',
          confidenceScore: 80,
          strategyReasoning: 'r',
          actionReasoning: 'a',
        },
        routing: { agentType: 'agentic', priority: 'normal', maxRetries: 3, timeoutMs: 30000 },
      },
      originalEventId: 'evt-original-1',
    },
    defer_until: overrides.defer_until ?? new Date(Date.now() - 60 * 1000),
    attempts: overrides.attempts ?? 0,
    replay_via: overrides.replay_via ?? 'action_decided',
  };
}

function makePrismaMock(rows: EngineRowFixture[]): {
  prisma: PrismaClient;
  state: {
    $queryRaw: ReturnType<typeof vi.fn>;
    deferredSendUpdate: ReturnType<typeof vi.fn>;
    decisionCreate: ReturnType<typeof vi.fn>;
    auditLogCreate: ReturnType<typeof vi.fn>;
  };
} {
  const $queryRaw = vi.fn(async () => rows);
  const deferredSendUpdate = vi.fn(async () => ({}));
  const decisionCreate = vi.fn(async () => ({ id: 'd-cron' }));
  // KAN-1046 — audit log mock for the new catch-path audit emission.
  const auditLogCreate = vi.fn(async () => ({}));
  const prisma = {
    $queryRaw,
    decision: { create: decisionCreate },
    deferredSend: { update: deferredSendUpdate },
    auditLog: { create: auditLogCreate },
  } as unknown as PrismaClient;
  return {
    prisma,
    state: { $queryRaw, deferredSendUpdate, decisionCreate, auditLogCreate },
  };
}

function makeOpts(overrides: Partial<ProcessOptions> = {}): ProcessOptions {
  return {
    evaluateSendPolicy: vi.fn(async () => ({ type: 'allow' as const, reason: 'ok' })),
    publishActionSend: vi.fn(async () => 'should-not-be-called'),
    // KAN-1046 — return shape widened to include `published`. Mirrors the
    // real `republishActionDecidedEvent` contract that production wires.
    publishActionDecided: vi.fn(async () => ({ published: true, messageId: 'replay-msg-1' })),
    resolveEmailConnectionId: vi.fn(async () => 'conn-1'),
    resolveReplyToForTenant: vi.fn(async () => null),
    getPubSubClient: vi.fn(() => ({ publish: vi.fn() })),
    publicWebhookBaseUrl: 'https://example.test',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KAN-1005 M2-2 — engine-path replay (replay_via="action_decided")', () => {
  it('policy allow → publishActionDecided called with the verbatim event; publishActionSend NOT called; no Decision row written', async () => {
    const row = buildEngineRow();
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts();

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.totalClaimed).toBe(1);
    expect(result.dispatched).toBe(1);
    // Engine path: publishActionDecided wins; publishActionSend stays untouched.
    expect(opts.publishActionDecided).toHaveBeenCalledTimes(1);
    expect(opts.publishActionSend).not.toHaveBeenCalled();
    // Decision row is NOT written by the cron for engine-path replays —
    // the original runDecisionForContact emission already wrote one before
    // publishing action.decided.
    expect(state.decisionCreate).not.toHaveBeenCalled();
    // The publishActionDecided arg is the stashed event verbatim.
    const args = (opts.publishActionDecided as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[1]).toEqual(row.payload.actionDecidedEvent);
    // Row marked dispatched.
    expect(state.deferredSendUpdate).toHaveBeenCalledTimes(1);
    const update = state.deferredSendUpdate.mock.calls[0]![0] as { data: { status: string } };
    expect(update.data.status).toBe('dispatched');
  });

  it('policy defer → re-defer (no publish, no Decision)', async () => {
    const row = buildEngineRow({ attempts: 1 });
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts({
      evaluateSendPolicy: vi.fn(async () => ({
        type: 'defer' as const,
        reason: 'still window',
        deferUntil: new Date(Date.now() + 30 * 60 * 1000),
      })),
    });

    const result = await processPendingDeferredSends(prisma, opts);
    expect(result.reDeferred).toBe(1);
    expect(opts.publishActionDecided).not.toHaveBeenCalled();
    expect(opts.publishActionSend).not.toHaveBeenCalled();
    expect(state.decisionCreate).not.toHaveBeenCalled();
  });

  it('policy deny → mark cancelled (no publish)', async () => {
    const row = buildEngineRow();
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts({
      evaluateSendPolicy: vi.fn(async () => ({
        type: 'deny' as const,
        reason: 'now suppressed',
        ruleViolated: 'suppression',
      })),
    });

    const result = await processPendingDeferredSends(prisma, opts);
    expect(result.cancelled).toBe(1);
    expect(opts.publishActionDecided).not.toHaveBeenCalled();
    expect(opts.publishActionSend).not.toHaveBeenCalled();
    const update = state.deferredSendUpdate.mock.calls[0]![0] as {
      data: { status: string; cancelReason: string };
    };
    expect(update.data.status).toBe('cancelled');
    expect(update.data.cancelReason).toBe('policy_now_denies');
  });

  it('caller forgot to wire publishActionDecided → cancel with engine_replay_unconfigured (defensive guard)', async () => {
    const row = buildEngineRow();
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts({ publishActionDecided: undefined });

    const result = await processPendingDeferredSends(prisma, opts);
    expect(result.cancelled).toBe(1);
    expect(result.dispatched).toBe(0);
    const update = state.deferredSendUpdate.mock.calls[0]![0] as {
      data: { status: string; cancelReason: string };
    };
    expect(update.data.cancelReason).toBe('engine_replay_unconfigured');
  });

  it('replay_via="action_decided" with malformed payload (missing actionDecidedEvent) → cancel with engine_replay_payload_malformed', async () => {
    const row = buildEngineRow({
      // Cast through unknown — deliberately wrong shape for the test.
      payload: { originalEventId: 'evt-x' } as unknown as EngineRowFixture['payload'],
    });
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts();

    const result = await processPendingDeferredSends(prisma, opts);
    expect(result.cancelled).toBe(1);
    expect(opts.publishActionDecided).not.toHaveBeenCalled();
    const update = state.deferredSendUpdate.mock.calls[0]![0] as {
      data: { cancelReason: string };
    };
    expect(update.data.cancelReason).toBe('engine_replay_payload_malformed');
  });
});

// ─────────────────────────────────────────────
// KAN-1046 — published-false guard + audit-row-on-error
//
// Pre-KAN-1046 the dispatcher always called markDispatched whether or
// not the publish actually fired (the old `{ messageId: string }`
// return shape gave nothing to check). Now the return is
// `{ published: boolean; messageId: string | null }` and the dispatcher
// keeps the row in `pending` (outcome: 'error') on a failed publish so
// the next cron tick retries. The catch path in
// processPendingDeferredSends also writes an AuditLog row with
// actionType='deferred_send_replay_failed' so silent retry loops are
// post-hoc queryable.
// ─────────────────────────────────────────────

describe('KAN-1046 — published-false guard + audit-row-on-error', () => {
  it('publishActionDecided returns {published:false} → outcome error, row NOT marked dispatched', async () => {
    const row = buildEngineRow();
    const { prisma, state } = makePrismaMock([row]);
    const opts = makeOpts({
      publishActionDecided: vi.fn(async () => ({ published: false, messageId: null })),
    });

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.totalClaimed).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(result.errors).toBe(0); // pre-published-false guard returns outcome:'error' but isn't thrown
    // Row's outcome surfaces the publish failure
    expect(result.rowResults[0]!.outcome).toBe('error');
    expect(result.rowResults[0]!.error).toBe('engine_replay_publish_failed');
    // Critically: deferredSend.update NEVER fired — the row stays `pending`
    // so the next cron tick retries naturally. The pre-fix silent-mark-
    // dispatched bug is now structurally impossible.
    expect(state.deferredSendUpdate).not.toHaveBeenCalled();
  });

  it('row processing throws → AuditLog row written with actionType=deferred_send_replay_failed', async () => {
    const row = buildEngineRow();
    const { prisma, state } = makePrismaMock([row]);
    // Force the throw from inside publishActionDecided so it propagates
    // through dispatchActionDecidedReplay (no inner catch) up to the
    // outer try/catch in processPendingDeferredSends.
    const opts = makeOpts({
      publishActionDecided: vi.fn(async () => {
        throw new Error('synthetic publish failure');
      }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.errors).toBe(1);
    expect(result.rowResults[0]!.outcome).toBe('error');
    // AuditLog row is best-effort but MUST fire on the catch path so the
    // failure is queryable post-hoc by actionType='deferred_send_replay_failed'.
    expect(state.auditLogCreate).toHaveBeenCalledTimes(1);
    const auditArgs = state.auditLogCreate.mock.calls[0]![0] as {
      data: {
        tenantId: string;
        actor: string;
        actionType: string;
        reasoning: string;
        payload: Record<string, unknown>;
      };
    };
    expect(auditArgs.data.actionType).toBe('deferred_send_replay_failed');
    expect(auditArgs.data.actor).toBe('cron_deferred_send_evaluator');
    expect(auditArgs.data.tenantId).toBe(TENANT);
    expect(auditArgs.data.reasoning).toContain('synthetic publish failure');
    expect(auditArgs.data.payload.rowId).toBe(row.id);
    expect(auditArgs.data.payload.replayVia).toBe('action_decided');
    errSpy.mockRestore();
  });

  it('AuditLog write itself throws → caught + logged, batch processing continues unaffected', async () => {
    const row1 = buildEngineRow({ id: 'row_throw' });
    const row2 = buildEngineRow({ id: 'row_ok' });
    const { prisma, state } = makePrismaMock([row1, row2]);
    // Make auditLog.create itself throw — best-effort discipline says
    // the catch path must continue. The second row should still
    // dispatch normally.
    state.auditLogCreate.mockRejectedValueOnce(new Error('audit-down'));

    // First row's processing throws via publish; second row succeeds.
    // Surfaces the auditLog.create failure on row 1, then proves row 2's
    // dispatch is unaffected.
    const stableMock = vi.fn()
      .mockRejectedValueOnce(new Error('first row publish failure'))
      .mockResolvedValueOnce({ published: true, messageId: 'replay-msg-ok' });
    const opts = makeOpts({ publishActionDecided: stableMock });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await processPendingDeferredSends(prisma, opts);

    // Batch outcome: 1 error + 1 dispatched. The auditLog failure on
    // row_throw did NOT destabilize row_ok's dispatch.
    expect(result.errors).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(stableMock).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('KAN-1046 — recovery scenario: 4 stuck PROD rows replay successfully post-fix', () => {
  it('4 engine-path rows in pending → all replay verbatim + mark dispatched (no parse, no Decision row write)', async () => {
    // Mirrors the 4 affected PROD rows (escalation 576851b6 + 3 older).
    // Pre-KAN-1046 these were stuck on every cron tick because the old
    // wiring called publishActionDecided (builder) instead of
    // republishActionDecidedEvent (re-validator). Post-fix the next
    // tick claims all 4 + publishes each verbatim + marks dispatched.
    const rows = Array.from({ length: 4 }, (_, i) =>
      buildEngineRow({
        id: `prod_row_${i + 1}`,
        payload: {
          actionDecidedEvent: {
            eventId: `evt-prod-${i + 1}`,
            eventType: 'action.decided',
            version: '1.0',
            tenantId: TENANT,
            contactId: `prod_contact_${i + 1}`,
            decisionId: `prod_decision_${i + 1}`,
            objectiveId: 'prod_obj',
            publishedAt: '2026-06-01T00:00:00Z',
            action: { actionType: 'send_followup_email', channel: 'email', payload: {} },
            decision: {
              selectedStrategy: 'agentic',
              confidenceScore: 80,
              strategyReasoning: 'prod r',
              actionReasoning: 'prod a',
            },
            routing: { agentType: 'agentic', priority: 'normal', maxRetries: 3, timeoutMs: 30000 },
          },
          originalEventId: `evt-prod-${i + 1}`,
        },
      }),
    );
    const { prisma, state } = makePrismaMock(rows);
    const opts = makeOpts();

    const result = await processPendingDeferredSends(prisma, opts);

    expect(result.totalClaimed).toBe(4);
    expect(result.dispatched).toBe(4);
    expect(result.errors).toBe(0);
    expect(result.cancelled).toBe(0);
    // Each row published its stashed envelope verbatim — no flat-to-
    // nested rebuild attempted.
    expect(opts.publishActionDecided).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 4; i++) {
      const args = (opts.publishActionDecided as ReturnType<typeof vi.fn>).mock.calls[i]!;
      const eventArg = args[1] as { eventId: string; decision: { selectedStrategy: string } };
      expect(eventArg.eventId).toBe(`evt-prod-${i + 1}`);
      // Decision sub-object preserved verbatim — the load-bearing fields
      // (selectedStrategy / confidenceScore / strategyReasoning /
      // actionReasoning) survive into downstream consumers.
      expect(eventArg.decision.selectedStrategy).toBe('agentic');
    }
    // Decision rows NOT written — cron doesn't write for engine-path replays
    // (original runDecisionForContact emission already wrote them).
    expect(state.decisionCreate).not.toHaveBeenCalled();
  });
});

describe('KAN-1005 M2-2 — back-compat: replay_via="action_send" (Lead Inbox) still works alongside engine rows', () => {
  it('Lead Inbox row in a batch with engine rows → each routes to its own path', async () => {
    // Two rows in one cron tick: one Lead Inbox (action_send), one engine
    // (action_decided). Same batch, different publishers.
    const leadRow = {
      id: 'lead_1',
      tenant_id: TENANT,
      deal_id: 'deal-1',
      contact_id: CONTACT,
      payload: {
        brainDecision: {
          nextBestAction: { type: 'send_follow_up', reasoning: 't' },
          confidence: 0.8,
          modelTier: 'reasoning',
          evaluatedAt: '2026-05-26T17:00:00Z',
          llmInputTokens: 100,
          llmOutputTokens: 50,
          currentStateSnapshot: { currentStageName: 'Qualified', daysInCurrentStage: 0 },
        },
        composed: { subject: 'Hi', body: 'B', tone: 'pro' },
        contactEmail: 'lead@example.com',
      },
      defer_until: new Date(Date.now() - 60 * 1000),
      attempts: 0,
      replay_via: 'action_send',
    };
    const engineRow = buildEngineRow();

    const { prisma } = makePrismaMock([leadRow, engineRow] as unknown as EngineRowFixture[]);
    const opts = makeOpts();

    const result = await processPendingDeferredSends(prisma, opts);
    expect(result.totalClaimed).toBe(2);
    expect(result.dispatched).toBe(2);
    // Lead row uses publishActionSend; engine row uses publishActionDecided.
    expect(opts.publishActionSend).toHaveBeenCalledTimes(1);
    expect(opts.publishActionDecided).toHaveBeenCalledTimes(1);
    const sendArgs = (opts.publishActionSend as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      toEmail: string;
    };
    expect(sendArgs.toEmail).toBe('lead@example.com');
  });
});
