/**
 * KAN-1018 — decision-run-dlq subscriber unit test.
 *
 * Pins:
 *   - DLQ message from EXPLICIT publish (dlqSource=persistent_classifier)
 *     → logs full context + ACKs 200, no retry
 *   - DLQ message from AUTO dead-letter (no dlqSource attribute, has
 *     CloudPubSubDeadLetterSourceDeliveryCount) → logs + ACKs 200
 *   - Malformed envelope → still ACKs 200 (can't retry a malformed DLQ)
 *   - OIDC fail → 401
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// OIDC mock — controllable per-test
const verifyPubsubOidc = vi.fn(async () => true);
vi.mock('../lib/oidc-pubsub-verify.js', () => ({ verifyPubsubOidc }));

beforeEach(() => {
  vi.clearAllMocks();
  verifyPubsubOidc.mockResolvedValue(true);
});

async function post(envelope: object) {
  const { decisionRunDlqApp } = await import('../subscribers/decision-run-dlq.js');
  const app = new Hono();
  app.route('/pubsub', decisionRunDlqApp);
  return app.request('/pubsub/decision-run-dlq', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

describe('KAN-1018 — DLQ subscriber: explicit persistent_classifier flow', () => {
  it('rich payload from decision-run-push → ACK 200', async () => {
    const dlqPayload = {
      originalEvent: {
        tenantId: '9ca85088-f65b-4bac-b098-fff742281ede',
        contactId: 'ffbdc3f2-bb62-4753-b3c7-7c242bd56759',
        campaignId: '56a79f21-ade6-4ab3-83b8-4ae331b9edc0',
      },
      originalMessageId: 'src-msg-1',
      classification: { category: 'persistent', reasonCode: 'zod_parse' },
      error: 'Invalid enum value warm_up',
      errorName: 'ZodError',
      stack: 'ZodError: Invalid enum… | at parse…',
      engineStarted: true,
    };
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(dlqPayload), 'utf8').toString('base64'),
        messageId: 'dlq-msg-1',
        publishTime: '2026-05-25T22:00:00Z',
        attributes: {
          dlqSource: 'persistent_classifier',
          tenantId: dlqPayload.originalEvent.tenantId,
          reasonCode: 'zod_parse',
          originalMessageId: 'src-msg-1',
        },
      },
      subscription: 'projects/growth-493400/subscriptions/growth-api-decision-run-dlq',
    };

    const res = await post(envelope);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('KAN-1018 — DLQ subscriber: auto dead-letter flow (transient exhausted retries)', () => {
  it('raw original event + CloudPubSubDeadLetterSourceDeliveryCount → ACK 200', async () => {
    const originalEvent = {
      tenantId: '9ca85088-f65b-4bac-b098-fff742281ede',
      contactId: 'ffbdc3f2-bb62-4753-b3c7-7c242bd56759',
      campaignId: '56a79f21-ade6-4ab3-83b8-4ae331b9edc0',
    };
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(originalEvent), 'utf8').toString('base64'),
        messageId: 'dlq-auto-msg-2',
        publishTime: '2026-05-25T22:05:00Z',
        attributes: {
          // Pub/Sub appends this on auto-dead-letter; no dlqSource attribute.
          CloudPubSubDeadLetterSourceDeliveryCount: '5',
        },
      },
      subscription: 'projects/growth-493400/subscriptions/growth-api-decision-run-dlq',
    };

    const res = await post(envelope);
    expect(res.status).toBe(200);
  });
});

describe('KAN-1018 — DLQ subscriber: malformed envelope', () => {
  it('malformed envelope → still ACK 200 (DLQ messages cannot productively retry)', async () => {
    const envelope = { not: 'a valid envelope' };
    const res = await post(envelope);
    expect(res.status).toBe(200);
  });

  it('valid envelope but undecodable inner JSON → still ACK 200', async () => {
    const envelope = {
      message: {
        data: 'not-base64-decodable-as-json',
        messageId: 'dlq-bad-3',
      },
    };
    const res = await post(envelope);
    expect(res.status).toBe(200);
  });
});

describe('KAN-1018 — DLQ subscriber: OIDC', () => {
  it('OIDC fail → 401', async () => {
    verifyPubsubOidc.mockResolvedValueOnce(false);
    const envelope = {
      message: {
        data: Buffer.from('{}', 'utf8').toString('base64'),
        messageId: 'dlq-oidc-fail-1',
      },
    };
    const res = await post(envelope);
    expect(res.status).toBe(401);
  });
});
