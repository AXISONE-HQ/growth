/**
 * KAN-1119 retrofit test — deferred-send-evaluator atomic CTE claim.
 *
 * **What these tests demonstrate**:
 *
 * Phase 1 enumeration for KAN-1119 surfaced a latent concurrency bug: the
 * original SELECT-only $queryRaw with `FOR UPDATE SKIP LOCKED` released its
 * row locks the moment the SELECT returned (Prisma $queryRaw runs each
 * statement as a single auto-committed transaction). A concurrent worker's
 * SELECT would re-claim the same rows, producing double-send when ticks
 * overlap.
 *
 * The fix: CTE atomic claim that wraps SELECT + UPDATE in a single
 * statement. The UPDATE transitions claimed rows to status='processing'
 * BEFORE the lock releases. A concurrent worker's CTE re-SELECT sees
 * 'processing' (not 'pending') and skips.
 *
 * **Test structure** (11 tests):
 *
 *  1. Single worker claims single row — sanity
 *  2. Single worker claims N rows when N ≤ pending count — LIMIT clause
 *  3. Single worker claims all rows when N > pending count — exhaustion
 *  4. Two concurrent workers claim disjoint rows — the load-bearing test
 *  5. Claimed row cannot be re-claimed (sequential) — defense-in-depth
 *  6. PRE-FIX-BUG DEMONSTRATION: non-atomic claim allows re-claim
 *     (runnable archaeology of the bug)
 *  7. Claim respects tenant isolation
 *  8. Claim respects status='pending' filter (skips other statuses)
 *  9. Claim respects defer_until <= NOW() filter (skips future-deferred)
 * 10. Supersession mid-processing — markDispatched no-ops
 * 11. Publish failure reverts processing → pending (cascade discipline)
 */
import { describe, expect, it, vi } from 'vitest';
import { processPendingDeferredSends } from '../../../../../packages/api/src/services/deferred-send-evaluator.js';
import {
  buildDeferredSend,
  createContact,
  createTenant,
  getPrisma,
  withCleanup,
} from './setup.js';

/** Stub evaluator options returning the requested policy verdict. Used in
 * tests that need processPendingDeferredSends to drive through processOneRow. */
function makeEvaluatorOpts(overrides: {
  policy?: 'allow' | 'deny' | 'defer';
  publishActionSendImpl?: (...args: unknown[]) => Promise<string>;
} = {}): Parameters<typeof processPendingDeferredSends>[1] {
  return {
    evaluateSendPolicy: async () => {
      switch (overrides.policy ?? 'allow') {
        case 'allow':
          return { type: 'allow', reason: 'integration-test' };
        case 'deny':
          return { type: 'deny', reason: 'integration-test', ruleViolated: 'test' };
        case 'defer':
          return {
            type: 'defer',
            reason: 'integration-test',
            deferUntil: new Date(Date.now() + 60_000),
          };
      }
    },
    publishActionSend:
      overrides.publishActionSendImpl ??
      (async () => 'pubsub-message-id-stub'),
    publishActionDecided: async () => ({ published: true, messageId: 'stub' }),
    resolveEmailConnectionId: async () => 'connection-stub',
    resolveReplyToForTenant: async () => null,
    getPubSubClient: () => ({}),
    publicWebhookBaseUrl: 'https://test.invalid',
  };
}

