/**
 * KAN-1028 regression — decision-run-push handler ACKs 200 on unhandled throw.
 *
 * Pre-fix: handler returned 500 on `runDecisionForContact` throw → Pub/Sub
 * retried 3-8 times. Three 2026-05-25 incidents demonstrated this is
 * never the right behavior — all three throws were persistent (schema
 * drift, calling-convention bug, Zod vocab mismatch), and the retry-
 * storm cost $0.07-$0.31 in shadow LLM calls per crash without ever
 * recovering.
 *
 * Post-fix (interim, pulled forward from KAN-1018 core): handler returns
 * 200 with structured error log on any unhandled throw → Pub/Sub does
 * NOT retry → bounded to 1 attempt. KAN-1018 full A4 design will add
 * persistent-vs-transient categorization so legit transient errors still
 * retry; until then, the bounded-loss-on-transient is acceptable
 * (re-evaluation happens on next scheduled pass).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock the decision engine BEFORE importing the handler.
vi.mock('../../../../packages/api/src/services/run-decision-for-contact.js', () => ({
  runDecisionForContact: vi.fn(async () => {
    throw new Error('simulated engine throw — Zod parse, Prisma error, etc.');
  }),
}));

// Mock Pub/Sub OIDC verify so test doesn't need real OIDC tokens.
vi.mock('../lib/oidc-pubsub-verify.js', () => ({
  verifyPubsubOidc: vi.fn(async () => true),
}));

// Mock Prisma client (handler initializes it at module load).
vi.mock('../prisma.js', () => ({
  prisma: {
    campaign: { findFirst: vi.fn(async () => ({ id: 'c1', status: 'active', audienceEvaluatedAt: new Date() })) },
    contactObjectiveStack: {
      findFirst: vi.fn(async () => ({
        id: 'stack-1',
        status: 'active',
        lastEvaluatedAt: new Date(0), // epoch — passes dedup
        objectiveId: 'obj-warm-up',
      })),
    },
    tenant: {
      findUnique: vi.fn(async () => ({ dailyLlmCostCapUsd: null })),
    },
  },
}));

// Mock Redis client to return success on counter ops.
vi.mock('../services/redis-client.js', () => ({
  getRedisClient: () => ({
    get: vi.fn(async () => null), // counter starts at 0
    incrby: vi.fn(async () => 10000),
    expire: vi.fn(async () => 1),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KAN-1028 — decision-run-push handler ACKs 200 on unhandled throw', () => {
  it('returns HTTP 200 (NOT 500) when runDecisionForContact throws', async () => {
    // Import LAST — after mocks are applied.
    const { decisionRunPushApp } = await import('../subscribers/decision-run-push.js');

    // Construct a valid Pub/Sub envelope. The handler decodes base64 + parses.
    const eventPayload = JSON.stringify({
      tenantId: '9ca85088-f65b-4bac-b098-fff742281ede',
      contactId: 'ffbdc3f2-bb62-4753-b3c7-7c242bd56759',
      campaignId: '56a79f21-ade6-4ab3-83b8-4ae331b9edc0',
    });
    const envelope = {
      message: {
        data: Buffer.from(eventPayload, 'utf8').toString('base64'),
        messageId: 'test-message-id-1',
        publishTime: '2026-05-25T20:00:00Z',
      },
      subscription: 'projects/growth-493400/subscriptions/growth-api-decision-run',
    };

    const app = new Hono();
    app.route('/pubsub', decisionRunPushApp);
    const res = await app.request('/pubsub/decision-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });

    // Pre-fix: this would be 500 (retry). Post-fix: 200 (ACK, no retry).
    expect(res.status).toBe(200);
    const body = await res.text();
    // The interim message is 'persistent_error' (vs the old 'retry' on 500).
    expect(body).toBe('persistent_error');
  });
});
