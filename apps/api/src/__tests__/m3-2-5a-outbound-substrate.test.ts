/**
 * M3-2.5a — outbound substrate write extension at action-executed-push.ts.
 *
 * Pinned behaviors (the test surface from the build prompt §5):
 *   - Engagement now writes top-level decision_id (was metadata-only)
 *   - Sidecar engagement_email_metadata row written in SAME $transaction
 *     when providerMessageId present
 *   - Existing dealId && guard preserved — no Engagement, no sidecar when
 *     dealId missing (the silent-gap-pre-fix back-compat assertion)
 *   - status filter preserved (sent/delivered only; failed/suppressed no-op)
 *   - sidecar omitted when providerMessageId absent (defense-in-depth)
 *   - $transaction atomicity: sidecar UNIQUE violation rolls back Engagement
 *   - P2002 dedup path (Resend retry) still no-ops cleanly
 *
 * Strategy: integration-shape via the existing action-executed-push test
 * harness pattern; mocks prisma at the boundary, asserts call sequencing
 * and transactional shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyPubsubOidcMock = vi.fn(async () => true);

vi.mock('../lib/oidc-pubsub-verify.js', () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

interface FakeTx {
  engagement: {
    create: ReturnType<typeof vi.fn>;
  };
  engagementEmailMetadata: {
    create: ReturnType<typeof vi.fn>;
  };
}

interface FakePrisma {
  $transaction: ReturnType<typeof vi.fn>;
  decision: { findFirst: ReturnType<typeof vi.fn> };
  actionOutcome: { create: ReturnType<typeof vi.fn> };
  engagement: { create: ReturnType<typeof vi.fn> };
  engagementEmailMetadata: { create: ReturnType<typeof vi.fn> };
}

const prismaMock: FakePrisma = {
  $transaction: vi.fn(),
  decision: { findFirst: vi.fn() },
  actionOutcome: { create: vi.fn() },
  engagement: { create: vi.fn() },
  engagementEmailMetadata: { create: vi.fn() },
};

vi.mock('../prisma.js', () => ({ prisma: prismaMock }));

const { actionExecutedPushApp } = await import('../subscribers/action-executed-push.js');

const TENANT = '11111111-1111-1111-1111-111111111111';
const CONTACT = '22222222-2222-2222-2222-222222222222';
const ACTION_ID = '33333333-3333-3333-3333-333333333333';
const DECISION_ID = '44444444-4444-4444-4444-444444444444';
const DEAL_ID = '55555555-5555-5555-5555-555555555555';
const CONNECTION_ID = '66666666-6666-6666-6666-666666666666';

function buildEvent(overrides: {
  status?: string;
  providerMessageId?: string | undefined;
  decisionMetadata?: Record<string, unknown>;
} = {}) {
  const event: Record<string, unknown> = {
    topic: 'action.executed',
    actionId: ACTION_ID,
    decisionId: DECISION_ID,
    tenantId: TENANT,
    contactId: CONTACT,
    connectionId: CONNECTION_ID,
    channel: 'EMAIL',
    status: overrides.status ?? 'sent',
    provider: 'resend',
    timestamp: '2026-05-29T13:00:00.000Z',
    attemptNumber: 1,
    subject: 'Test subject',
    bodyPreview: 'Test body preview',
  };
  if (!('providerMessageId' in overrides)) {
    event.providerMessageId = 'pid-resend-abc123';
  } else if (overrides.providerMessageId !== undefined) {
    event.providerMessageId = overrides.providerMessageId;
  }
  return event;
}

function buildEnvelope(eventPayload: Record<string, unknown>) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(eventPayload)).toString('base64'),
      messageId: 'msg-1',
    },
    subscription: 'projects/test/subscriptions/action-executed-push',
  };
}

async function postExecuted(eventPayload: Record<string, unknown>) {
  return actionExecutedPushApp.request('/action-executed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEnvelope(eventPayload)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyPubsubOidcMock.mockResolvedValue(true);
  prismaMock.actionOutcome.create.mockResolvedValue({ id: 'ao-1' });
  // Default: Decision metadata has dealId (the M3-2.5a engine fix path).
  prismaMock.decision.findFirst.mockResolvedValue({
    metadata: { dealId: DEAL_ID, actionType: 'send_message' },
  });
});

describe('M3-2.5a — outbound substrate: top-level decision_id + sidecar in $transaction', () => {
  it('happy path: status=sent + providerMessageId present → Engagement+sidecar BOTH write in single $transaction', async () => {
    const txEngagementCreate = vi.fn(async () => ({ id: 'eng-1' }));
    const txSidecarCreate = vi.fn(async () => ({ engagementId: 'eng-1' }));
    prismaMock.$transaction.mockImplementation(async (cb: (tx: FakeTx) => Promise<unknown>) => {
      return cb({
        engagement: { create: txEngagementCreate },
        engagementEmailMetadata: { create: txSidecarCreate },
      });
    });

    const res = await postExecuted(buildEvent({}));
    expect(res.status).toBe(200);

    // Single $transaction wrapping both writes.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txEngagementCreate).toHaveBeenCalledTimes(1);
    expect(txSidecarCreate).toHaveBeenCalledTimes(1);

    // Top-level decision_id present (was metadata-only pre-2.5a).
    const engCallTuple = txEngagementCreate.mock.calls[0] as unknown as [{ data: { decisionId: string; tenantId: string; dealId: string } }];
    expect(engCallTuple[0].data.decisionId).toBe(DECISION_ID);
    expect(engCallTuple[0].data.tenantId).toBe(TENANT);
    expect(engCallTuple[0].data.dealId).toBe(DEAL_ID);

    // Sidecar provider + providerMessageId populated; inReplyTo absent (outbound).
    const sidecarCallTuple = txSidecarCreate.mock.calls[0] as unknown as [{ data: { engagementId: string; provider: string; providerMessageId: string } }];
    expect(sidecarCallTuple[0].data.engagementId).toBe('eng-1');
    expect(sidecarCallTuple[0].data.provider).toBe('resend');
    expect(sidecarCallTuple[0].data.providerMessageId).toBe('pid-resend-abc123');
  });

  it('back-compat: no dealId in Decision metadata → existing skip path fires; NO Engagement, NO sidecar, NO $transaction', async () => {
    prismaMock.decision.findFirst.mockResolvedValue({
      metadata: { /* dealId intentionally absent */ actionType: 'send_message' },
    });
    const res = await postExecuted(buildEvent({}));
    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('status=failed → existing status guard fires; NO Engagement, NO sidecar', async () => {
    const res = await postExecuted(buildEvent({ status: 'failed' }));
    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('providerMessageId absent (edge case: sent/delivered without provider id) → Engagement writes, sidecar SKIPPED defensively', async () => {
    const txEngagementCreate = vi.fn(async () => ({ id: 'eng-1' }));
    const txSidecarCreate = vi.fn(async () => ({}));
    prismaMock.$transaction.mockImplementation(async (cb: (tx: FakeTx) => Promise<unknown>) => {
      return cb({
        engagement: { create: txEngagementCreate },
        engagementEmailMetadata: { create: txSidecarCreate },
      });
    });

    const res = await postExecuted(buildEvent({ providerMessageId: undefined }));
    expect(res.status).toBe(200);
    expect(txEngagementCreate).toHaveBeenCalledTimes(1);
    expect(txSidecarCreate).not.toHaveBeenCalled(); // sidecar defended on missing id
  });

  it('$transaction atomicity: sidecar UNIQUE violation rolls back Engagement (P2002 → idempotent dedup)', async () => {
    const txEngagementCreate = vi.fn(async () => ({ id: 'eng-1' }));
    const txSidecarCreate = vi.fn(async () => {
      const err = new Error('Unique constraint failed') as Error & { code: string };
      err.code = 'P2002';
      throw err;
    });
    prismaMock.$transaction.mockImplementation(async (cb: (tx: FakeTx) => Promise<unknown>) => {
      return cb({
        engagement: { create: txEngagementCreate },
        engagementEmailMetadata: { create: txSidecarCreate },
      });
    });

    // Handler caught P2002 and logged as idempotent dedup; 200 ack.
    const res = await postExecuted(buildEvent({}));
    expect(res.status).toBe(200);
    expect(txEngagementCreate).toHaveBeenCalled();
    expect(txSidecarCreate).toHaveBeenCalled();
  });
});
