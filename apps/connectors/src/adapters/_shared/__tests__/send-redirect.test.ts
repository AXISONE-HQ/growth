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

  it('swaps recipient.email to SEND_REDIRECT_EMAIL', async () => {
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.email).toBe('fred@axisone.ca');
  });

  it('clears recipient.displayName (no misleading "Real Customer <fred@…>" header)', async () => {
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.displayName).toBeUndefined();
  });

  it('prepends [TEST REDIRECT — intended: <original>] to subject', async () => {
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.content.subject).toBe(
      '[TEST REDIRECT — intended: real-customer@example.com] Original subject',
    );
  });

  it('prepends the test-redirect banner to HTML body', async () => {
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.content.html).toMatch(/^<div[^>]*>.*TEST REDIRECT.*real-customer@example\.com/);
    expect(out.content.html).toContain('<p>Original HTML</p>');
  });

  it('prepends the test-redirect banner to text body', async () => {
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.content.body).toMatch(/^=+ TEST REDIRECT =+/);
    expect(out.content.body).toContain('real-customer@example.com');
    expect(out.content.body).toContain('Original body content');
  });

  it('escapes HTML in the original recipient email (XSS defense in banner)', async () => {
    const msg = baseMsg();
    msg.recipient.email = '<script>alert(1)</script>@evil.com';
    const out = await applyRedirect(msg as any, 'EMAIL');
    expect(out.content.html).not.toContain('<script>alert(1)</script>');
    expect(out.content.html).toContain('&lt;script&gt;');
  });

  it('does NOT mutate the input message (pure transform)', async () => {
    const msg = baseMsg();
    const original = JSON.parse(JSON.stringify(msg));
    await applyRedirect(msg as any, 'EMAIL');
    expect(msg).toEqual(original);
  });

  it('throws SendRedirectMisconfiguredError when SEND_REDIRECT_EMAIL missing', async () => {
    setEnv({ SEND_REDIRECT_EMAIL: undefined });
    vi.resetModules();
    const { applyRedirect: ar, SendRedirectMisconfiguredError: Err } = await import('../send-redirect.js');
    await expect(ar(baseMsg() as any, 'EMAIL')).rejects.toThrow(Err);
    await expect(ar(baseMsg() as any, 'EMAIL')).rejects.toThrow(/SEND_REDIRECT_EMAIL/);
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

  it('swaps recipient.phone to SEND_REDIRECT_PHONE for SMS', async () => {
    const out = await applyRedirect(baseSmsMsg() as any, 'SMS');
    expect(out.recipient.phone).toBe('+15148359958');
  });

  it('swaps recipient.phone to SEND_REDIRECT_PHONE for WHATSAPP (Twilio handles WA too)', async () => {
    const out = await applyRedirect(baseSmsMsg() as any, 'WHATSAPP');
    expect(out.recipient.phone).toBe('+15148359958');
  });

  it('prepends short [TEST REDIRECT] prefix (no full recipient — preserves SMS 160 char budget)', async () => {
    const out = await applyRedirect(baseSmsMsg() as any, 'SMS');
    expect(out.content.body).toMatch(/^\[TEST REDIRECT\] /);
    expect(out.content.body).toContain('Original SMS body');
    // Critically: no full recipient phone in body (lives in structured log)
    expect(out.content.body).not.toContain('+14165551212');
  });

  it('throws when SEND_REDIRECT_PHONE missing (SMS)', async () => {
    setEnv({ SEND_REDIRECT_PHONE: undefined });
    vi.resetModules();
    const { applyRedirect: ar } = await import('../send-redirect.js');
    await expect(ar(baseSmsMsg() as any, 'SMS')).rejects.toThrow(/SEND_REDIRECT_PHONE/);
  });

  it('throws when SEND_REDIRECT_PHONE missing (WHATSAPP)', async () => {
    setEnv({ SEND_REDIRECT_PHONE: undefined });
    vi.resetModules();
    const { applyRedirect: ar } = await import('../send-redirect.js');
    await expect(ar(baseSmsMsg() as any, 'WHATSAPP')).rejects.toThrow(/SEND_REDIRECT_PHONE/);
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

  it('throws (no target defined for MESSENGER in M1)', async () => {
    await expect(
      applyRedirect(
        {
          ...baseMsg(),
          recipient: { pageScopedUserId: 'psid-12345' },
        } as any,
        'MESSENGER',
      ),
    ).rejects.toThrow(SendRedirectMisconfiguredError);
  });
});

describe('KAN-1030 + KAN-1005 M2-6a — applyRedirect: env-false (per-tenant column governs)', () => {
  let applyRedirect: typeof import('../send-redirect.js').applyRedirect;
  let __setPrismaForTest: typeof import('../send-redirect.js').__setPrismaForTest;

  beforeEach(async () => {
    vi.resetModules();
    setEnv({
      SEND_REDIRECT_ENABLED: 'false', // global force-ON OFF — per-tenant governs
      SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
      SEND_REDIRECT_PHONE: '+15148359958',
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test',
      INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
    });
    const mod = await import('../send-redirect.js');
    applyRedirect = mod.applyRedirect;
    __setPrismaForTest = mod.__setPrismaForTest;
  });

  afterEach(() => {
    __setPrismaForTest(null);
  });

  it('tenant.sendRedirectEnabled=false → real send (pass-through; the KAN-808-gated go-live shape)', async () => {
    __setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => ({ sendRedirectEnabled: false })),
      },
    } as any);
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.email).toBe('real-customer@example.com');
    expect(out.recipient.displayName).toBe('Real Customer');
    expect(out.content.subject).toBe('Original subject');
    expect(out.content.body).toBe('Original body content');
    expect(out.content.html).toBe('<p>Original HTML</p>');
  });

  it('tenant.sendRedirectEnabled=false on SMS → real send', async () => {
    __setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => ({ sendRedirectEnabled: false })),
      },
    } as any);
    const out = await applyRedirect(baseSmsMsg() as any, 'SMS');
    expect(out.recipient.phone).toBe('+14165551212');
    expect(out.content.body).not.toMatch(/^\[TEST REDIRECT\]/);
  });

  it('tenant.sendRedirectEnabled=true → redirect-ON (per-tenant explicit-true; default column value)', async () => {
    __setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => ({ sendRedirectEnabled: true })),
      },
    } as any);
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.email).toBe('fred@axisone.ca');
    expect(out.content.subject).toMatch(/^\[TEST REDIRECT — intended/);
  });

  // ── Fail-safe path: any failure → redirect-ON ──────────────────────
  it('FAIL-SAFE: missing tenantId on message → redirect-ON (no DB lookup attempted)', async () => {
    const mockFindUnique = vi.fn(async () => ({ sendRedirectEnabled: false }));
    __setPrismaForTest({ tenant: { findUnique: mockFindUnique } } as any);
    const msg = baseMsg();
    (msg as any).tenantId = undefined;
    const out = await applyRedirect(msg as any, 'EMAIL');
    expect(out.recipient.email).toBe('fred@axisone.ca'); // redirected
    expect(mockFindUnique).not.toHaveBeenCalled(); // short-circuit on missing tenantId
  });

  it('FAIL-SAFE: DB throws on tenant lookup → redirect-ON (a Redis-like blip pulls everyone to the test inbox)', async () => {
    __setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      },
    } as any);
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.email).toBe('fred@axisone.ca');
  });

  it('FAIL-SAFE: tenant row not found (null return) → redirect-ON', async () => {
    __setPrismaForTest({
      tenant: {
        findUnique: vi.fn(async () => null),
      },
    } as any);
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.email).toBe('fred@axisone.ca');
  });
});

