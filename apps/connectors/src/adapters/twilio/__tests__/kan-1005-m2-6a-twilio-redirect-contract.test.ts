/**
 * KAN-1005 M2-6a — Twilio adapter contract test: the redirected phone
 * actually reaches the Twilio SDK.
 *
 * Sibling to the Resend contract test
 * (apps/connectors/src/adapters/resend/__tests__/kan-1005-m2-6a-resend-redirect-contract.test.ts).
 * Same shape, same purpose: typecheck would accept a bug like
 * `await applyRedirect(msg); client.messages.create({to: msg.recipient.phone})`
 * where the awaited result is discarded and the real customer phone
 * reaches Twilio. The grep-based no-bypass test proves "applyRedirect
 * was invoked"; this test proves "the redirected phone reached the SDK."
 *
 * Founder mandate 2026-05-27 — symmetric coverage with Resend, because
 * Twilio goes live with M2-6a's per-tenant flip + KAN-808 compliance,
 * and SMS to a real phone is just as much a breach of the no-real-
 * contact mandate as email.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track the args Twilio's messages.create received.
const twilioMessagesCreateMock = vi.fn(async () => ({
  sid: 'twilio-sid-stub',
  status: 'queued',
}));

const twilioFakeClient = { messages: { create: twilioMessagesCreateMock } };

// Mock the getTwilioClient helper so the adapter's async client-fetch
// returns our stub, not the real Twilio SDK.
vi.mock('../client.js', () => ({
  getTwilioClient: vi.fn(async () => twilioFakeClient),
  getMessagingServiceSid: vi.fn(async () => 'twilio-msg-svc-sid-stub'),
}));

// Bypass the opt-out DB read.
vi.mock('../optout.js', () => ({
  isOptedOut: vi.fn(async () => false),
  markOptedOut: vi.fn(async () => undefined),
  clearOptOut: vi.fn(async () => undefined),
}));

const REDIRECT_PHONE_TARGET = '+15148359958';
const REAL_CUSTOMER_PHONE = '+14165551212';

const ENV_FIXTURE = {
  SEND_REDIRECT_ENABLED: 'true', // env-true → force-global redirect path
  SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
  SEND_REDIRECT_PHONE: REDIRECT_PHONE_TARGET,
  GCP_PROJECT_ID: 'test-project',
  DATABASE_URL: 'postgresql://test',
  INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
  PUBLIC_WEBHOOK_BASE_URL: 'https://example.invalid',
};

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) {
      delete (process.env as Record<string, string | undefined>)[k];
    } else {
      (process.env as Record<string, string | undefined>)[k] = v;
    }
  }
}

function baseMsg(): Record<string, unknown> {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    actionId: '00000000-0000-0000-0000-000000000002',
    decisionId: 'decision_test',
    contactId: '00000000-0000-0000-0000-000000000003',
    recipient: { phone: REAL_CUSTOMER_PHONE },
    content: { body: 'Original SMS body' },
  };
}

function baseConnection(): Record<string, unknown> {
  return {
    id: 'conn-sms-1',
    tenantId: '00000000-0000-0000-0000-000000000001',
    channelType: 'SMS',
    provider: 'twilio',
    providerAccountId: 'twilio-account',
    status: 'ACTIVE',
    credentialsRef: 'credentials-ref',
    metadata: {},
    // No compliance object → adapter's compliance gate short-circuits (only
    // gates when compliance exists AND is not sendable). The redirect logic
    // sits ABOVE all of this either way.
    complianceStatus: null,
  };
}

describe('KAN-1005 M2-6a — TwilioAdapter contract: redirected phone reaches Twilio SDK', () => {
  beforeEach(() => {
    vi.resetModules();
    twilioMessagesCreateMock.mockClear();
    setEnv(ENV_FIXTURE);
  });

  it('redirect ON (env-true) → Twilio SDK receives REDIRECT phone in `to:`, NOT the real customer', async () => {
    const { TwilioAdapter } = await import('../index.js');
    // TwilioAdapter takes (provider, channel) in its constructor for the
    // multi-channel Twilio family (SMS + WhatsApp). SMS path is the
    // canonical PROD path.
    const adapter = new TwilioAdapter();
    const result = await adapter.send(baseConnection() as any, baseMsg() as any);

    expect(result.status).toBe('sent');
    expect(twilioMessagesCreateMock).toHaveBeenCalledTimes(1);

    const callTuple = twilioMessagesCreateMock.mock.calls[0] as unknown as [
      { to: string; body: string },
    ];
    const args = callTuple[0];

    // THE pin: the provider SDK saw the redirect target, not the real
    // customer. If this fails, the adapter silently dropped the await
    // result OR applyRedirect itself regressed.
    expect(args.to).toBe(REDIRECT_PHONE_TARGET);
    expect(args.to).not.toBe(REAL_CUSTOMER_PHONE);

    // Body got the [TEST REDIRECT] prefix — proves the FULL transformed
    // message (recipient + content) was threaded, not just one field.
    expect(args.body).toMatch(/^\[TEST REDIRECT\] /);
    expect(args.body).toContain('Original SMS body');
    // SMS critical safety: full real phone never appears in the body
    // (the structured log carries it; the wire payload doesn't).
    expect(args.body).not.toContain(REAL_CUSTOMER_PHONE);
  });

  it('redirect ON via per-tenant path (env-false + tenant=true) → SDK still receives redirect phone', async () => {
    setEnv({ ...ENV_FIXTURE, SEND_REDIRECT_ENABLED: 'false' });

    const sendRedirect = await import('../../_shared/send-redirect.js');
    sendRedirect.__setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => ({ sendRedirectEnabled: true })),
      },
    } as any);

    const { TwilioAdapter } = await import('../index.js');
    const adapter = new TwilioAdapter();
    await adapter.send(baseConnection() as any, baseMsg() as any);

    const callTuple = twilioMessagesCreateMock.mock.calls[0] as unknown as [{ to: string }];
    const args = callTuple[0];
    expect(args.to).toBe(REDIRECT_PHONE_TARGET);
    expect(args.to).not.toBe(REAL_CUSTOMER_PHONE);

    sendRedirect.__setPrismaForTest(null);
  });

  it('per-tenant explicit-false (env-false + tenant=false) → SDK receives REAL customer phone (the only path that reaches real recipients)', async () => {
    // Negative control: when redirect is OFF, the provider SDK sees the
    // real customer phone. KAN-808-gated go-live shape. Pin so the
    // positive assertions aren't trivially "always redirects."
    setEnv({ ...ENV_FIXTURE, SEND_REDIRECT_ENABLED: 'false' });

    const sendRedirect = await import('../../_shared/send-redirect.js');
    sendRedirect.__setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => ({ sendRedirectEnabled: false })),
      },
    } as any);

    const { TwilioAdapter } = await import('../index.js');
    const adapter = new TwilioAdapter();
    await adapter.send(baseConnection() as any, baseMsg() as any);

    const callTuple = twilioMessagesCreateMock.mock.calls[0] as unknown as [
      { to: string; body: string },
    ];
    const args = callTuple[0];
    expect(args.to).toBe(REAL_CUSTOMER_PHONE);
    expect(args.to).not.toBe(REDIRECT_PHONE_TARGET);
    expect(args.body).toBe('Original SMS body'); // no [TEST REDIRECT] prefix

    sendRedirect.__setPrismaForTest(null);
  });
});
