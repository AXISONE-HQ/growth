/**
 * Unit tests for the Svix middleware (KAN-684).
 *
 * Verifier is injected so no real svix crypto runs in tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { buildSvixMiddleware, getSvixContext, type SvixVerifyFn } from '../svix.js';

const SECRET = 'whsec_test_signing_secret';

function buildAppWith(
  verifier: SvixVerifyFn,
  opts: { signingSecret?: string | undefined; useDefaultSecret?: boolean } = { useDefaultSecret: true },
) {
  const app = new Hono();
  // Distinguish "no secret passed at all" from "explicit undefined".
  const mwOpts: { verifier: SvixVerifyFn; signingSecret?: string } = { verifier };
  if (opts.useDefaultSecret !== false) {
    mwOpts.signingSecret = opts.signingSecret ?? SECRET;
  }
  app.post('/hook', buildSvixMiddleware(mwOpts), (c) => {
    const sx = getSvixContext(c);
    return c.json({ ok: true, type: (sx.payload as { type?: string }).type, svixId: sx.svixId });
  });
  return app;
}

const VALID_HEADERS = {
  'svix-id': 'msg_2abcDEF',
  'svix-timestamp': String(Math.floor(Date.now() / 1000)),
  'svix-signature': 'v1,abcdef==',
};

beforeEach(() => {
  // Middleware bypass is process.env-driven elsewhere; svix has none, but
  // make sure we're not surprised by leftover env state.
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Svix middleware — accept', () => {
  it('valid signature → handler runs and sees the parsed payload + svix-id', async () => {
    const verifier: SvixVerifyFn = vi.fn(() => ({ type: 'email.delivered', data: { email_id: 'em_1' } }));
    const app = buildAppWith(verifier);
    const res = await app.request('/hook', {
      method: 'POST',
      headers: VALID_HEADERS,
      body: '{"type":"email.delivered"}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; type: string; svixId: string };
    expect(body).toEqual({ ok: true, type: 'email.delivered', svixId: 'msg_2abcDEF' });
    expect(verifier).toHaveBeenCalledTimes(1);
  });
});

describe('Svix middleware — reject', () => {
  it('invalid signature (verifier throws) → 400', async () => {
    const verifier: SvixVerifyFn = () => {
      throw new Error('signature mismatch');
    };
    const app = buildAppWith(verifier);
    const res = await app.request('/hook', {
      method: 'POST',
      headers: VALID_HEADERS,
      body: '{"type":"email.delivered"}',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('svix signature verification failed');
  });

  it('missing svix-id header → 400 + verifier never called', async () => {
    const verifier = vi.fn();
    const app = buildAppWith(verifier as unknown as SvixVerifyFn);
    const { 'svix-id': _omit, ...rest } = VALID_HEADERS;
    const res = await app.request('/hook', { method: 'POST', headers: rest, body: '{}' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('missing svix headers');
    expect(verifier).not.toHaveBeenCalled();
  });

  it('missing svix-timestamp header → 400', async () => {
    const verifier = vi.fn();
    const app = buildAppWith(verifier as unknown as SvixVerifyFn);
    const { 'svix-timestamp': _omit, ...rest } = VALID_HEADERS;
    const res = await app.request('/hook', { method: 'POST', headers: rest, body: '{}' });
    expect(res.status).toBe(400);
  });

  it('missing svix-signature header → 400', async () => {
    const verifier = vi.fn();
    const app = buildAppWith(verifier as unknown as SvixVerifyFn);
    const { 'svix-signature': _omit, ...rest } = VALID_HEADERS;
    const res = await app.request('/hook', { method: 'POST', headers: rest, body: '{}' });
    expect(res.status).toBe(400);
  });

  it('verifier returns non-object → 400', async () => {
    const verifier: SvixVerifyFn = () => 'this is not an object';
    const app = buildAppWith(verifier);
    const res = await app.request('/hook', {
      method: 'POST',
      headers: VALID_HEADERS,
      body: '"oops"',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('svix payload is not an object');
  });
});

describe('Svix middleware — config errors', () => {
  it('signing secret unset (env + opts both missing) → 503', async () => {
    const prior = process.env.RESEND_WEBHOOK_SIGNING_SECRET;
    delete process.env.RESEND_WEBHOOK_SIGNING_SECRET;
    try {
      const verifier: SvixVerifyFn = vi.fn();
      const app = buildAppWith(verifier, { useDefaultSecret: false });
      const res = await app.request('/hook', {
        method: 'POST',
        headers: VALID_HEADERS,
        body: '{}',
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('webhook verification unavailable');
      expect(verifier).not.toHaveBeenCalled();
    } finally {
      if (prior !== undefined) process.env.RESEND_WEBHOOK_SIGNING_SECRET = prior;
    }
  });
});
