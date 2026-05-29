/**
 * M3-2.5b — Inbound reply correlation + override.
 *
 * Pinned behaviors (the test surface from PRD v2 §3-4):
 *
 *   1. Inbound write extension:
 *      - First-turn ($transaction wraps Deal + DealStageHistory + Engagement
 *        + sidecar + correlation override).
 *      - Multi-turn (newly wrapped in $transaction so Engagement + sidecar
 *        + override are atomic — pre-2.5b was bare prisma).
 *
 *   2. Correlation lookup:
 *      - In-Reply-To present + matches outbound sidecar → Engagement
 *        UPDATE with {decisionId, contactId, dealId} (B-override).
 *      - In-Reply-To present + no outbound match → no override + audit miss
 *        with reason='unmatched_in_reply_to'.
 *      - In-Reply-To absent → no override + audit miss with
 *        reason='no_in_reply_to_header'.
 *      - Cross-tenant rejection — relation-filter tenantId defense-in-depth.
 *
 *   3. The MARQUEE (B): redirect-shadowed rescue.
 *      Outbound TO=A redirected to B → reply From=B with In-Reply-To
 *      matching outbound's provider_message_id → inbound Engagement has
 *      contactId = A AND dealId = A's-Deal (NOT B's).
 *
 *   4. Header normalization integration — bracket+@domain strip.
 *
 *   5. Multi-turn transaction shape — rolls back on sidecar UNIQUE violation.
 *
 * Strategy: mock prisma at the boundary. Mirror M3-2.5a's apps/api outbound
 * substrate test pattern: provide a fake $transaction implementation that
 * passes a typed `tx` to the callback, assert which tx methods were called
 * and with what shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyPubsubOidcMock = vi.fn(async () => true);

vi.mock('../lib/oidc-pubsub-verify.js', () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

interface FakeTx {
  deal: {
    create: ReturnType<typeof vi.fn>;
  };
  dealStageHistory: {
    create: ReturnType<typeof vi.fn>;
  };
  engagement: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  engagementEmailMetadata: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  deal_for_active_lookup: ReturnType<typeof vi.fn>;
}

interface FakePrisma {
  $transaction: ReturnType<typeof vi.fn>;
  contact: { findUnique: ReturnType<typeof vi.fn> };
  deal: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  stage: { findFirst: ReturnType<typeof vi.fn> };
  engagement: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  engagementEmailMetadata: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const FRED_CONTACT = '22222222-2222-2222-2222-222222222222'; // from-address-resolved (redirect recipient)
const TEST_M3_1A_CONTACT = '99999999-9999-9999-9999-999999999999'; // originating outbound TO
const PIPELINE_ID = '33333333-3333-3333-3333-333333333333';
const INITIAL_STAGE_ID = '44444444-4444-4444-4444-444444444444';
const FRED_DEAL_ID = '55555555-5555-5555-5555-555555555555';
const TEST_M3_1A_DEAL_ID = '66666666-6666-6666-6666-666666666666';
const OUTBOUND_ENGAGEMENT_ID = '77777777-7777-7777-7777-777777777777';
const OUTBOUND_DECISION_ID = '88888888-8888-8888-8888-888888888888';
const INBOUND_ENGAGEMENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EVENT_ID = 'evt_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Outbound's stored provider_message_id (M3-2.5a wrote this when the engine dispatched).
const OUTBOUND_PROVIDER_MSG_ID = '4afbb368-4f8c-4a6e-8b88-addb4d60dd69';
// Inbound In-Reply-To wraps the outbound id with brackets + @domain (RFC 5322 wire form).
const INBOUND_IN_REPLY_TO = `<${OUTBOUND_PROVIDER_MSG_ID}@resend.dev>`;
// Inbound's own Message-ID (gmail-shape, kept separate from the outbound id).
const INBOUND_MSG_ID_RAW = '<gmail-msg-cafe-1234@mail.gmail.com>';
const INBOUND_MSG_ID_STRIPPED = 'gmail-msg-cafe-1234';

const prismaMock: FakePrisma = {
  $transaction: vi.fn(),
  contact: { findUnique: vi.fn() },
  deal: { findMany: vi.fn(), findFirst: vi.fn() },
  stage: { findFirst: vi.fn() },
  engagement: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  engagementEmailMetadata: { findFirst: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
};

vi.mock('../prisma.js', () => ({ prisma: prismaMock }));

// Mock the engagement-service module loader (variable-specifier import in
// the consumer). logEngagement returns the inbound Engagement row.
const logEngagementMock = vi.fn(async (_tx: unknown, input: { dealId: string }) => ({
  id: INBOUND_ENGAGEMENT_ID,
  dealId: input.dealId,
}));
vi.mock('../../../../packages/api/src/services/engagement-service.js', () => ({
  logEngagement: logEngagementMock,
}));

// resolve-active-deal mock: returns the originating contact's Deal id (Path B
// override needs this).
const resolveActiveDealMock = vi.fn(async (_p: unknown, _t: string, contactId: string) => {
  if (contactId === TEST_M3_1A_CONTACT) return TEST_M3_1A_DEAL_ID;
  return null;
});
vi.mock('../../../../packages/api/src/services/resolve-active-deal.js', () => ({
  resolveActiveDealForContact: resolveActiveDealMock,
}));

// Lead-normalizer mock — returns a deterministic shape so the consumer's
// metadata writes don't blow up.
vi.mock('../../../../packages/api/src/services/lead-normalizer.js', () => ({
  normalizeInbound: vi.fn(async () => ({
    preParsed: {
      senderEmail: 'fred@axisone.ca',
      firstName: null,
      lastName: null,
      companyName: null,
      phone: null,
      subject: 'Re: discovery',
      bodyText: 'Sure, happy to chat',
    },
    structured: {
      firstName: null,
      lastName: null,
      companyName: null,
      phone: null,
      intentSummary: null,
      qualificationSignals: [],
    },
    extractionConfidence: 'high' as const,
    extractionError: null,
  })),
}));

// Bootstrap + assignment mocks for first-turn path. Specs must match the
// consumer's variable-specifier dynamic imports exactly (otherwise vi.mock
// doesn't intercept the actual `await import(spec)` call).
vi.mock('../../../../packages/api/src/services/default-pipeline-bootstrap.js', () => ({
  ensureTenantHasDefaultPipeline: vi.fn(async () => ({ id: PIPELINE_ID })),
}));
vi.mock('../../../../packages/api/src/services/lead-assignment.js', () => ({
  assignLeadToPipeline: vi.fn(async () => ({
    mode: 'default_pipeline' as const,
    pipelineId: PIPELINE_ID,
    stageId: INITIAL_STAGE_ID,
  })),
}));

// Brain Service Phase 2 wiring — stub to no-op.
vi.mock('../../../../packages/api/src/services/brain-service.js', () => ({
  evaluateDealState: vi.fn(async () => ({})),
}));
vi.mock('../../../../packages/api/src/services/message-shaper.js', () => ({
  composeMessage: vi.fn(),
}));
vi.mock('../../../../packages/api/src/services/send-policy.js', () => ({
  evaluateSendPolicy: vi.fn(async () => ({ type: 'allow' })),
}));
vi.mock('../../../../packages/api/src/services/message-composer.js', () => ({
  publishActionSend: vi.fn(),
  resolveReplyToForTenant: vi.fn(async () => null),
}));

const { leadReceivedPushApp } = await import('../subscribers/lead-received-push.js');

function buildLeadReceivedEvent(overrides: {
  inboundHeaders?: {
    messageId?: string;
    inReplyTo?: string;
    references?: string;
  };
  contactId?: string;
}) {
  return {
    eventId: EVENT_ID,
    eventType: 'lead.received' as const,
    version: '1.0' as const,
    publishedAt: '2026-05-29T15:00:00.000Z',
    tenantId: TENANT,
    contactId: overrides.contactId ?? FRED_CONTACT,
    source: 'email_inbox' as const,
    metadata: {
      fromAddress: 'fred@axisone.ca',
      subject: 'Re: discovery',
      bodyPreview: 'Sure, happy to chat',
      attachmentCount: 0,
      ...(overrides.inboundHeaders ? { inboundHeaders: overrides.inboundHeaders } : {}),
    },
    receivedAt: '2026-05-29T15:00:00.000Z',
  };
}

function buildEnvelope(eventPayload: Record<string, unknown>) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(eventPayload)).toString('base64'),
      messageId: 'msg-1',
    },
    subscription: 'projects/test/subscriptions/lead-received-push',
  };
}

async function postLeadReceived(eventPayload: Record<string, unknown>) {
  return leadReceivedPushApp.request('/lead-received', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEnvelope(eventPayload)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyPubsubOidcMock.mockResolvedValue(true);
  // Default: contact resolves to fred (the from-address-resolved Contact).
  prismaMock.contact.findUnique.mockResolvedValue({ id: FRED_CONTACT, tenantId: TENANT });
  // Default: fred has no open Deals → first-turn path will fire.
  prismaMock.deal.findMany.mockResolvedValue([]);
  // Initial stage lookup
  prismaMock.stage.findFirst.mockResolvedValue({ id: INITIAL_STAGE_ID });
  // Audit log create — silent success
  prismaMock.auditLog.create.mockResolvedValue({ id: 'audit-1' });

  // Reset module-level mocks
  logEngagementMock.mockClear();
  resolveActiveDealMock.mockClear();
  resolveActiveDealMock.mockImplementation(async (_p, _t, contactId: string) => {
    if (contactId === TEST_M3_1A_CONTACT) return TEST_M3_1A_DEAL_ID;
    return null;
  });
});

// Helper: install a $transaction implementation with a typed tx + a couple
// of tx mocks the consumer will call. The tx delegates engagement-create
// through logEngagementMock above; engagementEmailMetadata methods are
// returned for the test to assert on.
function installTransactionMock(opts: {
  matched?: {
    engagement: { id: string; decisionId: string | null; contactId: string };
  } | null;
  sidecarThrows?: Error;
} = {}) {
  const txDealCreate = vi.fn(async (input: { data: { contactId: string } }) => ({
    id: input.data.contactId === FRED_CONTACT ? FRED_DEAL_ID : TEST_M3_1A_DEAL_ID,
  }));
  const txDealStageHistoryCreate = vi.fn(async () => ({}));
  const txEngagementUpdate = vi.fn(async () => ({ id: INBOUND_ENGAGEMENT_ID }));
  const txSidecarCreate = vi.fn(async () => {
    if (opts.sidecarThrows) throw opts.sidecarThrows;
    return { engagementId: INBOUND_ENGAGEMENT_ID };
  });
  const txSidecarFindFirst = vi.fn(async () =>
    opts.matched === undefined
      ? { engagement: { id: OUTBOUND_ENGAGEMENT_ID, decisionId: OUTBOUND_DECISION_ID, contactId: TEST_M3_1A_CONTACT } }
      : opts.matched,
  );

  prismaMock.$transaction.mockImplementation(async (cb: (tx: FakeTx) => Promise<unknown>) => {
    return cb({
      deal: { create: txDealCreate },
      dealStageHistory: { create: txDealStageHistoryCreate },
      engagement: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: INBOUND_ENGAGEMENT_ID })),
        update: txEngagementUpdate,
      },
      engagementEmailMetadata: {
        findFirst: txSidecarFindFirst,
        create: txSidecarCreate,
      },
      deal_for_active_lookup: vi.fn(),
    });
  });

  return { txDealCreate, txDealStageHistoryCreate, txEngagementUpdate, txSidecarCreate, txSidecarFindFirst };
}

// ─────────────────────────────────────────────────────────────────────────
// Marquee (B) test — redirect-shadowed rescue
// ─────────────────────────────────────────────────────────────────────────

describe('M3-2.5b — MARQUEE redirect-shadowed rescue (B-override: both contactId AND dealId)', () => {
  it('inbound from fred (redirect recipient) with In-Reply-To matching test-m3-1a outbound → Engagement.{contactId, dealId} BOTH flip to test-m3-1a', async () => {
    const { txEngagementUpdate, txSidecarCreate, txSidecarFindFirst } = installTransactionMock();

    const res = await postLeadReceived(
      buildLeadReceivedEvent({
        inboundHeaders: {
          messageId: INBOUND_MSG_ID_RAW,
          inReplyTo: INBOUND_IN_REPLY_TO,
          references: INBOUND_IN_REPLY_TO,
        },
      }),
    );
    expect(res.status).toBe(200);

    // Lookup fired with stripped In-Reply-To
    expect(txSidecarFindFirst).toHaveBeenCalledTimes(1);
    const lookupTuple = txSidecarFindFirst.mock.calls[0] as unknown as [
      { where: { provider: string; providerMessageId: string; engagement: { tenantId: string } } },
    ];
    const lookupArgs = lookupTuple[0];
    expect(lookupArgs.where.provider).toBe('resend');
    expect(lookupArgs.where.providerMessageId).toBe(OUTBOUND_PROVIDER_MSG_ID); // stripped of <> and @domain
    expect(lookupArgs.where.engagement.tenantId).toBe(TENANT); // defense-in-depth tenant scope

    // B-OVERRIDE: Engagement.update called with BOTH decisionId, contactId, dealId
    expect(txEngagementUpdate).toHaveBeenCalledTimes(1);
    const updateTuple = txEngagementUpdate.mock.calls[0] as unknown as [
      { data: { decisionId: string; contactId: string; dealId?: string } },
    ];
    const updateArgs = updateTuple[0];
    expect(updateArgs.data.decisionId).toBe(OUTBOUND_DECISION_ID);
    expect(updateArgs.data.contactId).toBe(TEST_M3_1A_CONTACT); // ✅ rescued
    expect(updateArgs.data.dealId).toBe(TEST_M3_1A_DEAL_ID);    // ✅ rescued (B-override)

    // resolveActiveDealForContact was called for the originating contact
    expect(resolveActiveDealMock).toHaveBeenCalledTimes(1);
    expect(resolveActiveDealMock.mock.calls[0]![1]).toBe(TENANT);
    expect(resolveActiveDealMock.mock.calls[0]![2]).toBe(TEST_M3_1A_CONTACT);

    // Inbound sidecar was written — own bracket-stripped Message-ID + raw In-Reply-To
    expect(txSidecarCreate).toHaveBeenCalledTimes(1);
    const sidecarTuple = txSidecarCreate.mock.calls[0] as unknown as [
      { data: { engagementId: string; provider: string; providerMessageId: string; inReplyTo?: string; referencesArray: string[] } },
    ];
    const sidecarArgs = sidecarTuple[0];
    expect(sidecarArgs.data.provider).toBe('resend');
    expect(sidecarArgs.data.providerMessageId).toBe(INBOUND_MSG_ID_STRIPPED);
    expect(sidecarArgs.data.inReplyTo).toBe(INBOUND_IN_REPLY_TO); // RAW for forensic
    expect(sidecarArgs.data.referencesArray).toEqual([OUTBOUND_PROVIDER_MSG_ID]); // parsed + stripped

    // Audit-log: inbound_correlated fires with matched IDs
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    const auditArgs = prismaMock.auditLog.create.mock.calls[0]![0] as unknown as {
      data: { actionType: string; reasoning: string; payload: Record<string, unknown> };
    };
    expect(auditArgs.data.actionType).toBe('lead_inbox.inbound_correlated');
    expect(auditArgs.data.reasoning).toBe('inbound_correlated');
    expect(auditArgs.data.payload.matchedDecisionId).toBe(OUTBOUND_DECISION_ID);
    expect(auditArgs.data.payload.matchedContactId).toBe(TEST_M3_1A_CONTACT);
    expect(auditArgs.data.payload.matchedDealId).toBe(TEST_M3_1A_DEAL_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// First-turn substrate — $transaction shape pin
// ─────────────────────────────────────────────────────────────────────────

describe('M3-2.5b — first-turn substrate: sidecar + correlation inside Deal+History tx', () => {
  it('no inboundHeaders on event → sidecar SKIPPED, correlation lookup SKIPPED, audit miss with reason=no_in_reply_to_header', async () => {
    const { txEngagementUpdate, txSidecarCreate, txSidecarFindFirst } = installTransactionMock();

    const res = await postLeadReceived(buildLeadReceivedEvent({}));
    expect(res.status).toBe(200);

    expect(txSidecarCreate).not.toHaveBeenCalled();
    expect(txSidecarFindFirst).not.toHaveBeenCalled();
    expect(txEngagementUpdate).not.toHaveBeenCalled();

    // Audit miss with no_in_reply_to_header
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    const auditArgs = prismaMock.auditLog.create.mock.calls[0]![0] as unknown as {
      data: { actionType: string; reasoning: string };
    };
    expect(auditArgs.data.actionType).toBe('lead_inbox.inbound_correlation_miss');
    expect(auditArgs.data.reasoning).toBe('no_in_reply_to_header');
  });

  it('inboundHeaders.inReplyTo present but no match → audit miss with reason=unmatched_in_reply_to + sidecar still written', async () => {
    const { txEngagementUpdate, txSidecarCreate } = installTransactionMock({ matched: null });

    const res = await postLeadReceived(
      buildLeadReceivedEvent({
        inboundHeaders: {
          messageId: INBOUND_MSG_ID_RAW,
          inReplyTo: '<orphan@d>',
          references: '<orphan@d>',
        },
      }),
    );
    expect(res.status).toBe(200);

    // Sidecar STILL written (forensic record even when correlation fails)
    expect(txSidecarCreate).toHaveBeenCalledTimes(1);
    // Engagement.update NOT called (no match → no override)
    expect(txEngagementUpdate).not.toHaveBeenCalled();

    const auditArgs = prismaMock.auditLog.create.mock.calls[0]![0] as unknown as {
      data: { actionType: string; reasoning: string };
    };
    expect(auditArgs.data.actionType).toBe('lead_inbox.inbound_correlation_miss');
    expect(auditArgs.data.reasoning).toBe('unmatched_in_reply_to');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Multi-turn substrate — newly wrapped in $transaction (was bare prisma)
// ─────────────────────────────────────────────────────────────────────────

describe('M3-2.5b — multi-turn substrate: $transaction wrapping (was bare prisma pre-2.5b)', () => {
  it('contact has open Deal → multi-turn path wraps Engagement + sidecar + override in single $transaction', async () => {
    // Multi-turn precondition: fred has an existing open Deal
    prismaMock.deal.findMany.mockResolvedValue([
      {
        id: FRED_DEAL_ID,
        tenantId: TENANT,
        contactId: FRED_CONTACT,
        currentStage: { id: INITIAL_STAGE_ID, name: 'New', outcomeType: 'open' },
        createdAt: new Date(),
      },
    ]);

    const { txEngagementUpdate, txSidecarCreate } = installTransactionMock();

    const res = await postLeadReceived(
      buildLeadReceivedEvent({
        inboundHeaders: {
          messageId: INBOUND_MSG_ID_RAW,
          inReplyTo: INBOUND_IN_REPLY_TO,
        },
      }),
    );
    expect(res.status).toBe(200);

    // Single $transaction wraps everything on multi-turn path now
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txSidecarCreate).toHaveBeenCalledTimes(1);
    expect(txEngagementUpdate).toHaveBeenCalledTimes(1); // B-override fired on match
  });

  it('multi-turn: sidecar UNIQUE violation propagates → $transaction rolls back, handler returns 200 idempotent dedup, audit NOT emitted', async () => {
    prismaMock.deal.findMany.mockResolvedValue([
      {
        id: FRED_DEAL_ID,
        tenantId: TENANT,
        contactId: FRED_CONTACT,
        currentStage: { id: INITIAL_STAGE_ID, name: 'New', outcomeType: 'open' },
        createdAt: new Date(),
      },
    ]);

    const p2002 = new Error('Unique constraint failed') as Error & { code: string };
    p2002.code = 'P2002';
    installTransactionMock({ sidecarThrows: p2002 });

    const res = await postLeadReceived(
      buildLeadReceivedEvent({
        inboundHeaders: {
          messageId: INBOUND_MSG_ID_RAW,
          inReplyTo: INBOUND_IN_REPLY_TO,
        },
      }),
    );
    // Handler's existing isUniqueConstraintViolation catch at L597 maps P2002
    // to 200 idempotent-redelivery — the throw propagated up from the
    // $transaction (so rollback IS atomic, including the engagement create),
    // but the handler dedups rather than nacking. Audit NOT emitted (throw
    // bypassed emitCorrelationAudit which runs post-tx).
    expect(res.status).toBe(200);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-tenant rejection — defense-in-depth on the tenant relation filter
// ─────────────────────────────────────────────────────────────────────────

describe('M3-2.5b — cross-tenant rejection (defense-in-depth)', () => {
  it('lookup query filters engagement.tenantId — relation filter explicitly present in where clause', async () => {
    const { txSidecarFindFirst } = installTransactionMock();

    await postLeadReceived(
      buildLeadReceivedEvent({
        inboundHeaders: {
          messageId: INBOUND_MSG_ID_RAW,
          inReplyTo: INBOUND_IN_REPLY_TO,
        },
      }),
    );

    expect(txSidecarFindFirst).toHaveBeenCalled();
    const ctTuple = txSidecarFindFirst.mock.calls[0] as unknown as [
      { where: { engagement: { tenantId: string } } },
    ];
    const where = ctTuple[0].where;
    expect(where.engagement.tenantId).toBe(TENANT);
  });
});