describe('KAN-1005 M2-6a — env-true (global force-ON master) overrides per-tenant', () => {
  let applyRedirect: typeof import('../send-redirect.js').applyRedirect;
  let __setPrismaForTest: typeof import('../send-redirect.js').__setPrismaForTest;

  beforeEach(async () => {
    vi.resetModules();
    setEnv({
      SEND_REDIRECT_ENABLED: 'true', // global force-ON (incident lever / current PROD posture)
      SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
      SEND_REDIRECT_PHONE: '+15148359958',
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test',
      INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
    });
    const mod = await import('../send-redirect.js');
    applyRedirect = mod.applyRedirect;
    __setPrismaForTest = mod.__setPrismaForTest;
  });

  afterEach(() => {
    __setPrismaForTest(null);
  });

  it('env-true + tenant.sendRedirectEnabled=false → STILL redirects (force-global wins; the incident-response invariant)', async () => {
    // Even a tenant configured for real-send still redirects when the
    // global master is ON. This is the founder OQ#2 explicit-pin: the
    // env lever must be authoritative for incident response.
    const mockFindUnique = vi.fn(async () => ({ sendRedirectEnabled: false }));
    __setPrismaForTest({ tenant: { findUnique: mockFindUnique } } as any);
    const out = await applyRedirect(baseMsg() as any, 'EMAIL');
    expect(out.recipient.email).toBe('fred@axisone.ca');
    // Optimization: env-true short-circuits the DB lookup (no per-tenant
    // read needed because force-global is authoritative).
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

describe('KAN-1005 M2-6a — in-flight panic-flip (env true→false→true pin)', () => {
  // Pins the "decided at moment of send, not snapshotted" property.
  // A queued Pub/Sub message dispatched after ops flips env back to true
  // honors the flip immediately — the fresh DB+env read happens at send
  // time inside applyRedirect, not at decision time upstream.
  let __setPrismaForTest: typeof import('../send-redirect.js').__setPrismaForTest;

  afterEach(() => {
    if (__setPrismaForTest) __setPrismaForTest(null);
  });

  it('env flipped to true mid-flight → queued message redirects (in-flight panic-flip honored)', async () => {
    // T0: env=false, tenant=false → message would have been real-send
    vi.resetModules();
    setEnv({
      SEND_REDIRECT_ENABLED: 'false',
      SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
      SEND_REDIRECT_PHONE: '+15148359958',
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test',
      INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
    });
    let mod = await import('../send-redirect.js');
    __setPrismaForTest = mod.__setPrismaForTest;
    __setPrismaForTest({
      tenant: { findUnique: vi.fn(async () => ({ sendRedirectEnabled: false })) },
    } as any);
    const realSend = await mod.applyRedirect(baseMsg() as any, 'EMAIL');
    expect(realSend.recipient.email).toBe('real-customer@example.com'); // baseline: real send

    // T1: ops panic-flips env to true (incident response). NO redeploy
    // — env vars are read fresh on each module load. Simulate by
    // resetting modules with the new env.
    __setPrismaForTest(null);
    vi.resetModules();
    setEnv({
      SEND_REDIRECT_ENABLED: 'true',
      SEND_REDIRECT_EMAIL: 'fred@axisone.ca',
      SEND_REDIRECT_PHONE: '+15148359958',
      GCP_PROJECT_ID: 'test-project',
      DATABASE_URL: 'postgresql://test',
      INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(40),
    });
    mod = await import('../send-redirect.js');
    __setPrismaForTest = mod.__setPrismaForTest;
    // Same tenant disposition (false) — but env-true now force-globals.
    __setPrismaForTest({
      tenant: { findUnique: vi.fn(async () => ({ sendRedirectEnabled: false })) },
    } as any);
    const afterFlip = await mod.applyRedirect(baseMsg() as any, 'EMAIL');
    expect(afterFlip.recipient.email).toBe('fred@axisone.ca'); // redirected
    // Critical: the queued message (same tenant disposition) now lands
    // at the test inbox, not the real recipient. This is the in-flight
    // panic-flip safety property.
  });
});

describe('KAN-1005 M2-6a — resolveRedirectDisposition (pure precedence helper)', () => {
  it('env true → redirect-ON regardless of tenant value', async () => {
    const { resolveRedirectDisposition } = await import('../send-redirect.js');
    expect(resolveRedirectDisposition({ envEnabled: true, tenantDisposition: null }).redirectOn).toBe(true);
    expect(resolveRedirectDisposition({ envEnabled: true, tenantDisposition: false }).redirectOn).toBe(true);
    expect(resolveRedirectDisposition({ envEnabled: true, tenantDisposition: true }).redirectOn).toBe(true);
  });

  it('env false + tenant true → redirect-ON', async () => {
    const { resolveRedirectDisposition } = await import('../send-redirect.js');
    const r = resolveRedirectDisposition({ envEnabled: false, tenantDisposition: true });
    expect(r.redirectOn).toBe(true);
    expect(r.reason).toBe('tenant_explicit_true');
  });

  it('env false + tenant false → real send', async () => {
    const { resolveRedirectDisposition } = await import('../send-redirect.js');
    const r = resolveRedirectDisposition({ envEnabled: false, tenantDisposition: false });
    expect(r.redirectOn).toBe(false);
    expect(r.reason).toBe('tenant_explicit_false');
  });

  it('env false + tenant null (missing/error) → redirect-ON (fail-safe)', async () => {
    const { resolveRedirectDisposition } = await import('../send-redirect.js');
    const r = resolveRedirectDisposition({ envEnabled: false, tenantDisposition: null });
    expect(r.redirectOn).toBe(true);
    expect(r.reason).toBe('fail_safe_no_tenant_disposition');
  });

  it('reason attribution distinguishes the three force-ON paths (env_force_global vs tenant_explicit_true vs fail_safe)', async () => {
    const { resolveRedirectDisposition } = await import('../send-redirect.js');
    expect(resolveRedirectDisposition({ envEnabled: true, tenantDisposition: false }).reason).toBe('env_force_global');
    expect(resolveRedirectDisposition({ envEnabled: false, tenantDisposition: true }).reason).toBe('tenant_explicit_true');
    expect(resolveRedirectDisposition({ envEnabled: false, tenantDisposition: null }).reason).toBe('fail_safe_no_tenant_disposition');
  });
});
