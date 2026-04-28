/**
 * Drift-prevention test for the ObjectiveType enum.
 *
 * Catches divergence between:
 *   - schema.prisma `enum ObjectiveType { ... }` (canonical)
 *   - apps/api/src/router.ts `ObjectiveTypeEnum = z.enum([...])` (hand-mirror
 *     used at the tRPC boundary)
 *
 * Failure mode this guards against: someone adds a value to schema.prisma
 * + runs `prisma migrate dev` but forgets to update the zod mirror, OR
 * vice-versa. Either way, the boundary rejects valid inputs (or accepts
 * invalid ones).
 *
 * Filed alongside KAN-702 PR B's enum-mismatch fix-forward — the bug Fred
 * caught wasn't this kind of drift (it was frontend ↔ backend), but the
 * same shape of audit applies. KAN-719 will extract a shared types
 * package which will subsume the apps/web side of this protection.
 */
import { describe, it, expect } from 'vitest';
import { ObjectiveType } from '@prisma/client';

describe('ObjectiveType enum drift (schema.prisma ↔ apps/api zod mirror)', () => {
  it('zod ObjectiveTypeEnum.options exactly matches Prisma ObjectiveType values', async () => {
    // Dynamic import so the test file doesn't pull router.ts into the
    // apps/connectors vitest static graph (router.ts has the KAN-689 cohort
    // TS6059 errors which would block compilation here).
    const { ObjectiveTypeEnum } = await import('../router.js');
    const zodValues = [...ObjectiveTypeEnum.options].sort();
    const prismaValues = Object.values(ObjectiveType).sort();
    expect(zodValues).toEqual(prismaValues);
  });
});
