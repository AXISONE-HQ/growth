/**
 * M3-2.5a — resolveActiveDealForContact + engine-path dealId enrichment tests.
 *
 * Pinned behaviors:
 *   - Helper picks most-recently-active open Deal for the contact
 *   - Helper returns null when no open Deal exists (back-compat for
 *     contacts that pre-date Lead Inbox or have no Deal yet)
 *   - Tenant scoping: lookup filtered by tenantId; cross-tenant Deal
 *     never returned
 *   - Multi-deal: orderBy enteredStageAt desc picks the most recently
 *     moved-on Deal (highest-likelihood-correct attribution)
 *   - Closed Deals (status != 'open') excluded
 *   - Structural pin: 3 engine sites all call the helper, no inline
 *     duplicates (grep-provable)
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resolveActiveDealForContact } from '../resolve-active-deal.js';

const TENANT = 'tenant-a';
const CONTACT = 'contact-1';
const REPO_ROOT = resolve(__dirname, '../../../../../');

function makePrisma(returns: { id: string } | null) {
  const findFirst = vi.fn(async () => returns);
  return {
    prisma: {
      deal: { findFirst },
    } as never,
    findFirst,
  };
}

describe('M3-2.5a — resolveActiveDealForContact helper', () => {
  it('returns Deal.id when an open Deal exists', async () => {
    const { prisma } = makePrisma({ id: 'deal-1' });
    const result = await resolveActiveDealForContact(prisma, TENANT, CONTACT);
    expect(result).toBe('deal-1');
  });

  it('returns null when no open Deal exists (back-compat for pre-Lead-Inbox contacts)', async () => {
    const { prisma } = makePrisma(null);
    const result = await resolveActiveDealForContact(prisma, TENANT, CONTACT);
    expect(result).toBeNull();
  });

  it('query filters by tenantId AND contactId AND status=open', async () => {
    const { prisma, findFirst } = makePrisma({ id: 'deal-1' });
    await resolveActiveDealForContact(prisma, TENANT, CONTACT);
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, contactId: CONTACT, status: 'open' },
      orderBy: { enteredStageAt: 'desc' },
      select: { id: true },
    });
  });

  it('multi-deal: most-recently-entered-stage Deal wins (orderBy enteredStageAt desc)', async () => {
    const { prisma, findFirst } = makePrisma({ id: 'deal-most-recent' });
    await resolveActiveDealForContact(prisma, TENANT, CONTACT);
    const callArg = findFirst.mock.calls[0]![0] as { orderBy: { enteredStageAt: string } };
    expect(callArg.orderBy.enteredStageAt).toBe('desc');
  });

  it('closed Deals excluded (status=open filter)', async () => {
    const { prisma, findFirst } = makePrisma(null);
    await resolveActiveDealForContact(prisma, TENANT, CONTACT);
    const callArg = findFirst.mock.calls[0]![0] as { where: { status: string } };
    expect(callArg.where.status).toBe('open');
  });
});

describe('M3-2.5a — structural pin: 3 engine sites call the helper, no inline duplicates', () => {
  it('run-decision-for-contact.ts loads resolveActiveDealForContact via variable-specifier dynamic import AND calls it 3+ times', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'packages/api/src/services/run-decision-for-contact.ts'),
      'utf-8',
    );
    // Variable-specifier dynamic import keeps the helper out of the apps/api
    // TS6059 cohort (see header comment near `loadResolveActiveDealForContact`).
    expect(src).toMatch(/loadResolveActiveDealForContact/);
    expect(src).toMatch(/['"]\.\/resolve-active-deal\.js['"]/);
    // 3 call sites must each materialize the helper + invoke it: 3
    // `await loadResolveActiveDealForContact()` loader calls + 3
    // `await resolveActiveDealForContact(prisma,...)` invocations.
    const loaderCalls = src.match(/loadResolveActiveDealForContact\(\)/g);
    expect(loaderCalls?.length).toBeGreaterThanOrEqual(3);
    const helperCalls = src.match(/\bresolveActiveDealForContact\(prisma/g);
    expect(helperCalls?.length).toBeGreaterThanOrEqual(3);
  });

  it('no inline duplicate of the helper-exact shape exists in run-decision-for-contact.ts', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'packages/api/src/services/run-decision-for-contact.ts'),
      'utf-8',
    );
    // Helper-exact discriminator: orderBy `enteredStageAt` + select `{ id: true }`
    // is the helper's distinctive shape. Different-purpose context lookups
    // (e.g. getCurrentDeal in buildContextDatabase loads pipelineId/stageId)
    // legitimately re-use prisma.deal.findFirst with status:'open' but pick
    // a different orderBy + select more columns — those aren't the drift
    // class we're guarding against. Helper's own file is exempt (engine grep).
    expect(src).not.toMatch(/enteredStageAt:\s*['"]desc['"]/);
  });
});
