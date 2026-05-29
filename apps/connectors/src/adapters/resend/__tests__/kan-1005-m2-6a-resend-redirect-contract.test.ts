/**
 * KAN-1005 M2-6a — adapter contract test: the redirected recipient
 * actually reaches the provider SDK.
 *
 * Founder review 2026-05-27: the M2-6a async refactor changed
 * `applyRedirect` from sync to async (`msg = await applyRedirect(...)`).
 * Typecheck would accept a bug shape like `await applyRedirect(msg);
 * provider.send(msg)` — the awaited result is discarded, the original
 * un-redirected msg goes to the provider. The grep-based no-bypass
 * test proves "applyRedirect was invoked"; it doesn't prove "the
 * redirected recipient reached the provider."
 *
 * This test fills that gap for the Resend adapter (the live email
 * path in PROD). Mocks the Resend SDK + bypasses the suppression DB
 * read, calls `ResendAdapter.send()` with a real-customer recipient
 * AND redirect ON (env-true / default), then asserts the Resend
 * stub's `emails.send` received `to: <redirect target>` — NOT the
 * real customer email.
 *
 * If the adapter ever silently drops the await result (e.g., a
 * refactor that does `applyRedirect(msg, ...)` without the
 * `msg = await`), this test fails LOUDLY: the spy sees the real
 * customer email, the assertion blows up.
 *
 * Twilio gets the same shape in a sibling test
 * (twilio/__tests__/kan-1005-m2-6a-twilio-redirect-contract.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track the args the Resend SDK's emails.send received.
const resendEmailsSendMock = vi.fn(async () => ({
  data: { id: 'resend-message-id-stub' },
  error: null,
}));

// Mock the `resend` package — any `new Resend(key)` returns our stub.
vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: { send: resendEmailsSendMock },
  })),
}));

// Bypass the suppression DB read (separate concern; not what this
// test exercises).
vi.mock('../suppressions.js', () => ({
  isSuppressedDb: vi.fn(async () => ({ suppressed: false })),
  suppressDb: vi.fn(async () => undefined),
}));

// Bypass the unsubscribe-token mint (depends on env that's not set in
// the test sandbox).
vi.mock('../unsubscribe-token.js', () => ({
  generateUnsubscribeToken: vi.fn(async () => null),
  buildUnsubscribeUrl: vi.fn(() => 'https://example.invalid/unsub'),
  buildUnsubscribeMailto: vi.fn(() => 'mailto:unsubscribe@example.invalid'),
}));

const REDIRECT_EMAIL_TARGET = 'fred@axisone.ca';
const REAL_CUSTOMER_EMAIL = 'real-customer@example.com';

const ENV_FIXTURE = {
  SEND_REDIRECT_ENABLED: 'true', // env-true → force-global redirect path
  SEND_REDIRECT_EMAIL: REDIRECT_EMAIL_TARGET,
  SEND_REDIRECT_PHONE: '+15148359958',
  GCP_PROJECT_ID: 'test-project',
  DATABASE_URL: 'postgresql://test',
  INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
  RESEND_API_KEY: 'test-resend-api-key',
  UNSUBSCRIBE_URL_LIVE: 'false',
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
    recipient: {
      email: REAL_CUSTOMER_EMAIL,
      displayName: 'Real Customer',
    },
    content: {
      subject: 'Original subject',
      body: 'Original body content',
      html: '<p>Original HTML</p>',
    },
  };
}

function baseConnection(): Record<string, unknown> {
  return {
    id: 'conn-1',
    tenantId: '00000000-0000-0000-0000-000000000001',
    channelType: 'EMAIL',
    provider: 'resend',
    providerAccountId: 'resend-account',
    status: 'ACTIVE',
    credentialsRef: 'credentials-ref',
    metadata: { mode: 'simple', fromEmail: 'hello@axisone.ca', fromName: 'AxisOne' },
  };
}

describe('KAN-1005 M2-6a — ResendAdapter contract: redirected recipient reaches provider SDK', () => {
  beforeEach(() => {
    vi.resetModules();
    resendEmailsSendMock.mockClear();
    setEnv(ENV_FIXTURE);
  });

  it('redirect ON (env-true) → Resend SDK receives REDIRECT target in `to:`, NOT the real customer', async () => {
    const { ResendAdapter } = await import('../index.js');
    const adapter = new ResendAdapter();
    const result = await adapter.send(baseConnection() as any, baseMsg() as any);

    expect(result.status).toBe('sent');
    expect(resendEmailsSendMock).toHaveBeenCalledTimes(1);

    const callTuple = resendEmailsSendMock.mock.calls[0] as unknown as [
      { to: string[]; subject?: string },
    ];
    const args = callTuple[0];

    // THE pin: the provider SDK saw the redirect target, not the real customer.
    // If this fails, the adapter silently dropped the await result (the bug
    // shape this test exists to catch) OR applyRedirect itself regressed.
    expect(args.to[0]).toContain(REDIRECT_EMAIL_TARGET);
    expect(args.to[0]).not.toContain(REAL_CUSTOMER_EMAIL);

    // Also pin the subject + body banner reached the provider — proves
    // the FULL transformed message (recipient + content) was threaded,
    // not just one field.
    expect(args.subject).toMatch(/\[TEST REDIRECT — intended: real-customer@example\.com\]/);
  });

  it('redirect ON via per-tenant path (env-false + tenant=true) → SDK still receives redirect target', async () => {
    // Sibling proof for the per-tenant branch: even when env-true short-
    // circuit isn't used and the per-tenant DB lookup fires, the same
    // contract holds — the adapter consumes the await result.
    setEnv({ ...ENV_FIXTURE, SEND_REDIRECT_ENABLED: 'false' });

    const sendRedirect = await import('../../_shared/send-redirect.js');
    sendRedirect.__setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => ({ sendRedirectEnabled: true })),
      },
    } as any);

    const { ResendAdapter } = await import('../index.js');
    const adapter = new ResendAdapter();
    await adapter.send(baseConnection() as any, baseMsg() as any);

    const callTuple = resendEmailsSendMock.mock.calls[0] as unknown as [{ to: string[] }];
    const args = callTuple[0];
    expect(args.to[0]).toContain(REDIRECT_EMAIL_TARGET);
    expect(args.to[0]).not.toContain(REAL_CUSTOMER_EMAIL);

    sendRedirect.__setPrismaForTest(null);
  });

  it('per-tenant explicit-false (env-false + tenant=false) → SDK receives REAL customer (the only path that reaches real recipients)', async () => {
    // Negative control: when redirect is OFF, the provider SDK sees the
    // real customer. This is the KAN-808-gated go-live shape. The test
    // exists so the assertion above isn't trivially true ("always redirects").
    setEnv({ ...ENV_FIXTURE, SEND_REDIRECT_ENABLED: 'false' });

    const sendRedirect = await import('../../_shared/send-redirect.js');
    sendRedirect.__setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => ({ sendRedirectEnabled: false })),
      },
    } as any);

    const { ResendAdapter } = await import('../index.js');
    const adapter = new ResendAdapter();
    await adapter.send(baseConnection() as any, baseMsg() as any);

    const callTuple = resendEmailsSendMock.mock.calls[0] as unknown as [
      { to: string[]; subject?: string },
    ];
    const args = callTuple[0];
    expect(args.to[0]).toContain(REAL_CUSTOMER_EMAIL);
    expect(args.to[0]).not.toContain(REDIRECT_EMAIL_TARGET);
    expect(args.subject).toBe('Original subject'); // no [TEST REDIRECT] banner

    sendRedirect.__setPrismaForTest(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// KAN-1035 — wire-truth pin: Resend SDK actually receives the replyTo we
// thread through OutboundMessage. Three properties:
//   (a) msg.replyTo populated → SDK call carries reply_to (the actual
//       header that lands in the recipient's MUA — when Reply-To is set,
//       Gmail's Reply composer targets THIS address, not From).
//   (b) M2-6a redirect doesn't strip replyTo — recipient is rewritten
//       to fred but Reply-To stays as the originator-intended inbox slug.
//   (c) Legacy fallback preserved — msg.replyTo absent but
//       ChannelConnection.metadata.replyTo set → SDK still receives
//       reply_to via the connection-level default.
// ─────────────────────────────────────────────────────────────────────────

describe('KAN-1035 — replyTo wire contract: Resend SDK receives reply_to', () => {
  // The PROD AxisOne tenant inbox_slug observed in M3-2.5b live-verify.
  // Re-pinned here so future readers tracing the reply loop can grep this
  // value from either side (Phase 1 trace + this contract test).
  const AXISONE_REPLY_TO = 'c03065f6@leads.axisone.ca';

  beforeEach(() => {
    vi.resetModules();
    resendEmailsSendMock.mockClear();
    setEnv(ENV_FIXTURE);
  });

  it('msg.replyTo populated + redirect ON → SDK call carries replyTo (To: rewritten to fred, Reply-To: stays as inbox slug)', async () => {
    const { ResendAdapter } = await import('../index.js');
    const adapter = new ResendAdapter();
    await adapter.send(
      baseConnection() as any,
      { ...baseMsg(), replyTo: AXISONE_REPLY_TO } as any,
    );

    expect(resendEmailsSendMock).toHaveBeenCalledTimes(1);
    const callTuple = resendEmailsSendMock.mock.calls[0] as unknown as [
      { to: string[]; replyTo?: string },
    ];
    const args = callTuple[0];

    // (a) Reply-To threaded
    expect(args.replyTo).toBe(AXISONE_REPLY_TO);
    // (b) Redirect still applied to To: (KAN-1005 M2-6a held)
    expect(args.to[0]).toContain(REDIRECT_EMAIL_TARGET);
    expect(args.to[0]).not.toContain(REAL_CUSTOMER_EMAIL);
  });

  it('msg.replyTo absent + ChannelConnection.metadata.replyTo set → SDK receives the connection-level fallback (legacy KAN-816 behavior preserved)', async () => {
    const LEGACY_FALLBACK = 'fallback-inbox@axisone.legacy';
    const connection = {
      ...baseConnection(),
      metadata: { ...(baseConnection().metadata as Record<string, unknown>), replyTo: LEGACY_FALLBACK },
    };

    const { ResendAdapter } = await import('../index.js');
    const adapter = new ResendAdapter();
    // msg.replyTo intentionally NOT set — exercises the adapter's
    // `messageReplyTo ?? metadata.replyTo` fallback (index.ts:166-167).
    await adapter.send(connection as any, baseMsg() as any);

    const callTuple = resendEmailsSendMock.mock.calls[0] as unknown as [
      { replyTo?: string },
    ];
    expect(callTuple[0].replyTo).toBe(LEGACY_FALLBACK);
  });

  it('msg.replyTo absent + no ChannelConnection fallback → SDK call omits replyTo entirely (pre-KAN-816 default — no Reply-To header on the wire)', async () => {
    const connection = {
      ...baseConnection(),
      metadata: { mode: 'simple', fromEmail: 'hello@axisone.ca', fromName: 'AxisOne' },
      // No replyTo key at all in metadata.
    };

    const { ResendAdapter } = await import('../index.js');
    const adapter = new ResendAdapter();
    await adapter.send(connection as any, baseMsg() as any);

    const callTuple = resendEmailsSendMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect('replyTo' in callTuple[0]).toBe(false);
  });
});
