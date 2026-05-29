/**
 * KAN-816 — Outbound Engagement gap fix + Reply-To wiring tests.
 *
 * Sprint 9 close-gate for multi-turn customer-reply support. Three fix
 * areas tested:
 *
 *   1. action-executed-push handler integration — outbound Engagement
 *      write co-located with ActionOutcome (Tests 1-8)
 *   2. publishActionSend Reply-To propagation (Tests 9-10)
 *   3. resolveReplyToForTenant helper (Tests 11-13)
 *
 * Resend adapter tag changes (contact_id + decision_id added) are
 * structurally verified by the existing webhook test
 * (`apps/connectors/src/webhooks/__tests__/resend.test.ts`) which already
 * sends all 5 correlation tags through `publishExecuted`. The end-to-end
 * adapter behavior is gated by the production multi-turn smoke that
 * follows this PR's merge.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyPubsubOidcMock = vi.fn();
const decisionFindFirstMock = vi.fn();
const actionOutcomeCreateMock = vi.fn();
const engagementCreateMock = vi.fn();
const engagementEmailMetadataCreateMock = vi.fn();
const tenantFindUniqueMock = vi.fn();
const pubsubPublishMock = vi.fn();

vi.mock('../lib/oidc-pubsub-verify.js', () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

// M3-2.5a: handler now wraps Engagement+sidecar in prisma.$transaction.
// The $transaction mock delegates tx.engagement.create back to the existing
// engagementCreateMock so all the historical assertions stay valid; the new
// sidecar create is captured separately for shape-only assertions.
vi.mock('../prisma.js', () => ({
  prisma: {
    decision: { findFirst: decisionFindFirstMock },
    actionOutcome: { create: actionOutcomeCreateMock },
    engagement: { create: engagementCreateMock },
    engagementEmailMetadata: { create: engagementEmailMetadataCreateMock },
    tenant: { findUnique: tenantFindUniqueMock },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        engagement: { create: engagementCreateMock },
        engagementEmailMetadata: { create: engagementEmailMetadataCreateMock },
      }),
    ),
  },
}));

const { actionExecutedPushApp } = await import('../subscribers/action-executed-push.js');

const TENANT_ID = '9ca85088-f65b-4bac-b098-fff742281ede';
const DECISION_ID = 'decision_brain_v1_test';
const CONTACT_ID = '11111111-aaaa-bbbb-cccc-222222222222';
const CONNECTION_ID = '35ad29cd-9c96-4a05-8b90-ec3376936d1d';
const ACTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEAL_ID = 'deal_phase_2_test';

function buildActionExecutedEvent(overrides: Record<string, unknown> = {}) {
  return {
    topic: 'action.executed',
    timestamp: new Date().toISOString(),
    tenantId: TENANT_ID,
    actionId: ACTION_ID,
    decisionId: DECISION_ID,
    contactId: CONTACT_ID,
    connectionId: CONNECTION_ID,
    channel: 'EMAIL',
    provider: 'resend',
    status: 'sent',
    providerMessageId: 'resend_msg_id_xyz',
    attemptNumber: 1,
    ...overrides,
  };
}

function buildPushEnvelope(eventOverrides: Record<string, unknown> = {}) {
  const event = buildActionExecutedEvent(eventOverrides);
  return {
    message: {
      data: Buffer.from(JSON.stringify(event)).toString('base64'),
      messageId: 'msg_test_action_executed',
    },
  };
}

async function postEnvelope(envelope: unknown) {
  return actionExecutedPushApp.request('/action-executed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

beforeEach(() => {
  verifyPubsubOidcMock.mockReset();
  verifyPubsubOidcMock.mockResolvedValue(true); // OIDC always passes in these tests
  decisionFindFirstMock.mockReset();
  actionOutcomeCreateMock.mockReset();
  actionOutcomeCreateMock.mockResolvedValue({ id: 'outcome_id_a' });
  engagementCreateMock.mockReset();
  engagementCreateMock.mockResolvedValue({ id: 'engagement_id_a' });
  engagementEmailMetadataCreateMock.mockReset();
  engagementEmailMetadataCreateMock.mockResolvedValue({ engagementId: 'engagement_id_a' });
  tenantFindUniqueMock.mockReset();
  pubsubPublishMock.mockReset();
});

// ─────────────────────────────────────────────
// Test 1 — happy path: Engagement written alongside ActionOutcome
// ─────────────────────────────────────────────

describe('KAN-816 — outbound Engagement write co-located with ActionOutcome', () => {
  it('status=sent + valid Decision metadata.dealId → both ActionOutcome AND Engagement written', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({
      id: DECISION_ID,
      metadata: { dealId: DEAL_ID, brainEvaluatedAt: '2026-05-03T23:39:51.879Z' },
    });

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(actionOutcomeCreateMock).toHaveBeenCalledOnce();
    expect(engagementCreateMock).toHaveBeenCalledOnce();
  });

  // ── Test 2 — Engagement shape
  it('Engagement shape: engagementType=email_send, signal_class=neutral, channel=email, dealId linked', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });
    await postEnvelope(buildPushEnvelope());

    const args = (engagementCreateMock.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(args.engagementType).toBe('email_send');
    expect(args.signalClass).toBe('neutral');
    expect(args.channel).toBe('email');
    expect(args.dealId).toBe(DEAL_ID);
    expect(args.contactId).toBe(CONTACT_ID);
    expect(args.tenantId).toBe(TENANT_ID);
    expect(args.correlationId).toBe(`engagement:outbound:${ACTION_ID}`);
  });

  // ── Test 3 — Metadata captures Brain/dispatch context
  it('Engagement.metadata contains actionId + decisionId + status + provider for anti-repetition consumer', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });
    await postEnvelope(buildPushEnvelope());

    const args = (engagementCreateMock.mock.calls[0]![0] as { data: { metadata: Record<string, unknown> } }).data;
    expect(args.metadata).toMatchObject({
      actionId: ACTION_ID,
      decisionId: DECISION_ID,
      status: 'sent',
      provider: 'resend',
      providerMessageId: 'resend_msg_id_xyz',
    });
  });

  // ── Test 4 — Idempotency on Resend retry (P2002 dedup)
  it('duplicate webhook (P2002 unique violation on correlationId) → ActionOutcome still written, Engagement deduped silently', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });
    const p2002 = Object.assign(new Error('Unique constraint failed on correlationId'), {
      code: 'P2002',
    });
    engagementCreateMock.mockRejectedValueOnce(p2002);

    const res = await postEnvelope(buildPushEnvelope());

    // Response stays 200 — duplicate is idempotent success, not a failure.
    expect(res.status).toBe(200);
    expect(actionOutcomeCreateMock).toHaveBeenCalledOnce(); // ActionOutcome still wrote (no idempotency anchor on it today)
    expect(engagementCreateMock).toHaveBeenCalledOnce(); // Engagement attempted; threw P2002 (handled gracefully)
  });

  // ── Test 5 — Missing dealId → ActionOutcome writes, Engagement skipped + warn
  it('Decision metadata has no dealId → ActionOutcome writes; Engagement skipped (legacy KAN-660 path)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    decisionFindFirstMock.mockResolvedValueOnce({
      id: DECISION_ID,
      metadata: { other: 'field', no_deal_id_here: true },
    });

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(actionOutcomeCreateMock).toHaveBeenCalledOnce();
    expect(engagementCreateMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0] as string).toContain('no-deal-id-in-decision-metadata');
    warnSpy.mockRestore();
  });

  // ── KAN-817: subject + bodyPreview round-trip into Engagement.metadata
  it('KAN-817 — event.subject + event.bodyPreview → Engagement.metadata.subject + .bodyPreview', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });
    const subject = 'Quick question about pricing';
    const bodyPreview = 'Hi Alice — saw your reply yesterday. Curious what caught your eye?';

    await postEnvelope(buildPushEnvelope({ subject, bodyPreview }));

    const args = (engagementCreateMock.mock.calls[0]![0] as { data: { metadata: Record<string, unknown> } }).data;
    expect(args.metadata.subject).toBe(subject);
    expect(args.metadata.bodyPreview).toBe(bodyPreview);
    // Existing keys MUST still be present — merge, not replace.
    expect(args.metadata).toMatchObject({
      actionId: ACTION_ID,
      decisionId: DECISION_ID,
      status: 'sent',
      channel: 'EMAIL',
      provider: 'resend',
      providerMessageId: 'resend_msg_id_xyz',
    });
  });

  // ── KAN-817: when event omits subject/bodyPreview, Engagement.metadata also omits
  it('KAN-817 — event without subject/bodyPreview → Engagement.metadata has neither key (no empty-string clobber)', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });

    await postEnvelope(buildPushEnvelope()); // base event has no subject/bodyPreview

    const args = (engagementCreateMock.mock.calls[0]![0] as { data: { metadata: Record<string, unknown> } }).data;
    expect('subject' in args.metadata).toBe(false);
    expect('bodyPreview' in args.metadata).toBe(false);
    // Still has the canonical KAN-816 keys
    expect(args.metadata).toMatchObject({ actionId: ACTION_ID, decisionId: DECISION_ID });
  });

  // ── KAN-817: only one of the two populated → only that one persisted
  it('KAN-817 — event with subject only (webhook-side fallback case) → metadata.subject set, no bodyPreview', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });

    await postEnvelope(buildPushEnvelope({ subject: 'Subject only' }));

    const args = (engagementCreateMock.mock.calls[0]![0] as { data: { metadata: Record<string, unknown> } }).data;
    expect(args.metadata.subject).toBe('Subject only');
    expect('bodyPreview' in args.metadata).toBe(false);
  });

  // ── Test 6 — status=failed → no Engagement (anti-repetition excludes failures)
  it('status=failed → ActionOutcome writes; Engagement NOT written (anti-repetition skips non-delivered)', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });

    const res = await postEnvelope(buildPushEnvelope({ status: 'failed', errorClass: 'permanent', errorMessage: 'bounced' }));

    expect(res.status).toBe(200);
    expect(actionOutcomeCreateMock).toHaveBeenCalledOnce();
    expect(engagementCreateMock).not.toHaveBeenCalled();
  });

  // ── Test 7 — status=suppressed → no Engagement
  it('status=suppressed → ActionOutcome writes; Engagement NOT written', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });

    const res = await postEnvelope(buildPushEnvelope({ status: 'suppressed' }));

    expect(res.status).toBe(200);
    expect(actionOutcomeCreateMock).toHaveBeenCalledOnce();
    expect(engagementCreateMock).not.toHaveBeenCalled();
  });

  // ── Test 8 — status=delivered → Engagement written (multi-status retry coverage)
  it('status=delivered → Engagement written (covers Resend multi-status fanout: sent → delivered)', async () => {
    decisionFindFirstMock.mockResolvedValueOnce({ id: DECISION_ID, metadata: { dealId: DEAL_ID } });

    const res = await postEnvelope(buildPushEnvelope({ status: 'delivered' }));

    expect(res.status).toBe(200);
    expect(engagementCreateMock).toHaveBeenCalledOnce();
    const args = (engagementCreateMock.mock.calls[0]![0] as { data: { metadata: Record<string, unknown> } }).data;
    expect(args.metadata.status).toBe('delivered');
  });
});

// ─────────────────────────────────────────────
// Tests 9-13 — publishActionSend Reply-To propagation + resolveReplyToForTenant
// ─────────────────────────────────────────────

// These tests import the message-composer module fresh (without the prisma
// mock above) to test the lookup helper + publish input plumbing in isolation.

vi.mock('../../../../packages/api/src/services/action-decided-publisher.js', () => ({}));

describe('KAN-816 — publishActionSend Reply-To propagation', () => {
  let publishActionSend: typeof import('../../../../packages/api/src/services/message-composer.js').publishActionSend;
  let resolveReplyToForTenant: typeof import('../../../../packages/api/src/services/message-composer.js').resolveReplyToForTenant;

  beforeEach(async () => {
    const mod = await import('../../../../packages/api/src/services/message-composer.js');
    publishActionSend = mod.publishActionSend;
    resolveReplyToForTenant = mod.resolveReplyToForTenant;
  });

  // ── Test 9 — input.replyTo populates event.message.replyTo
  it('publishActionSend with input.replyTo → event.message.replyTo populated', async () => {
    const publishedEvents: unknown[] = [];
    const fakeClient = {
      publish: vi.fn(async (_topic: string, data: Buffer) => {
        publishedEvents.push(JSON.parse(data.toString('utf8')));
        return 'pubsub_msg_id_999';
      }),
    };

    await publishActionSend(fakeClient as never, {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      decisionId: DECISION_ID,
      toEmail: 'fred@mkze.vc',
      composed: { subject: 'Test', body: 'Body', unsubscribeUrl: 'https://example.invalid/u/1' },
      connectionId: CONNECTION_ID,
      replyTo: 'c03065f6@leads.axisone.ca',
    });

    expect(publishedEvents).toHaveLength(1);
    const event = publishedEvents[0] as { message: { replyTo?: string } };
    expect(event.message.replyTo).toBe('c03065f6@leads.axisone.ca');
  });

  // ── Test 10 — no replyTo → event.message has no replyTo (regression for legacy callers)
  it('publishActionSend without input.replyTo → event.message has no replyTo field (legacy regression)', async () => {
    const publishedEvents: unknown[] = [];
    const fakeClient = {
      publish: vi.fn(async (_topic: string, data: Buffer) => {
        publishedEvents.push(JSON.parse(data.toString('utf8')));
        return 'pubsub_msg_id_999';
      }),
    };

    await publishActionSend(fakeClient as never, {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      decisionId: DECISION_ID,
      toEmail: 'fred@mkze.vc',
      composed: { subject: 'Test', body: 'Body', unsubscribeUrl: 'https://example.invalid/u/1' },
      connectionId: CONNECTION_ID,
      // no replyTo
    });

    expect(publishedEvents).toHaveLength(1);
    const event = publishedEvents[0] as { message: Record<string, unknown> };
    expect('replyTo' in event.message).toBe(false);
  });
});

describe('KAN-816 — resolveReplyToForTenant helper', () => {
  let resolveReplyToForTenant: typeof import('../../../../packages/api/src/services/message-composer.js').resolveReplyToForTenant;

  beforeEach(async () => {
    const mod = await import('../../../../packages/api/src/services/message-composer.js');
    resolveReplyToForTenant = mod.resolveReplyToForTenant;
  });

  // ── Test 11 — happy path: tenant.inboxSlug populated → returns <slug>@<LEAD_INBOX_DOMAIN>
  it('valid tenant.inboxSlug → returns <slug>@leads.<LEAD_INBOX_DOMAIN>', async () => {
    const fakePrisma = {
      tenant: {
        findUnique: vi.fn(async () => ({ inboxSlug: 'c03065f6' })),
      },
    };
    process.env.LEAD_INBOX_DOMAIN = 'leads.axisone.ca';
    const result = await resolveReplyToForTenant(fakePrisma as never, TENANT_ID);
    expect(result).toBe('c03065f6@leads.axisone.ca');
  });

  // ── Test 12 — null inboxSlug → returns null + warn log
  it('tenant.inboxSlug is null → returns null + warn log emitted', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakePrisma = {
      tenant: {
        findUnique: vi.fn(async () => ({ inboxSlug: null })),
      },
    };
    const result = await resolveReplyToForTenant(fakePrisma as never, TENANT_ID);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0] as string).toContain('no inboxSlug');
    warnSpy.mockRestore();
  });

  // ── Test 13 — tenant not found → returns null + warn
  it('tenant not found → returns null + warn log', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakePrisma = {
      tenant: {
        findUnique: vi.fn(async () => null),
      },
    };
    const result = await resolveReplyToForTenant(fakePrisma as never, 'nonexistent-tenant-id');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  // ── Test 14 — LEAD_INBOX_DOMAIN env-var fallback
  it('LEAD_INBOX_DOMAIN unset → falls back to leads.axisone.app default', async () => {
    delete process.env.LEAD_INBOX_DOMAIN;
    const fakePrisma = {
      tenant: {
        findUnique: vi.fn(async () => ({ inboxSlug: 'c03065f6' })),
      },
    };
    const result = await resolveReplyToForTenant(fakePrisma as never, TENANT_ID);
    expect(result).toBe('c03065f6@leads.axisone.app');
  });
});
