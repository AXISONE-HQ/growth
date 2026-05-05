/**
 * KAN-817 — End-to-end integration test for subject + bodyPreview round-trip.
 *
 * Drives a single OutboundMessage through:
 *   1. action-send-push (apps/connectors) — publishes action.executed with
 *      subject + bodyPreview captured from event.message.content
 *   2. capture the published payload
 *   3. action-executed-push (apps/api) — would consume that payload and merge
 *      subject + bodyPreview into Engagement.metadata
 *
 * Step 3 is exercised by the parallel kan-816-outbound-engagement-and-replyto
 * test suite (group 3 KAN-817 cases). This test focuses on step 2 — verifying
 * the two endpoints' contracts line up: what the publisher writes is exactly
 * what the consumer expects.
 *
 * "Without mocks where possible" per spec — we mock only the external boundary
 * (Resend SDK + Prisma + Pub/Sub), not the schema validation or the publish
 * site's own helper logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionExecutedEventSchema } from '@growth/connector-contracts';

const publishEventMock = vi.fn<(event: Record<string, unknown>) => Promise<string>>(
  async () => 'msgid-stub',
);
const sendMock = vi.fn();
const findUniqueMock = vi.fn();
const findFirstMock = vi.fn();

vi.mock('../pubsub/index.js', () => ({
  publishEvent: publishEventMock,
}));

vi.mock('../adapters/resend/index.js', () => ({
  ResendAdapter: vi.fn().mockImplementation(() => ({
    send: sendMock,
  })),
}));

vi.mock('../repository/connection-repository.js', () => ({
  prisma: {
    channelConnection: {
      findUnique: findUniqueMock,
      findFirst: findFirstMock,
    },
  },
}));

const { actionSendPushApp } = await import('../subscribers/action-send-push.js');

const TENANT_ID = '9ca85088-f65b-4bac-b098-fff742281ede';
const ACTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const DECISION_ID = 'decision_kan817_roundtrip';
const CONTACT_ID = '11111111-aaaa-bbbb-cccc-222222222222';
const CONNECTION_ID = '35ad29cd-9c96-4a05-8b90-ec3376936d1d';

beforeEach(() => {
  publishEventMock.mockReset();
  publishEventMock.mockResolvedValue('msgid-stub');
  sendMock.mockReset();
  sendMock.mockResolvedValue({
    status: 'sent',
    providerMessageId: 'resend-msg-roundtrip',
  });
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({
    id: CONNECTION_ID,
    tenantId: TENANT_ID,
    channelType: 'EMAIL',
    provider: 'resend',
    providerAccountId: 'acct',
    status: 'ACTIVE',
    credentialsRef: 'ref',
    label: null,
    metadata: { mode: 'simple' },
    connectedAt: new Date(),
  });
  findFirstMock.mockReset();
});

describe('KAN-817 — end-to-end subject + bodyPreview round-trip', () => {
  it('publisher emits a payload that validates against the canonical schema with subject + bodyPreview present', async () => {
    const event = {
      topic: 'action.send' as const,
      timestamp: new Date().toISOString(),
      connectionId: CONNECTION_ID,
      message: {
        tenantId: TENANT_ID,
        actionId: ACTION_ID,
        decisionId: DECISION_ID,
        contactId: CONTACT_ID,
        recipient: { email: 'fred@mkze.vc' },
        content: {
          subject: 'Round-trip pin: KAN-817 subject',
          body: 'Round-trip pin: KAN-817 body preview that the consumer must see verbatim.',
        },
      },
    };
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(event)).toString('base64'),
        messageId: 'pubsub-msg-roundtrip',
      },
    };

    const res = await actionSendPushApp.request('/action-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);

    // Capture the published payload + run it through the canonical schema —
    // contract holds end-to-end. Any drift between publisher's actual emission
    // shape and the schema gets caught here.
    expect(publishEventMock).toHaveBeenCalledOnce();
    const published = publishEventMock.mock.calls[0]![0];
    const validated = ActionExecutedEventSchema.safeParse(published);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.subject).toBe('Round-trip pin: KAN-817 subject');
      expect(validated.data.bodyPreview).toContain('verbatim');
    }
  });

  it('publisher emits a payload WITHOUT subject/bodyPreview when content is empty — still validates against the schema (rolling-deploy compat)', async () => {
    const event = {
      topic: 'action.send' as const,
      timestamp: new Date().toISOString(),
      connectionId: CONNECTION_ID,
      message: {
        tenantId: TENANT_ID,
        actionId: ACTION_ID,
        decisionId: DECISION_ID,
        contactId: CONTACT_ID,
        recipient: { email: 'fred@mkze.vc' },
        content: { body: '' }, // both subject + body empty
      },
    };
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(event)).toString('base64'),
        messageId: 'pubsub-msg-roundtrip-empty',
      },
    };

    const res = await actionSendPushApp.request('/action-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);

    expect(publishEventMock).toHaveBeenCalledOnce();
    const published = publishEventMock.mock.calls[0]![0];
    const validated = ActionExecutedEventSchema.safeParse(published);
    expect(validated.success).toBe(true);
    if (validated.success) {
      // Both fields should be absent on the published event when content is empty.
      expect(validated.data.subject).toBeUndefined();
      expect(validated.data.bodyPreview).toBeUndefined();
    }
  });
});
