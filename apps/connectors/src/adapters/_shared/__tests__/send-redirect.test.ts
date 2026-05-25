/**
 * KAN-1030 — send-redirect guardrail unit tests.
 *
 * Founder mandate 2026-05-25: no message may ever reach a real contact
 * during testing. This test matrix proves applyRedirect:
 *   1. Redirects EMAIL to SEND_REDIRECT_EMAIL with subject prefix + body banner
 *   2. Redirects SMS to SEND_REDIRECT_PHONE with short body prefix
 *   3. Redirects WHATSAPP (same Twilio adapter path) to SEND_REDIRECT_PHONE
 *   4. Fail-closed: missing target → throws SendRedirectMisconfiguredError
 *   5. Disable-explicit: ENABLED=false → passes through unchanged (with audit log)
 *   6. Pure transform: never mutates the input message
 *
 * The structural no-bypass CI gate lives in a sibling file
 * (send-redirect-no-bypass.test.ts) — together they pin the guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock env BEFORE importing the module under test (env is parsed at
// import-time via Zod). vi.doMock is hoisted.
const setEnv = (overrides: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const baseMsg = () => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  actionId: '00000000-0000-0000-0000-000000000002',
  decisionId: 'cuid-decision-1',
  contactId: '00000000-0000-0000-0000-000000000003',
  recipient: {
    email: 'real-customer@example.com',
    displayName: 'Real Customer',
  },
  content: {
    subject: 'Original subject',
    body: 'Original body content',
    html: '<p>Original HTML</p>',
  },
});

const baseSmsMsg = () => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  actionId: '00000000-0000-0000-0000-000000000002',
  decisionId: 'cuid-decision-1',
  contactId: '00000000-0000-0000-0000-000000000003',
  recipient: { phone: '+14165551212' },
  content: { body: 'Original SMS body within the 160-char budget for testing' },
});

describe('KAN-1030 — applyRedirect: EMAIL channel', () => {
  let applyRedirect: typeof import('../send-redirect.js').applyRedirect;
  let SendRedirectMisconfiguredError: typeof import('../send-redirect.js').SendRedirectMisconfiguredError;

  beforeEach(async () => {
    vi.resetModules();
    setEnv({
      SEND_REDIRECT_ENABLED: 'true',
      SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
      SEND_REDIRECT_PHONE: '+15148359958',
      // Required for env.ts Zod parse to pass
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test',
      INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
    });
    const mod = await import('../send-redirect.js');
    applyRedirect = mod.applyRedirect;
    SendRedirectMisconfiguredError = mod.SendRedirectMisconfiguredError;
  });

  afterEach(() => {
    setEnv({
      SEND_REDIRECT_ENABLED: undefined,
      SEND_REDIRECT_EMAIL: undefined,
      SEND_REDIRECT_PHONE: undefined,
    });
  });

  it('swaps recipient.email to SEND_REDIRECT_EMAIL', () => {
    const out = applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.email).toBe('fred@axisone.ca');
  });

  it('clears recipient.displayName (no misleading "Real Customer <fred@…>" header)', () => {
    const out = applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.displayName).toBeUndefined();
  });

  it('prepends [TEST REDIRECT — intended: <original>] to subject', () => {
    const out = applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.content.subject).toBe(
      '[TEST REDIRECT — intended: real-customer@example.com] Original subject',
    );
  });

  it('prepends the test-redirect banner to HTML body', () => {
    const out = applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.content.html).toMatch(/^<div[^>]*>.*TEST REDIRECT.*real-customer@example\.com/);
    expect(out.content.html).toContain('<p>Original HTML</p>');
  });

  it('prepends the test-redirect banner to text body', () => {
    const out = applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.content.body).toMatch(/^=+ TEST REDIRECT =+/);
    expect(out.content.body).toContain('real-customer@example.com');
    expect(out.content.body).toContain('Original body content');
  });

  it('escapes HTML in the original recipient email (XSS defense in banner)', () => {
    const msg = baseMsg();
    msg.recipient.email = '<script>alert(1)</script>@evil.com';
    const out = applyRedirect(msg as any, 'EMAIL');
    expect(out.content.html).not.toContain('<script>alert(1)</script>');
    expect(out.content.html).toContain('&lt;script&gt;');
  });

  it('does NOT mutate the input message (pure transform)', () => {
    const msg = baseMsg();
    const original = JSON.parse(JSON.stringify(msg));
    applyRedirect(msg as any, 'EMAIL');
    expect(msg).toEqual(original);
  });

  it('throws SendRedirectMisconfiguredError when SEND_REDIRECT_EMAIL missing', async () => {
    setEnv({ SEND_REDIRECT_EMAIL: undefined });
    vi.resetModules();
    const { applyRedirect: ar, SendRedirectMisconfiguredError: Err } = await import('../send-redirect.js');
    expect(() => ar(baseMsg() as any, 'EMAIL')).toThrow(Err);
    expect(() => ar(baseMsg() as any, 'EMAIL')).toThrow(/SEND_REDIRECT_EMAIL/);
  });
});

describe('KAN-1030 — applyRedirect: SMS / WHATSAPP channel', () => {
  let applyRedirect: typeof import('../send-redirect.js').applyRedirect;

  beforeEach(async () => {
    vi.resetModules();
    setEnv({
      SEND_REDIRECT_ENABLED: 'true',
      SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
      SEND_REDIRECT_PHONE: '+15148359958',
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test',
      INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
    });
    const mod = await import('../send-redirect.js');
    applyRedirect = mod.applyRedirect;
  });

  it('swaps recipient.phone to SEND_REDIRECT_PHONE for SMS', () => {
    const out = applyRedirect(baseSmsMsg() as any, 'SMS');
    expect(out.recipient.phone).toBe('+15148359958');
  });

  it('swaps recipient.phone to SEND_REDIRECT_PHONE for WHATSAPP (Twilio handles WA too)', () => {
    const out = applyRedirect(baseSmsMsg() as any, 'WHATSAPP');
    expect(out.recipient.phone).toBe('+15148359958');
  });

  it('prepends short [TEST REDIRECT] prefix (no full recipient — preserves SMS 160 char budget)', () => {
    const out = applyRedirect(baseSmsMsg() as any, 'SMS');
    expect(out.content.body).toMatch(/^\[TEST REDIRECT\] /);
    expect(out.content.body).toContain('Original SMS body');
    // Critically: no full recipient phone in body (lives in structured log)
    expect(out.content.body).not.toContain('+14165551212');
  });

  it('throws when SEND_REDIRECT_PHONE missing (SMS)', async () => {
    setEnv({ SEND_REDIRECT_PHONE: undefined });
    vi.resetModules();
    const { applyRedirect: ar } = await import('../send-redirect.js');
    expect(() => ar(baseSmsMsg() as any, 'SMS')).toThrow(/SEND_REDIRECT_PHONE/);
  });

  it('throws when SEND_REDIRECT_PHONE missing (WHATSAPP)', async () => {
    setEnv({ SEND_REDIRECT_PHONE: undefined });
    vi.resetModules();
    const { applyRedirect: ar } = await import('../send-redirect.js');
    expect(() => ar(baseSmsMsg() as any, 'WHATSAPP')).toThrow(/SEND_REDIRECT_PHONE/);
  });
});

describe('KAN-1030 — applyRedirect: MESSENGER channel (no target defined)', () => {
  let applyRedirect: typeof import('../send-redirect.js').applyRedirect;
  let SendRedirectMisconfiguredError: typeof import('../send-redirect.js').SendRedirectMisconfiguredError;

  beforeEach(async () => {
    vi.resetModules();
    setEnv({
      SEND_REDIRECT_ENABLED: 'true',
      SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
      SEND_REDIRECT_PHONE: '+15148359958',
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test',
      INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
    });
    const mod = await import('../send-redirect.js');
    applyRedirect = mod.applyRedirect;
    SendRedirectMisconfiguredError = mod.SendRedirectMisconfiguredError;
  });

  it('throws (no target defined for MESSENGER in M1)', () => {
    expect(() =>
      applyRedirect(
        {
          ...baseMsg(),
          recipient: { pageScopedUserId: 'psid-12345' },
        } as any,
        'MESSENGER',
      ),
    ).toThrow(SendRedirectMisconfiguredError);
  });
});

describe('KAN-1030 — applyRedirect: ENABLED=false (explicit production disable)', () => {
  let applyRedirect: typeof import('../send-redirect.js').applyRedirect;

  beforeEach(async () => {
    vi.resetModules();
    setEnv({
      SEND_REDIRECT_ENABLED: 'false', // explicitly off
      SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
      SEND_REDIRECT_PHONE: '+15148359958',
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test',
      INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
    });
    const mod = await import('../send-redirect.js');
    applyRedirect = mod.applyRedirect;
  });

  it('passes message through unchanged when explicitly disabled', () => {
    const out = applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.email).toBe('real-customer@example.com');
    expect(out.recipient.displayName).toBe('Real Customer');
    expect(out.content.subject).toBe('Original subject');
    expect(out.content.body).toBe('Original body content');
    expect(out.content.html).toBe('<p>Original HTML</p>');
  });

  it('SMS also pass-through when disabled', () => {
    const out = applyRedirect(baseSmsMsg() as any, 'SMS');
    expect(out.recipient.phone).toBe('+14165551212');
    expect(out.content.body).not.toMatch(/^\[TEST REDIRECT\]/);
  });
});
