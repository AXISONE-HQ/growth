/**
 * Tests for KAN-702 PR A.2 — fail-loud Firebase Admin verification.
 *
 * Coverage:
 *   - Bad / expired token in Authorization header → throws TRPCError UNAUTHORIZED
 *     (NOT a silent fallback to firebaseUser=null, which is what shipped before
 *      and which let bad tokens flow through protectedProcedure)
 *   - No Authorization header → firebaseUser stays null (anonymous public access)
 *   - Authorization header without Bearer prefix → firebaseUser stays null
 *
 * Design note: trpc.ts now calls `initializeApp({ credential: applicationDefault() })`
 * at module load. `applicationDefault()` returns a lazy credential factory; no
 * GCP call happens until verifyIdToken is invoked. So importing trpc.ts in a
 * test env without ADC is safe — the side effect is a Firebase App registration
 * but no network traffic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock firebase-admin/auth BEFORE importing trpc.ts so the module-level
// `getAuth()` call resolves to our spy.
const verifyIdTokenSpy = vi.fn();
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: verifyIdTokenSpy }),
}));

// Mock firebase-admin/app to a no-op so module-level initializeApp doesn't
// touch real ADC during the test.
vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  getApps: () => [],
  applicationDefault: () => ({}),
}));

const { createContext } = await import('../trpc.js');

function fakeReq(headers: Record<string, string>) {
  return {
    req: {
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      },
    },
  } as unknown as Parameters<typeof createContext>[0];
}

describe('createContext + Firebase verification (fail-loud)', () => {
  beforeEach(() => {
    verifyIdTokenSpy.mockReset();
  });

  it('throws TRPCError UNAUTHORIZED when verifyIdToken rejects (bad / expired token)', async () => {
    verifyIdTokenSpy.mockRejectedValueOnce(
      new Error('Firebase ID token has expired. Get a fresh ID token and try again.'),
    );
    const opts = fakeReq({
      authorization: 'Bearer fake.expired.token',
      'x-tenant-id': '11111111-1111-1111-1111-111111111111',
    });
    await expect(createContext(opts)).rejects.toBeInstanceOf(TRPCError);
    await expect(createContext(opts)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: expect.stringMatching(/invalid or expired/i),
    });
  });

  it('passes through with firebaseUser=null when no Authorization header is present', async () => {
    const ctx = await createContext(fakeReq({ 'x-tenant-id': 'tenant-x' }));
    expect(ctx.firebaseUser).toBeNull();
    expect(verifyIdTokenSpy).not.toHaveBeenCalled();
  });

  it('skips verification when Authorization header is not a Bearer token', async () => {
    const ctx = await createContext(
      fakeReq({ authorization: 'Basic abc123', 'x-tenant-id': 'tenant-x' }),
    );
    expect(ctx.firebaseUser).toBeNull();
    expect(verifyIdTokenSpy).not.toHaveBeenCalled();
  });

  it('returns the decoded user on a valid Bearer token', async () => {
    verifyIdTokenSpy.mockResolvedValueOnce({
      uid: 'uid-good',
      email: 'fred@axisone.ca',
    });
    const ctx = await createContext(
      fakeReq({ authorization: 'Bearer good.token', 'x-tenant-id': 'tenant-x' }),
    );
    expect(ctx.firebaseUser).toEqual({ uid: 'uid-good', email: 'fred@axisone.ca' });
  });
});