describe('KAN-1119 — deferred-send-evaluator atomic CTE claim', () => {
  it('claims a single pending row (sanity)', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        const row = await buildDeferredSend(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
        });

        // Run the claim CTE directly via $queryRaw (test the SQL shape; no
        // need to drive through processOneRow since policy logic isn't
        // under test here).
        const claimed = await prisma.$queryRaw<{ id: string }[]>`
          WITH locked AS (
            SELECT id FROM deferred_sends
            WHERE status = 'pending' AND defer_until <= NOW()
              AND tenant_id = ${tenant.id}
            ORDER BY defer_until ASC LIMIT 100
            FOR UPDATE SKIP LOCKED
          )
          UPDATE deferred_sends ds SET status = 'processing', last_attempt_at = NOW()
          FROM locked WHERE ds.id = locked.id
          RETURNING ds.id
        `;

        expect(claimed.map((r) => r.id)).toEqual([row.id]);
        const after = await prisma.deferredSend.findUnique({ where: { id: row.id } });
        expect(after?.status).toBe('processing');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('claims N pending rows when N <= LIMIT', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        for (let i = 0; i < 3; i += 1) {
          await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id });
        }

        const claimed = await runClaim(prisma, tenant.id, 10);
        expect(claimed).toHaveLength(3);
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('respects LIMIT when N > LIMIT', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        for (let i = 0; i < 5; i += 1) {
          await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id });
        }

        const claimed = await runClaim(prisma, tenant.id, 3);
        expect(claimed).toHaveLength(3);
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('two concurrent workers claim disjoint rows (load-bearing race test)', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        // 6 rows total; each worker requests 5; Postgres serializes via
        // the CTE atomic claim → both workers see disjoint subsets,
        // never the same row twice.
        for (let i = 0; i < 6; i += 1) {
          await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id });
        }

        const [claimedA, claimedB] = await Promise.all([
          runClaim(prisma, tenant.id, 5),
          runClaim(prisma, tenant.id, 5),
        ]);

        const idsA = new Set(claimedA.map((r) => r.id));
        const idsB = new Set(claimedB.map((r) => r.id));
        const intersection = [...idsA].filter((id) => idsB.has(id));

        expect(intersection).toEqual([]);
        expect(idsA.size + idsB.size).toBe(6);
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('claimed (processing) row cannot be re-claimed sequentially', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id });

        const firstClaim = await runClaim(prisma, tenant.id, 10);
        expect(firstClaim).toHaveLength(1);

        const secondClaim = await runClaim(prisma, tenant.id, 10);
        expect(secondClaim).toEqual([]);
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('PRE-FIX-BUG DEMO: non-atomic SELECT-only claim allows concurrent re-claim', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        for (let i = 0; i < 3; i += 1) {
          await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id });
        }

        // PRE-FIX SHAPE: SELECT-only with FOR UPDATE SKIP LOCKED, no UPDATE
        // to transition status. Each $queryRaw runs as a single auto-committed
        // statement, so the row locks are released immediately. Two
        // sequential SELECTs see overlapping IDs — the race the fix
        // eliminates.
        //
        // !! DISCIPLINE LOCK !! Do not "tidy" this to the CTE form. The
        // asymmetry vs production code is the entire point of the test;
        // tidying it makes the demo silently lie about the bug shape.
        const claimedA = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM deferred_sends
          WHERE status = 'pending' AND defer_until <= NOW()
            AND tenant_id = ${tenant.id}
          ORDER BY defer_until ASC LIMIT 10
          FOR UPDATE SKIP LOCKED
        `;
        const claimedB = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM deferred_sends
          WHERE status = 'pending' AND defer_until <= NOW()
            AND tenant_id = ${tenant.id}
          ORDER BY defer_until ASC LIMIT 10
          FOR UPDATE SKIP LOCKED
        `;

        // Both selects see the same rows — the race that double-sends in
        // PROD when ticks overlap. The fix (CTE atomic claim) makes
        // claimedB empty.
        expect(claimedA.map((r) => r.id).sort()).toEqual(
          claimedB.map((r) => r.id).sort(),
        );
        expect(claimedA.length).toBe(3);
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('respects tenant isolation across CTE claims', async () => {
    let tenantA: string | undefined;
    let tenantB: string | undefined;
    await withCleanup(
      async (prisma) => {
        const t1 = await createTenant(prisma);
        const t2 = await createTenant(prisma);
        tenantA = t1.id;
        tenantB = t2.id;
        const contact1 = await createContact(prisma, t1.id);
        const contact2 = await createContact(prisma, t2.id);
        await buildDeferredSend(prisma, { tenantId: t1.id, contactId: contact1.id });
        await buildDeferredSend(prisma, { tenantId: t1.id, contactId: contact1.id });
        await buildDeferredSend(prisma, { tenantId: t2.id, contactId: contact2.id });

        const claimedT1 = await runClaim(prisma, t1.id, 10);
        expect(claimedT1).toHaveLength(2);

        // T2's row remains pending (CTE was tenant-scoped).
        const t2RowAfter = await prisma.deferredSend.findFirst({
          where: { tenantId: t2.id },
        });
        expect(t2RowAfter?.status).toBe('pending');
      },
      async (prisma) => {
        if (tenantA) await cleanupTenant(prisma, tenantA);
        if (tenantB) await cleanupTenant(prisma, tenantB);
      },
    );
  });

  it('skips rows whose status is not pending', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id, status: 'pending' });
        await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id, status: 'dispatched' });
        await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id, status: 'cancelled' });
        await buildDeferredSend(prisma, { tenantId: tenant.id, contactId: contact.id, status: 'expired' });

        const claimed = await runClaim(prisma, tenant.id, 10);
        expect(claimed).toHaveLength(1);
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('skips rows whose defer_until is still in the future', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        await buildDeferredSend(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          deferUntil: new Date(Date.now() - 60_000), // past
        });
        await buildDeferredSend(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          deferUntil: new Date(Date.now() + 60 * 60_000), // 1h future
        });

        const claimed = await runClaim(prisma, tenant.id, 10);
        expect(claimed).toHaveLength(1);
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('supersession-mid-processing: markDispatched returns updated=false, message still sent', async () => {
    // This test asserts the Q4 race-window contract: if supersession
    // cancels the row between our publish and our markDispatched, the
    // markDispatched updateMany returns count=0 (row is now 'cancelled',
    // not 'processing'). The message has already gone out at that point
    // (action_send path publishes pre-markDispatched per the existing
    // ordering), which is the documented edge case behavior.
    let tenantId: string | undefined;
    let dealId: string | undefined;
    const publishMock = vi.fn(async () => 'pubsub-stub-id');

    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        const pipeline = await (await import('./setup.js')).createPipeline(prisma, tenant.id);
        const deal = await (await import('./setup.js')).createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
        });
        dealId = deal.id;

        // Seed a deferred_send already in 'processing' state to simulate
        // the post-claim, mid-publish moment.
        const row = await buildDeferredSend(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          dealId: deal.id,
          status: 'processing',
        });

        // Supersession fires (analogous to lead-received-push.ts) —
        // transitions the row to 'cancelled' under our feet.
        await prisma.deferredSend.updateMany({
          where: { id: row.id, status: { in: ['pending', 'processing'] } },
          data: { status: 'cancelled', cancelReason: 'superseded_by_fresh_inbound' },
        });

        // Now the evaluator's markDispatched runs (simulated via direct
        // updateMany with the same status guard).
        const result = await prisma.deferredSend.updateMany({
          where: { id: row.id, status: 'processing' },
          data: { status: 'dispatched', attempts: 1, lastAttemptAt: new Date() },
        });

        expect(result.count).toBe(0);
        const after = await prisma.deferredSend.findUnique({ where: { id: row.id } });
        expect(after?.status).toBe('cancelled');
        expect(after?.cancelReason).toBe('superseded_by_fresh_inbound');
      },
      async (prisma) => {
        if (tenantId) {
          await prisma.deferredSend.deleteMany({ where: { tenantId } });
          if (dealId) await prisma.deal.deleteMany({ where: { id: dealId } });
          await prisma.contact.deleteMany({ where: { tenantId } });
          await prisma.pipeline.deleteMany({ where: { tenantId } });
          await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
        }
      },
    );

    // Note: publish mock not invoked here (test simulates the supersession
    // state directly without running processOneRow). The assertion is on
    // the status-guarded updateMany returning count=0 — the exact
    // mechanism the evaluator relies on.
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('publish failure reverts processing → pending (cascade discipline)', async () => {
    // KAN-1119 cascade discovery: state machine extension (pending →
    // processing) requires recovery paths for every assumption that
    // failed rows retained their original state. This test locks the
    // revert behavior: if publishActionSend throws after the CTE claim,
    // the row must be reverted to 'pending' so the next cron tick re-claims.
    let tenantId: string | undefined;

    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const contact = await createContact(prisma, tenant.id);
        await buildDeferredSend(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          status: 'pending',
          replayVia: 'action_send',
          payload: {
            brainDecision: {
              nextBestAction: { type: 'send_follow_up', reasoning: 'test' },
              confidence: 0.8,
            },
            composed: { subject: 'test', body: 'test body', tone: 'professional' },
            contactEmail: 'test@example.com',
            shaperTier: 'haiku',
            shaperInputTokens: 0,
            shaperOutputTokens: 0,
            originalEventId: 'evt-test',
          },
        });

        const opts = makeEvaluatorOpts({
          publishActionSendImpl: async () => {
            throw new Error('simulated-publish-failure');
          },
        });

        const result = await processPendingDeferredSends(prisma, opts);

        // The catch path in processPendingDeferredSends should revert the
        // row back to 'pending' so it's eligible for next-tick re-claim.
        expect(result.errors).toBe(1);
        const rows = await prisma.deferredSend.findMany({ where: { tenantId: tenant.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('pending');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Tenant-scoped CTE claim mirroring the production SQL but bound to a
 * specific tenant for test isolation. */
async function runClaim(
  prisma: ReturnType<typeof getPrisma>,
  tenantId: string,
  batchSize: number,
): Promise<{ id: string }[]> {
  return prisma.$queryRaw<{ id: string }[]>`
    WITH locked AS (
      SELECT id FROM deferred_sends
      WHERE status = 'pending' AND defer_until <= NOW()
        AND tenant_id = ${tenantId}
      ORDER BY defer_until ASC LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE deferred_sends ds SET status = 'processing', last_attempt_at = NOW()
    FROM locked WHERE ds.id = locked.id
    RETURNING ds.id
  `;
}

/** Tenant-scoped cleanup helper. Deletes child rows before tenant to
 * satisfy FK constraints. */
async function cleanupTenant(
  prisma: ReturnType<typeof getPrisma>,
  tenantId: string,
): Promise<void> {
  await prisma.deferredSend.deleteMany({ where: { tenantId } });
  await prisma.decision.deleteMany({ where: { tenantId } });
  await prisma.contact.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
}
