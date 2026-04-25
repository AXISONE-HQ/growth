/**
 * Unit tests for the app-layer OIDC middleware (KAN-688).
 *
 * Verifier function is injected — no module mocks required, no real
 * google-auth-library calls. Each case constructs a one-route Hono app
 * with the middleware applied and a stub handler, then asserts the
 * response status + body shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { LoginTicket } from 'google-auth-library';
import { buildOidcMiddleware, type VerifyFn } from '../oidc.js';

const AUDIENCE = 'https://growth-connectors-biut5gfhuq-uc.a.run.app';
const EXPECTED_EMAIL = 'pubsub-invoker@growth-493400.iam.gserviceaccount.com';
const VALID_ISS = 'https://accounts.google.com';

interface FakePayload {
  iss: string;
  aud: string;
  email: string;
  exp?: number;
}

function fakeTicket(payload: FakePayload): LoginTicket {
  return { getPayload: () => payload } as unknown as LoginTicket;
}

function buildAppWith(verifier: VerifyFn) {
  const app = new Hono();
  app.use(
    '/pubsub/*',
    buildOidcMiddleware({ expectedAudience: AUDIENCE, expectedEmail: EXPECTED_EMAIL, verifier }),
  );
  app.post('/pubsub/action-send', (c) => c.json({ ok: true }));
  return app;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_SKIP = process.env.PUBSUB_PUSH_SKIP_AUTH;

beforeEach(() => {
  // The middleware bypasses verification when NODE_ENV === 'test'. These tests
  // verify the verification logic itself, so neutralize that bypass per-case.
  delete process.env.NODE_ENV;
  delete process.env.PUBSUB_PUSH_SKIP_AUTH;
});

afterEach(() => {
  if (ORIGINAL_NODE_ENV !== undefined) process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_SKIP !== undefined) process.env.PUBSUB_PUSH_SKIP_AUTH = ORIGINAL_SKIP;
});

describe('OIDC middleware — accept', () => {
  it('valid token from expected SA + correct audience → next() called', async () => {
    const verifier = vi.fn(async () =>
      fakeTicket({ iss: VALID_ISS, aud: AUDIENCE, email: EXPECTED_EMAIL }),
    );
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Bearer valid.id.token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith({ idToken: 'valid.id.token', audience: AUDIENCE });
  });
});

describe('OIDC middleware — reject', () => {
  it('valid token but wrong SA email → 401', async () => {
    const verifier: VerifyFn = async () =>
      fakeTicket({ iss: VALID_ISS, aud: AUDIENCE, email: 'attacker@example.com' });
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('oidc verification failed');
    expect(body.reason).toBe('wrong service account');
  });

  it('valid token but wrong audience → 401', async () => {
    const verifier: VerifyFn = async () =>
      fakeTicket({ iss: VALID_ISS, aud: 'https://other.run.app', email: EXPECTED_EMAIL });
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe('wrong audience');
  });

  it('wrong issuer → 401', async () => {
    const verifier: VerifyFn = async () =>
      fakeTicket({ iss: 'https://attacker.example/', aud: AUDIENCE, email: EXPECTED_EMAIL });
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe('wrong issuer');
  });

  it('invalid signature (verifier throws) → 401', async () => {
    const verifier: VerifyFn = async () => {
      throw new Error('Invalid token signature');
    };
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Bearer tampered.token' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      'invalid signature or expired token',
    );
  });

  it('expired token (verifier throws Token used too late) → 401', async () => {
    const verifier: VerifyFn = async () => {
      throw new Error('Token used too late');
    };
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Bearer expired.token' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      'invalid signature or expired token',
    );
  });

  it('no Authorization header → 401', async () => {
    const verifier: VerifyFn = vi.fn();
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe('no authorization header');
    expect(verifier).not.toHaveBeenCalled();
  });

  it('malformed Authorization header (no Bearer prefix) → 401', async () => {
    const verifier: VerifyFn = vi.fn();
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      'malformed authorization header',
    );
    expect(verifier).not.toHaveBeenCalled();
  });

  // Note: an "empty bearer token" branch exists in the middleware as defensive
  // code, but it's not testable via Hono's request helper — the Headers API
  // normalizes trailing whitespace, so 'Bearer ' becomes 'Bearer' and trips
  // the no-prefix check first. The defensive branch stays in the middleware
  // anyway for any future call site that bypasses the Headers normalization.

  it('verifier returns ticket with no payload → 401', async () => {
    const verifier: VerifyFn = async () =>
      ({ getPayload: () => undefined }) as unknown as LoginTicket;
    const app = buildAppWith(verifier);
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe('token has no payload');
  });
});

describe('OIDC middleware — bypass', () => {
  it('NODE_ENV=test bypasses verification entirely', async () => {
    process.env.NODE_ENV = 'test';
    const verifier = vi.fn();
    const app = buildAppWith(verifier as unknown as VerifyFn);
    const res = await app.request('/pubsub/action-send', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('PUBSUB_PUSH_SKIP_AUTH=true bypasses verification entirely', async () => {
    process.env.PUBSUB_PUSH_SKIP_AUTH = 'true';
    const verifier = vi.fn();
    const app = buildAppWith(verifier as unknown as VerifyFn);
    const res = await app.request('/pubsub/action-send', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(verifier).not.toHaveBeenCalled();
  });
});

describe('OIDC middleware — config errors', () => {
  it('returns 500 when audience is unset (env + opts both missing)', async () => {
    delete process.env.PUBLIC_WEBHOOK_BASE_URL;
    const verifier = vi.fn();
    const app = new Hono();
    app.use('/pubsub/*', buildOidcMiddleware({ expectedEmail: EXPECTED_EMAIL, verifier }));
    app.post('/pubsub/action-send', (c) => c.json({ ok: true }));
    const res = await app.request('/pubsub/action-send', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { reason: string }).reason).toBe('audience unset');
    expect(verifier).not.toHaveBeenCalled();
  });
});
