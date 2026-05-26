/**
 * KAN-1018 — decision-run-push classify-and-route behavior matrix.
 *
 * Replaces the interim catch-all-ack from PR #217 (covered by the prior
 * kan-1028-decision-run-push-throw-ack.test.ts, which becomes redundant
 * once this lands — see comment in that file).
 *
 * Pins:
 *   - PERSISTENT throw → ack 200 ('persistent_error') + DLQ publish +
 *     NO Pub/Sub retry
 *   - TRANSIENT throw → return 500 ('transient_error') + NO DLQ publish
 *     (Pub/Sub auto-retries; after maxAttempts=5 it auto-dead-letters)
 *   - A2: counter incremented on success AND on engine throw (any
 *     classification — the engine may have spent LLM tokens before
 *     throwing). Pre-engine throws (would-be: dynamic import fail) skip
 *     the increment via the engineStarted flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Engine mock — swapped per-test via mockImplementationOnce ─────────
const runDecisionForContact = vi.fn();
vi.mock('../../../../packages/api/src/services/run-decision-for-contact.js', () => ({
  runDecisionForContact,
}));

// ── OIDC verify — always-pass for unit tests ──────────────────────────
vi.mock('../lib/oidc-pubsub-verify.js', () => ({
  verifyPubsubOidc: vi.fn(async () => true),
}));

// ── Prisma — minimum shape to pass guards + gates ─────────────────────
const stackUpdate = vi.fn(async () => ({}));
vi.mock('../prisma.js', () => ({
  prisma: {
    campaign: {
      findFirst: vi.fn(async () => ({
        id: 'c1',
        status: 'active',
        audienceEvaluatedAt: new Date(),
      })),
    },
    contactObjectiveStack: {
      findFirst: vi.fn(async () => ({
        id: 'stack-1',
        status: 'active',
        lastEvaluatedAt: new Date(0), // epoch → dedup gate passes
        objectiveId: 'obj-warm-up',
      })),
      update: stackUpdate,
    },
    tenant: {
      findUnique: vi.fn(async () => ({ dailyLlmCostCapUsd: null })),
    },
  },
}));

// ── Redis counter — stable mock instance so per-test overrides stick
//    across the multiple `getRedisClient()` calls each handler makes
//    (gate-check + finally increment both call it).
//
// Unit math: USD_TO_INTEGER_UNITS = 100_000 (per per-tenant-daily-counter.ts).
// So $0.10 per-eval = 10_000 units; $10 cap = 1_000_000 units.
const redisGet: ReturnType<typeof vi.fn> = vi.fn(async (): Promise<string | null> => null); // default: counter empty
const incrby = vi.fn(async () => 10000); // returns "new total = $0.10 in units"
const redisClient = {
  get: redisGet,
  incrby,
  expire: vi.fn(async () => 1),
};
vi.mock('../services/redis-client.js', () => ({
  getRedisClient: () => redisClient,
}));

// ── Pub/Sub publish mock — used for the persistent-classifier DLQ route
const dlqPublishMessage: ReturnType<typeof vi.fn> = vi.fn(
  async (_arg: { data: Buffer; attributes?: Record<string, string> }): Promise<string> =>
    'mock-dlq-message-id',
);
const dlqTopicSpy = vi.fn(() => ({ publishMessage: dlqPublishMessage }));
const mockPubsubClient = { topic: dlqTopicSpy } as any;

const envelopeFor = (eventPayload: object, messageId: string) => ({
  message: {
    data: Buffer.from(JSON.stringify(eventPayload), 'utf8').toString('base64'),
    messageId,
    publishTime: '2026-05-25T20:00:00Z',
  },
  subscription: 'projects/growth-493400/subscriptions/growth-api-decision-run',
});

const baseEvent = {
  tenantId: '9ca85088-f65b-4bac-b098-fff742281ede',
  contactId: 'ffbdc3f2-bb62-4753-b3c7-7c242bd56759',
  campaignId: '56a79f21-ade6-4ab3-83b8-4ae331b9edc0',
};

async function postOne(eventPayload: object, messageId: string) {
  // Re-import per-test so the singleton Pub/Sub client + module-level
  // state is fresh.
  const { decisionRunPushApp, __setDecisionRunPushPubsubForTest } = await import(
    '../subscribers/decision-run-push.js'
  );
  __setDecisionRunPushPubsubForTest(mockPubsubClient);
  const app = new Hono();
  app.route('/pubsub', decisionRunPushApp);
  return app.request('/pubsub/decision-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelopeFor(eventPayload, messageId)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default engine impl per-test = success returning a minimal Decision
  runDecisionForContact.mockImplementation(async () => ({
    decisionId: 'd-1',
    outcome: 'ESCALATED',
    strategy: 'direct',
    action: { type: 'send_message' },
    confidence: 0.4,
    reasoning: 'mock reasoning',
    latencyMs: 0,
  }));
});

describe('KAN-1018 — PERSISTENT errors: ack 200 + DLQ publish, no retry', () => {
  it('Zod parse failure → 200 + persistent_error + DLQ publish', async () => {
    runDecisionForContact.mockImplementationOnce(async () => {
      const err = new Error('Invalid enum value warm_up — Zod parse failed');
      throw err;
    });
    const res = await postOne(baseEvent, 'msg-persistent-1');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('persistent_error');
    // Allow the fire-and-forget DLQ publish + counter increment to flush.
    await new Promise((r) => setTimeout(r, 20));
    expect(dlqTopicSpy).toHaveBeenCalledWith('decision.run.dlq');
    expect(dlqPublishMessage).toHaveBeenCalledTimes(1);
    const dlqCall = dlqPublishMessage.mock.calls[0][0] as any;
    expect(dlqCall.attributes.dlqSource).toBe('persistent_classifier');
    expect(dlqCall.attributes.tenantId).toBe(baseEvent.tenantId);
    // reasonCode comes from the classifier — msg_persistent_pattern for
    // generic Error messages matching the persistent text patterns.
    expect(dlqCall.attributes.reasonCode).toMatch(/persistent_pattern|zod_parse/);
  });

  it('TypeError → 200 + persistent + DLQ', async () => {
    runDecisionForContact.mockImplementationOnce(async () => {
      // The classic "cannot read properties of undefined" — same shape as
      // M1 smoke bug #5 (call-cast hiding wrong signature).
      const err = new TypeError("Cannot read properties of undefined (reading 'findFirstOrThrow')");
      throw err;
    });
    const res = await postOne(baseEvent, 'msg-persistent-2');
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(dlqPublishMessage).toHaveBeenCalledTimes(1);
    const dlqCall = dlqPublishMessage.mock.calls[0][0] as any;
    expect(dlqCall.attributes.reasonCode).toBe('type_error');
  });

  it('Unknown plain Error → 200 + persistent (fail-safe default)', async () => {
    runDecisionForContact.mockImplementationOnce(async () => {
      throw new Error('mysterious failure');
    });
    const res = await postOne(baseEvent, 'msg-persistent-3');
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(dlqPublishMessage).toHaveBeenCalledTimes(1);
    const dlqCall = dlqPublishMessage.mock.calls[0][0] as any;
    expect(dlqCall.attributes.reasonCode).toBe('unknown_fail_safe');
  });
});

describe('KAN-1018 — TRANSIENT errors: 500 + no DLQ (Pub/Sub retries)', () => {
  it('LLM timeout → 500 + transient_error + NO DLQ publish', async () => {
    runDecisionForContact.mockImplementationOnce(async () => {
      throw new Error('LLM timeout');
    });
    const res = await postOne(baseEvent, 'msg-transient-1');
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('transient_error');
    await new Promise((r) => setTimeout(r, 20));
    expect(dlqPublishMessage).not.toHaveBeenCalled();
  });

  it('ECONNRESET → 500 + transient', async () => {
    runDecisionForContact.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      throw err;
    });
    const res = await postOne(baseEvent, 'msg-transient-2');
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(dlqPublishMessage).not.toHaveBeenCalled();
  });

  it('HTTP 503 → 500 + transient', async () => {
    runDecisionForContact.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
      throw err;
    });
    const res = await postOne(baseEvent, 'msg-transient-3');
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(dlqPublishMessage).not.toHaveBeenCalled();
  });
});

describe('KAN-1018 — A2: counter incremented on success AND engine throw', () => {
  it('SUCCESS → counter incremented (existing behavior preserved)', async () => {
    const res = await postOne(baseEvent, 'msg-success');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    await new Promise((r) => setTimeout(r, 20));
    expect(incrby).toHaveBeenCalledTimes(1);
    // Stack update fires on success path (lastEvaluatedAt = now).
    await new Promise((r) => setTimeout(r, 10));
    expect(stackUpdate).toHaveBeenCalledTimes(1);
  });

  it('PERSISTENT throw → counter STILL incremented (storm-cost bounded)', async () => {
    runDecisionForContact.mockImplementationOnce(async () => {
      throw new Error('Zod parse error');
    });
    const res = await postOne(baseEvent, 'msg-persistent-counter');
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(incrby).toHaveBeenCalledTimes(1);
    // Stack update does NOT fire on throw (preserves redeliver-after-fix)
    expect(stackUpdate).not.toHaveBeenCalled();
  });

  it('TRANSIENT throw → counter STILL incremented (caps retry storm)', async () => {
    runDecisionForContact.mockImplementationOnce(async () => {
      throw new Error('LLM timeout');
    });
    const res = await postOne(baseEvent, 'msg-transient-counter');
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(incrby).toHaveBeenCalledTimes(1);
    expect(stackUpdate).not.toHaveBeenCalled();
  });
});

describe('KAN-1005 M2-1 — action-count read fail-closed on Redis error', () => {
  it('Redis throws on action-count GET → 200-ack, NO engine call, NO count=0 fall-through', async () => {
    // KAN-1005 M2-1 hardening (founder review 2026-05-26): the M2-1
    // gate's local Redis read fails CLOSED, not OPEN. Without this,
    // a Redis blip mid-handler — once the cost-cap shield's ordering
    // is broken by M2-7's cron — would let count=0 < limit through
    // and uncap autonomous actions. Mirror cost_signal_unavailable.
    //
    // The cost-cap gate runs FIRST in the handler and shares the
    // Redis client; in practice it would also fail-closed and we'd
    // never reach this branch. This test isolates the M2-1 read by
    // mocking only its specific call to throw (cost-cap reads stay
    // successful). The point: the gate is independently safe.
    redisGet
      .mockResolvedValueOnce('500000') // cost-cap GET succeeds (half-spent, well under cap)
      .mockRejectedValueOnce(new Error('Redis connection lost mid-handler')); // M2-1 read throws

    runDecisionForContact.mockImplementation(async () => ({
      decisionId: 'should-never-be-set',
      outcome: 'EXECUTED',
      strategy: 'direct',
      action: { type: 'send_message' },
      confidence: 0.9,
      reasoning: '',
      latencyMs: 0,
    }));

    const res = await postOne(baseEvent, 'msg-m21-failclosed');
    expect(res.status).toBe(200);
    // Engine MUST NOT run if the action-count read failed.
    expect(runDecisionForContact).not.toHaveBeenCalled();
    // No DLQ publish (it's a planned ack, not a persistent classifier).
    expect(dlqPublishMessage).not.toHaveBeenCalled();
    // No counter increment (nothing executed).
    expect(incrby).not.toHaveBeenCalled();
  });
});

describe('KAN-1018 — Cost cap bounds transient retries (storm protection)', () => {
  it('Once counter hits cap, subsequent transient retries hit cost_cap_exceeded BEFORE the engine', async () => {
    // Simulate Redis already at cap. USD_TO_INTEGER_UNITS=100_000 so
    // $10 cap = 1_000_000 units stored in Redis. mockResolvedValue (not
    // Once) so every call in the handler sees the at-cap state — the
    // gate may call get() more than once.
    redisGet.mockResolvedValue('1000000');

    runDecisionForContact.mockImplementation(async () => {
      throw new Error('LLM timeout — this should never run because cap fires first');
    });

    const res = await postOne(baseEvent, 'msg-cap-protect');
    // Cost-cap gate rejects → 200 ack, NO engine call, NO retry.
    expect(res.status).toBe(200);
    expect(runDecisionForContact).not.toHaveBeenCalled();
    expect(dlqPublishMessage).not.toHaveBeenCalled();
    // Counter NOT incremented on cap-rejected path (engineStarted=false).
    expect(incrby).not.toHaveBeenCalled();
  });
});
