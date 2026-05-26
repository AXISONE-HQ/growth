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
  state: { $queryRaw: ReturnType<typeof vi.fn>; deferredSendUpdate: ReturnType<typeof vi.fn>; decisionCreate: ReturnType<typeof vi.fn> };
} {
  const $queryRaw = vi.fn(async () => rows);
  const deferredSendUpdate = vi.fn(async () => ({}));
  const decisionCreate = vi.fn(async () => ({ id: 'd-cron' }));
  const prisma = {
    $queryRaw,
    decision: { create: decisionCreate },
    deferredSend: { update: deferredSendUpdate },
  } as unknown as PrismaClient;
  return { prisma, state: { $queryRaw, deferredSendUpdate, decisionCreate } };
}

function makeOpts(overrides: Partial<ProcessOptions> = {}): ProcessOptions {
  return {
    evaluateSendPolicy: vi.fn(async () => ({ type: 'allow' as const, reason: 'ok' })),
    publishActionSend: vi.fn(async () => 'should-not-be-called'),
    publishActionDecided: vi.fn(async () => ({ messageId: 'replay-msg-1' })),
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
