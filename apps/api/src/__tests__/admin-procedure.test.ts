/**
 * Tests for KAN-702 PR A.1 — adminProcedure env-var allowlist.
 *
 * Coverage:
 *   - Allowed email passes through (case-insensitive)
 *   - Non-allowlisted email → FORBIDDEN
 *   - Empty / unset ADMIN_EMAILS → default-deny (reject everyone)
 *   - Whitespace + casing in the env var are normalized
 *   - Missing firebaseUser.email → UNAUTHORIZED (precondition before allowlist)
 *
 * The middleware is exercised end-to-end by building a tiny tRPC router with
 * one adminProcedure mutation and invoking it via t.createCaller — same shape
 * the real routers use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router, createContext } from '../trpc.js';

// ─────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────

const testRouter = router({
  ping: adminProcedure.mutation(() => 'pong'),
});

type Caller = ReturnType<typeof testRouter.createCaller>;

function callerWith(opts: {
  email?: string | null;
  tenantId?: string | null;
}): Caller {
  // Minimal context shaped like createContext's return — adminProcedure only
  // reads firebaseUser.email + tenantId (latter via protectedProcedure).
  const ctx = {
    prisma: {} as any,
    tenantId: opts.tenantId ?? '11111111-1111-1111-1111-111111111111',
    firebaseUser: opts.email
      ? { uid: 'uid-test', email: opts.email }
      : null,
  } as Awaited<ReturnType<typeof createContext>>;
  return testRouter.createCaller(ctx);
}

const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
});

// ─────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────

describe('adminProcedure env-var allowlist', () => {
  it('allowed email passes through', async () => {
    process.env.ADMIN_EMAILS = 'fred@axisone.ca';
    const caller = callerWith({ email: 'fred@axisone.ca' });
    await expect(caller.ping()).resolves.toBe('pong');
  });

  it('case-insensitive match (mixed-case email vs lowercase env)', async () => {
    process.env.ADMIN_EMAILS = 'fred@axisone.ca';
    const caller = callerWith({ email: 'Fred@AxisOne.CA' });
    await expect(caller.ping()).resolves.toBe('pong');
  });

  it('non-allowlisted email → FORBIDDEN', async () => {
    process.env.ADMIN_EMAILS = 'fred@axisone.ca';
    const caller = callerWith({ email: 'attacker@example.com' });
    await expect(caller.ping()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('empty ADMIN_EMAILS → default-deny everyone', async () => {
    process.env.ADMIN_EMAILS = '';
    const caller = callerWith({ email: 'fred@axisone.ca' });
    await expect(caller.ping()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('unset ADMIN_EMAILS → default-deny everyone', async () => {
    delete process.env.ADMIN_EMAILS;
    const caller = callerWith({ email: 'fred@axisone.ca' });
    await expect(caller.ping()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('whitespace in env var is trimmed; multiple admins supported', async () => {
    process.env.ADMIN_EMAILS = '  fred@axisone.ca , alice@axisone.ca  ,  ';
    await expect(callerWith({ email: 'fred@axisone.ca' }).ping()).resolves.toBe('pong');
    await expect(callerWith({ email: 'alice@axisone.ca' }).ping()).resolves.toBe('pong');
    await expect(callerWith({ email: 'bob@axisone.ca' }).ping()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('empty entries in env var are filtered out (no accidental-allow on bare comma)', async () => {
    // Bug shape we're guarding against: `,,,` → `["", "", ""]` → `.includes("")`
    // would false-allow if email is empty. Filter removes empties before the check.
    process.env.ADMIN_EMAILS = ',,,fred@axisone.ca,,,';
    await expect(callerWith({ email: 'fred@axisone.ca' }).ping()).resolves.toBe('pong');
    // Empty-string email should not match even with the malformed env var.
    await expect(callerWith({ email: '' as any }).ping()).rejects.toBeInstanceOf(TRPCError);
  });

  it('missing firebaseUser.email → UNAUTHORIZED (precondition before allowlist)', async () => {
    process.env.ADMIN_EMAILS = 'fred@axisone.ca';
    const caller = callerWith({ email: null });
    await expect(caller.ping()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
