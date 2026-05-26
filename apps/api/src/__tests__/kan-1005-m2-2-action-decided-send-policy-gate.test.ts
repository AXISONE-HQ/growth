/**
 * KAN-1005 M2-2 — Send-policy gate on the engine dispatch path
 * (apps/api/src/subscribers/action-decided-push.ts).
 *
 * Choke-point: single subscriber both autonomous (run-decision-for-contact)
 * and approve-to-send (recommendations.accept) paths flow through. Gating
 * once here covers ALL four production publishActionDecided call sites.
 *
 * 3-outcome matrix:
 *   - allow → composeMessage + gateAndPublishComposed called (happy path)
 *   - defer → DeferredSend.create with replayVia='action_decided' +
 *             actionDecidedEvent payload; NO compose/dispatch
 *   - deny  → best-effort AuditLog.create('engine.send_policy_denied');
 *             NO compose/dispatch; 200-ack
 *
 * Failure modes pinned:
 *   - audit write throws → caught, deny still 200-acks
 *   - defer persist throws → 200-ack (no Pub/Sub storm), logged
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Send-policy mock — swapped per-test ─────────────────────────────
const evaluateSendPolicyMock = vi.fn();
vi.mock('../../../../packages/api/src/services/send-policy.js', () => ({
  evaluateSendPolicy: evaluateSendPolicyMock,
}));

// ── Compose + guardrail mocks ───────────────────────────────────────
const composeMessageMock = vi.fn();
const resolveEmailConnectionIdMock = vi.fn();
const gateAndPublishComposedMock = vi.fn();
vi.mock('../../../../packages/api/src/services/message-composer.js', () => ({
  composeMessage: composeMessageMock,
  resolveEmailConnectionId: resolveEmailConnectionIdMock,
  gateAndPublishComposed: gateAndPublishComposedMock,
}));

// ── Knowledge load (no-op for these tests) ──────────────────────────
vi.mock('../../../../packages/api/src/services/context-assembler.js', () => ({
  loadKnowledge: vi.fn(async () => []),
}));

// ── Pub/Sub client + Event schema passthrough ───────────────────────
vi.mock('../../../../packages/api/src/lib/pubsub-client.js', () => ({
  getPubSubClient: vi.fn(() => ({})),
}));
vi.mock('../../../../packages/api/src/services/action-decided-publisher.js', async () => {
  const { z } = await import('zod');
  return {
    ActionDecidedEventSchema: z.object({
      eventId: z.string(),
      eventType: z.literal('action.decided'),
      version: z.literal('1.0'),
      publishedAt: z.string(),
      tenantId: z.string(),
      contactId: z.string(),
      objectiveId: z.string(),
      decisionId: z.string(),
      action: z.object({
        actionType: z.string(),
        channel: z.string().nullable(),
        payload: z.record(z.unknown()),
      }),
      decision: z.object({
        selectedStrategy: z.string(),
        confidenceScore: z.number(),
        strategyReasoning: z.string(),
        actionReasoning: z.string(),
      }),
      routing: z.object({
        agentType: z.string(),
        priority: z.enum(['high', 'normal', 'low']),
        maxRetries: z.number(),
        timeoutMs: z.number(),
      }),
    }),
  };
});

// ── OIDC — always pass ──────────────────────────────────────────────
vi.mock('../lib/oidc-pubsub-verify.js', () => ({
  verifyPubsubOidc: vi.fn(async () => true),
}));

// ── Prisma mock — contact lookup + auditLog/deferredSend writes ─────
const contactFindFirstMock = vi.fn();
const auditLogCreateMock = vi.fn(async () => ({ id: 'audit-row-1' }));
const deferredSendCreateMock = vi.fn(async () => ({ id: 'deferred-row-1' }));
vi.mock('../prisma.js', () => ({
  prisma: {
    contact: { findFirst: contactFindFirstMock },
    auditLog: { create: auditLogCreateMock },
    deferredSend: { create: deferredSendCreateMock },
  },
}));

// Build envelope helper.
const envelopeFor = (eventPayload: object, messageId = 'm1') => ({
  message: {
    data: Buffer.from(JSON.stringify(eventPayload), 'utf8').toString('base64'),
    messageId,
  },
});

// Build a valid event the schema will accept.
const baseEvent = {
  eventId: 'evt-1',
  eventType: 'action.decided' as const,
  version: '1.0' as const,
  publishedAt: '2026-05-26T17:00:00Z',
  tenantId: 't1',
  contactId: 'c1',
  objectiveId: 'o1',
  decisionId: 'd1',
  action: {
    actionType: 'send_followup_email',
    channel: 'email',
    payload: { instruction: 'follow up with the lead' },
  },
  decision: {
    selectedStrategy: 'agentic',
    confidenceScore: 80,
    strategyReasoning: 'r',
    actionReasoning: 'a',
  },
  routing: {
    agentType: 'agentic',
    priority: 'normal' as const,
    maxRetries: 3,
    timeoutMs: 30000,
  },
};

async function postOne(eventPayload: object, messageId = 'm1') {
  // Subscriber mounts /action-decided on its own Hono app; the /pubsub
  // prefix is added at the outer app.route() in apps/api/src/index.ts.
  // In tests we hit the inner app directly at /action-decided.
  const { actionDecidedPushApp } = await import('../subscribers/action-decided-push.js');
  const req = new Request('http://test/action-decided', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(envelopeFor(eventPayload, messageId)),
  });
  return actionDecidedPushApp.fetch(req);
}

describe('KAN-1005 M2-2 — send-policy gate on action-decided dispatch path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contactFindFirstMock.mockResolvedValue({ email: 'lead@example.com' });
    composeMessageMock.mockResolvedValue({
      subject: 's',
      body: 'b',
      unsubscribeUrl: 'http://u',
    });
    resolveEmailConnectionIdMock.mockResolvedValue('conn-1');
    gateAndPublishComposedMock.mockResolvedValue({
      sent: true,
      decision: 'allow',
      messageId: 'pubsub-msg-1',
    });
  });

  it('allow → composeMessage + gateAndPublishComposed called; no DeferredSend / AuditLog writes', async () => {
    evaluateSendPolicyMock.mockResolvedValue({ type: 'allow', reason: 'all checks pass' });
    const res = await postOne(baseEvent);
    expect(res.status).toBe(200);
    expect(evaluateSendPolicyMock).toHaveBeenCalledTimes(1);
    expect(composeMessageMock).toHaveBeenCalledTimes(1);
    expect(gateAndPublishComposedMock).toHaveBeenCalledTimes(1);
    expect(deferredSendCreateMock).not.toHaveBeenCalled();
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });

  it('deny → AuditLog.create("engine.send_policy_denied"); composeMessage NOT called; 200-ack', async () => {
    evaluateSendPolicyMock.mockResolvedValue({
      type: 'deny',
      reason: 'Contact suppressed for email: email_unsubscribe on 2026-05-26',
      ruleViolated: 'suppression',
    });
    const res = await postOne(baseEvent);
    expect(res.status).toBe(200);
    expect(evaluateSendPolicyMock).toHaveBeenCalledTimes(1);
    expect(composeMessageMock).not.toHaveBeenCalled();
    expect(gateAndPublishComposedMock).not.toHaveBeenCalled();
    expect(deferredSendCreateMock).not.toHaveBeenCalled();
    // AuditLog write is fire-and-forget; await microtask flush.
    await new Promise((r) => setImmediate(r));
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    const auditCallArgs = auditLogCreateMock.mock.calls[0] as unknown as [
      { data: { actionType: string; actor: string; reasoning: string; payload: Record<string, unknown> } },
    ];
    const auditArgs = auditCallArgs[0];
    expect(auditArgs.data.actionType).toBe('engine.send_policy_denied');
    expect(auditArgs.data.actor).toBe('engine_send_policy');
    expect(auditArgs.data.payload.ruleViolated).toBe('suppression');
    expect(auditArgs.data.payload.source).toBe('action_decided');
    expect(auditArgs.data.payload.decisionId).toBe('d1');
  });

  it('deny — audit-log write fails → still 200-acks (best-effort + catch)', async () => {
    evaluateSendPolicyMock.mockResolvedValue({
      type: 'deny',
      reason: 'rate limit',
      ruleViolated: 'rate_limit',
    });
    auditLogCreateMock.mockRejectedValueOnce(new Error('audit DB down'));
    const res = await postOne(baseEvent);
    expect(res.status).toBe(200);
    expect(composeMessageMock).not.toHaveBeenCalled();
    // The rejected promise is caught in the .catch() — handler still acks.
    await new Promise((r) => setImmediate(r));
  });

  it('defer → DeferredSend.create with replayVia="action_decided" + full actionDecidedEvent payload; no compose/dispatch', async () => {
    const deferUntil = new Date('2026-05-26T22:00:00Z');
    evaluateSendPolicyMock.mockResolvedValue({
      type: 'defer',
      reason: 'Outside tenant send window (9:00-21:00 UTC)',
      deferUntil,
    });
    const res = await postOne(baseEvent);
    expect(res.status).toBe(200);
    expect(composeMessageMock).not.toHaveBeenCalled();
    expect(gateAndPublishComposedMock).not.toHaveBeenCalled();
    expect(auditLogCreateMock).not.toHaveBeenCalled();
    expect(deferredSendCreateMock).toHaveBeenCalledTimes(1);
    const deferCallArgs = deferredSendCreateMock.mock.calls[0] as unknown as [
      {
        data: {
          tenantId: string;
          dealId: string | null;
          contactId: string;
          deferUntil: Date;
          deferReason: string;
          status: string;
          attempts: number;
          replayVia: string;
          payload: { actionDecidedEvent: Record<string, unknown>; originalEventId: string };
        };
      },
    ];
    const args = deferCallArgs[0];
    expect(args.data.tenantId).toBe('t1');
    expect(args.data.dealId).toBeNull(); // engine path has no Deal anchor
    expect(args.data.contactId).toBe('c1');
    expect(args.data.deferUntil).toBe(deferUntil);
    expect(args.data.status).toBe('pending');
    expect(args.data.replayVia).toBe('action_decided'); // ← THE discriminator
    expect(args.data.payload.actionDecidedEvent.decisionId).toBe('d1');
    expect(args.data.payload.actionDecidedEvent.eventId).toBe('evt-1');
    expect(args.data.payload.originalEventId).toBe('evt-1');
  });

  it('defer — DeferredSend.create throws → 200-ack (no Pub/Sub retry storm)', async () => {
    evaluateSendPolicyMock.mockResolvedValue({
      type: 'defer',
      reason: 'window',
      deferUntil: new Date('2026-05-26T22:00:00Z'),
    });
    deferredSendCreateMock.mockRejectedValueOnce(new Error('deferred_sends DB down'));
    const res = await postOne(baseEvent);
    expect(res.status).toBe(200); // still ack
    expect(composeMessageMock).not.toHaveBeenCalled();
  });

  it('non-email channel → 200-ack BEFORE policy evaluation (existing path preserved)', async () => {
    const nonEmail = { ...baseEvent, action: { ...baseEvent.action, channel: 'sms' } };
    const res = await postOne(nonEmail);
    expect(res.status).toBe(200);
    expect(evaluateSendPolicyMock).not.toHaveBeenCalled();
    expect(composeMessageMock).not.toHaveBeenCalled();
  });
});

describe('KAN-1005 M2-2 — gate ordering: policy BEFORE compose (LLM cost guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contactFindFirstMock.mockResolvedValue({ email: 'lead@example.com' });
  });

  it('deny path does NOT call composeMessage (saves the LLM call)', async () => {
    evaluateSendPolicyMock.mockResolvedValue({
      type: 'deny',
      reason: 'suppressed',
      ruleViolated: 'suppression',
    });
    await postOne(baseEvent);
    // The whole point of gating BEFORE compose: deny saves the LLM call.
    expect(composeMessageMock).not.toHaveBeenCalled();
  });

  it('defer path does NOT call composeMessage (LLM call deferred to re-dispatch)', async () => {
    evaluateSendPolicyMock.mockResolvedValue({
      type: 'defer',
      reason: 'window',
      deferUntil: new Date('2026-05-26T22:00:00Z'),
    });
    await postOne(baseEvent);
    // Cron re-runs evaluateSendPolicy; LLM compose only fires on T2 allow.
    expect(composeMessageMock).not.toHaveBeenCalled();
  });
});
