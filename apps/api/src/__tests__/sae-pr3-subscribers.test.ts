/**
 * KAN-1007 — SAE PR3 subscriber tests.
 *
 * Covers both push subscribers added in PR3:
 *   - /pubsub/campaign-materialize (durable replacement for KAN-1002
 *     in-process worker; folds KAN-1003)
 *   - /pubsub/decision-run (DORMANT consumer with 3 hard guards)
 *
 * # The decision.run guard tests are the safety surface
 *
 * The PO brief calls out decision.run's guard rejection as the "safety
 * proof" — even if a decision.run event is published (PR5 territory, not
 * PR3), the consumer must refuse to evaluate the contact unless ALL
 * three conditions hold. Tests below pin each guard's behavior
 * individually so a future refactor that loosens one condition fails
 * specifically + visibly.
 *
 * Mocking strategy:
 *   - verifyPubsubOidc → mocked true/false
 *   - prisma → in-test stub with findFirst on campaign + contactObjectiveStack
 *   - runDecisionForContact → vi.fn() to assert was/wasn't called
 *   - materializeAudienceSnapshot → vi.fn() to assert was/wasn't called
 *
 * The dynamic-import pattern in the subscribers resolves to the same
 * literal paths vi.mock declares below; vitest's module-resolution match
 * makes the mocks effective.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyPubsubOidcMock = vi.fn();
const runDecisionForContactMock = vi.fn();
const materializeAudienceSnapshotMock = vi.fn();

const campaignFindFirstMock = vi.fn();
const stackFindFirstMock = vi.fn();
// KAN-1009 SAE PR4 — PR3's "ALL GUARDS PASS" test path now ALSO traverses
// PR4's cost-cap + dedup gates. Mocks here keep PR3 behavior intact: the
// PR4 gates pass through (no tenant cap, zero spend, very old
// lastEvaluatedAt) so the downstream runDecisionForContact assertions
// remain the load-bearing PR3 check.
const stackUpdateMock = vi.fn();
const tenantFindUniqueMock = vi.fn().mockResolvedValue({ dailyLlmCostCapUsd: null });
const redisGetMock = vi.fn().mockResolvedValue('0');
const redisIncrbyMock = vi.fn().mockResolvedValue(10_000);
const redisExpireMock = vi.fn().mockResolvedValue(1);

vi.mock('../lib/oidc-pubsub-verify.js', () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

vi.mock('../prisma.js', () => ({
  prisma: {
    campaign: { findFirst: campaignFindFirstMock },
    contactObjectiveStack: {
      findFirst: stackFindFirstMock,
      update: stackUpdateMock,
    },
    tenant: { findUnique: tenantFindUniqueMock },
  },
}));

vi.mock('../services/redis-client.js', () => ({
  getRedisClient: () => ({
    get: redisGetMock,
    incrby: redisIncrbyMock,
    expire: redisExpireMock,
  }),
}));

vi.mock('../../../../packages/api/src/services/run-decision-for-contact.js', () => ({
  runDecisionForContact: runDecisionForContactMock,
}));

vi.mock('../../../../packages/api/src/services/campaign-commit.js', () => ({
  materializeAudienceSnapshot: materializeAudienceSnapshotMock,
}));

const { campaignMaterializePushApp } = await import(
  '../subscribers/campaign-materialize-push.js'
);
const { decisionRunPushApp, evaluateDecisionRunGuards } = await import(
  '../subscribers/decision-run-push.js'
);

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const CONTACT_A = '22222222-2222-2222-2222-222222222222';
const CAMPAIGN_A = '33333333-3333-3333-3333-333333333333';
const STACK_A = '44444444-4444-4444-4444-444444444444';

function buildMaterializeEnvelope(overrides: Partial<{ tenantId: string; campaignId: string; conditions: unknown }> = {}) {
  const event = {
    tenantId: overrides.tenantId ?? TENANT_A,
    campaignId: overrides.campaignId ?? CAMPAIGN_A,
    conditions: overrides.conditions ?? { field: 'lifecycleStage', op: 'in', values: ['lead'] },
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(event)).toString('base64'),
      messageId: 'msg-test-materialize',
    },
    subscription: 'projects/test/subscriptions/growth-api-campaign-materialize',
  };
}

function buildDecisionRunEnvelope(
  overrides: Partial<{ tenantId: string; contactId: string; campaignId: string; source: string }> = {},
) {
  const event = {
    tenantId: overrides.tenantId ?? TENANT_A,
    contactId: overrides.contactId ?? CONTACT_A,
    campaignId: overrides.campaignId ?? CAMPAIGN_A,
    source: overrides.source ?? 'activate',
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(event)).toString('base64'),
      messageId: 'msg-test-decision-run',
    },
    subscription: 'projects/test/subscriptions/growth-api-decision-run',
  };
}

async function postMaterialize(envelope: unknown) {
  return campaignMaterializePushApp.request('/campaign-materialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

async function postDecisionRun(envelope: unknown) {
  return decisionRunPushApp.request('/decision-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyPubsubOidcMock.mockResolvedValue(true);
});

// ═════════════════════════════════════════════
// campaign-materialize-push subscriber
// ═════════════════════════════════════════════

describe('campaign-materialize-push', () => {
  it('OIDC verify fails → 401, worker not invoked', async () => {
    verifyPubsubOidcMock.mockResolvedValue(false);
    const res = await postMaterialize(buildMaterializeEnvelope());
    expect(res.status).toBe(401);
    expect(materializeAudienceSnapshotMock).not.toHaveBeenCalled();
  });

  it('malformed envelope → 200 ack+drop (poison defense)', async () => {
    const res = await campaignMaterializePushApp.request('/campaign-materialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(200);
    expect(materializeAudienceSnapshotMock).not.toHaveBeenCalled();
  });

  it('malformed inner event → 200 ack+drop', async () => {
    const res = await campaignMaterializePushApp.request('/campaign-materialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { data: Buffer.from('{}').toString('base64'), messageId: 'm' },
      }),
    });
    expect(res.status).toBe(200);
    expect(materializeAudienceSnapshotMock).not.toHaveBeenCalled();
  });

  it('campaign not found in tenant scope → 200 ack+drop (stale message)', async () => {
    campaignFindFirstMock.mockResolvedValue(null);
    const res = await postMaterialize(buildMaterializeEnvelope());
    expect(res.status).toBe(200);
    expect(materializeAudienceSnapshotMock).not.toHaveBeenCalled();
  });

  it('campaign already materialized (audienceEvaluatedAt set) → 200 ack+drop, idempotency skip', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active',
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    const res = await postMaterialize(buildMaterializeEnvelope());
    expect(res.status).toBe(200);
    expect(materializeAudienceSnapshotMock).not.toHaveBeenCalled();
  });

  it('happy path → calls materializeAudienceSnapshot, 200 ack', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'committed',
      audienceEvaluatedAt: null,
    });
    materializeAudienceSnapshotMock.mockResolvedValue({
      campaignId: CAMPAIGN_A,
      totalContactsScanned: 1200,
      totalMembershipInserted: 1200,
      batchCount: 3,
    });
    const res = await postMaterialize(buildMaterializeEnvelope());
    expect(res.status).toBe(200);
    expect(materializeAudienceSnapshotMock).toHaveBeenCalledTimes(1);
    expect(materializeAudienceSnapshotMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_A,
        campaignId: CAMPAIGN_A,
      }),
    );
  });

  it('worker throws (transient error) → 500 nack for Pub/Sub redelivery', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'committed',
      audienceEvaluatedAt: null,
    });
    materializeAudienceSnapshotMock.mockRejectedValue(new Error('PG conn dropped'));
    const res = await postMaterialize(buildMaterializeEnvelope());
    expect(res.status).toBe(500);
    expect(materializeAudienceSnapshotMock).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════
// decision-run-push subscriber — the safety surface
// ═════════════════════════════════════════════

describe('decision-run-push — auth + envelope hygiene', () => {
  it('OIDC verify fails → 401, runDecisionForContact not invoked', async () => {
    verifyPubsubOidcMock.mockResolvedValue(false);
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(401);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  it('malformed envelope → 200 ack+drop', async () => {
    const res = await decisionRunPushApp.request('/decision-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  it('malformed inner event → 200 ack+drop', async () => {
    const res = await decisionRunPushApp.request('/decision-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { data: Buffer.from('{}').toString('base64'), messageId: 'm' },
      }),
    });
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });
});

describe('decision-run-push — 3 HARD GUARDS (safety surface)', () => {
  // ── Guard 1: campaign.status='active' ─────────────────────────
  it('GUARD 1 REJECTION — campaign.status=committed → no-op, 200, runDecisionForContact NOT called', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'committed', // PR1's post-backfill state for all existing PROD campaigns
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
    // Stack lookup must NOT happen — guard 1 short-circuits before guard 3
    expect(stackFindFirstMock).not.toHaveBeenCalled();
  });

  it('GUARD 1 REJECTION — campaign.status=paused (PR1 enum value) → no-op, 200', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'paused',
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  it('GUARD 1 REJECTION — campaign.status=archived → no-op, 200', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'archived',
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  it('GUARD pre-check — campaign not found in tenant → no-op, 200', async () => {
    campaignFindFirstMock.mockResolvedValue(null);
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
    expect(stackFindFirstMock).not.toHaveBeenCalled();
  });

  // ── Guard 2: audienceEvaluatedAt IS NOT NULL ──────────────────
  it('GUARD 2 REJECTION — audienceEvaluatedAt IS NULL (partial materialization) → no-op, 200', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active', // active but materialization in flight
      audienceEvaluatedAt: null, // the 3a→3b interlock from feedback_3a_inert_3b_interlock
    });
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
    expect(stackFindFirstMock).not.toHaveBeenCalled(); // guard 2 short-circuits
  });

  // ── Guard 3: contactObjectiveStack.status='active' ────────────
  it('GUARD 3 REJECTION — stack row not found → no-op, 200', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active',
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    stackFindFirstMock.mockResolvedValue(null);
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  it('GUARD 3 REJECTION — stack.status=paused → no-op, 200', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active',
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    stackFindFirstMock.mockResolvedValue({
      id: STACK_A,
      status: 'paused',
    });
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  it('GUARD 3 REJECTION — stack.status=achieved (terminal) → no-op, 200', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active',
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    stackFindFirstMock.mockResolvedValue({
      id: STACK_A,
      status: 'achieved',
    });
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  // ── All guards pass — call runDecisionForContact (governance pass-through) ──
  it('ALL GUARDS PASS → calls runDecisionForContact UNMODIFIED, 200', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active', // only when PR5 has activated something
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    stackFindFirstMock.mockResolvedValue({
      id: STACK_A,
      status: 'active',
      // KAN-1009 PR4 — stack now includes lastEvaluatedAt for the dedup
      // gate downstream. Very old date → dedup passes; let PR3's assertion
      // on runDecisionForContact still be the load-bearing check.
      lastEvaluatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    runDecisionForContactMock.mockResolvedValue({
      decisionId: 'dec_test',
      strategy: 'direct',
      outcome: 'ESCALATED', // under autoApproveEnabled=false, this is the expected outcome
    });
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).toHaveBeenCalledTimes(1);
    expect(runDecisionForContactMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_A,
        contactId: CONTACT_A,
        actor: { type: 'SYSTEM', id: 'decision-run-push' },
      }),
    );
  });

  it('runDecisionForContact throws (transient) → 500 nack for Pub/Sub redelivery', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active',
      audienceEvaluatedAt: new Date('2026-05-24T15:00:00Z'),
    });
    stackFindFirstMock.mockResolvedValue({
      id: STACK_A,
      status: 'active',
      lastEvaluatedAt: new Date('2026-01-01T00:00:00Z'), // PR4 dedup passes
    });
    runDecisionForContactMock.mockRejectedValue(new Error('LLM timeout'));
    const res = await postDecisionRun(buildDecisionRunEnvelope());
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════
// Static-source inertness proof — no new send-path bypass
// (Same shape as the KAN-1002 source-grep test in campaign-commit.test.ts)
// ═════════════════════════════════════════════

describe('decision-run-push — INERTNESS source grep', () => {
  it('decision-run-push.ts contains no imports of action-decided-publisher / agent-dispatcher / send-policy', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'subscribers', 'decision-run-push.ts'),
      'utf-8',
    );
    // Strip block comments so docstrings explaining the prohibition don't false-match
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*action-decided-publisher/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*agent-dispatcher/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*send-policy/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*message-composer/);
    expect(codeOnly).not.toMatch(/\bpublishActionSend\b/);
    expect(codeOnly).not.toMatch(/\bpublishActionDecided\b/);
  });

  it('subscriber source contains the 3 named guard reasons (regression: a future refactor must keep the named outcomes)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'subscribers', 'decision-run-push.ts'),
      'utf-8',
    );
    expect(src).toMatch(/campaign_not_active/);
    expect(src).toMatch(/audience_not_evaluated/);
    expect(src).toMatch(/stack_not_active/);
  });
});

// ═════════════════════════════════════════════
// Unit tests for the extracted guard function (testable independently of Hono)
// ═════════════════════════════════════════════

describe('evaluateDecisionRunGuards (extracted)', () => {
  it('returns campaign_not_found when campaign.findFirst returns null', async () => {
    campaignFindFirstMock.mockResolvedValue(null);
    const result = await evaluateDecisionRunGuards(
      {
        campaign: { findFirst: campaignFindFirstMock },
        contactObjectiveStack: { findFirst: stackFindFirstMock },
      },
      { tenantId: TENANT_A, contactId: CONTACT_A, campaignId: CAMPAIGN_A },
    );
    expect(result).toEqual({ ok: false, reason: 'campaign_not_found' });
  });

  it('returns ok:true + the loaded stack when all 3 guards pass', async () => {
    const stackLastEval = new Date('2026-01-01T00:00:00Z');
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active',
      audienceEvaluatedAt: new Date(),
    });
    // KAN-1009 PR4 — guard now returns the loaded stack (id+status+
    // lastEvaluatedAt) so the downstream dedup gate doesn't need a
    // second findFirst roundtrip.
    stackFindFirstMock.mockResolvedValue({
      id: STACK_A,
      status: 'active',
      lastEvaluatedAt: stackLastEval,
    });
    const result = await evaluateDecisionRunGuards(
      {
        campaign: { findFirst: campaignFindFirstMock },
        contactObjectiveStack: { findFirst: stackFindFirstMock },
      },
      { tenantId: TENANT_A, contactId: CONTACT_A, campaignId: CAMPAIGN_A },
    );
    expect(result).toEqual({
      ok: true,
      stack: { id: STACK_A, status: 'active', lastEvaluatedAt: stackLastEval },
    });
  });
});
