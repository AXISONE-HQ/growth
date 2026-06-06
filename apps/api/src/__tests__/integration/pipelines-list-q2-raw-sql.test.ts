/**
 * KAN-1112 retrofit test — pipelines.list Q2 raw-SQL avgConfidence aggregation.
 *
 * **What this test demonstrates**:
 *
 * This file is RUNNABLE DOCUMENTATION of the KAN-1111 failure mode. Pre-fix,
 * `pipelines.list` Q2 contained an explicit `::uuid` cast on `d.tenant_id` /
 * `d.contact_id` / `deal.contact_id`. Those columns are PostgreSQL `text` (Prisma
 * `String` → `text` by default). Postgres rejects the comparison with
 * `42883 — operator does not exist: text = uuid`, every Pipeline Health endpoint
 * 500'd at PROD.
 *
 * The unit-level mock at `apps/web/src/app/dashboard/__tests__/page.test.tsx`
 * PASSED — `vi.mocked(prisma.$queryRaw).mockResolvedValue([...])` validated the
 * RESPONSE shape but never exercised the SQL against a real Postgres. CI was
 * green; PROD was red.
 *
 * Per the KAN-1089→KAN-1111→KAN-1115 cluster discipline memo
 * (`feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md`):
 * **any new `$queryRaw` in a procedure MUST ship with at least one integration
 * test that executes the SQL against real Postgres**.
 *
 * **Test structure**:
 *
 * 1. `executes the canonical query without 42883 type-cast error` — runs the
 *    post-fix SQL verbatim against real Postgres + asserts no throw.
 * 2. `would have caught the ::uuid cast bug` — runs the PRE-fix SQL verbatim
 *    against real Postgres + asserts the 42883 error fires. This is the
 *    failure-mode demonstration the KAN-1112 ticket explicitly requested.
 * 3. `returns expected avgConfidence shape for a tenant with Decision + Deal
 *    rows` — end-to-end fixture exercise asserting the projection shape +
 *    aggregation math.
 */
import { describe, expect, it } from 'vitest';
import {
  createContact,
  createDeal,
  createDecision,
  createPipeline,
  createTenant,
  withRollback,
} from './setup.js';

describe('KAN-1111 — pipelines.list Q2 avgConfidence raw SQL', () => {
  it('executes the canonical (post-fix) query without 42883 type-cast error', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // POST-FIX canonical SQL — no ::uuid casts. Matches router.ts L4573-4586
      // verbatim. Asserting it executes without throw is the runnable-doc
      // proof that the syntax is Postgres-compatible.
      await expect(
        prisma.$queryRaw<Array<{ pipelineId: string; avg_confidence: number }>>`
          SELECT
            deal.pipeline_id AS "pipelineId",
            AVG(d.confidence)::float AS avg_confidence
          FROM decisions d
          JOIN deals deal
            ON d.contact_id = deal.contact_id
            AND deal.tenant_id = d.tenant_id
          WHERE d.tenant_id = ${tenant.id}
            AND d.created_at > ${sevenDaysAgo}
            AND deal.status = 'open'
            AND deal.deleted_at IS NULL
          GROUP BY deal.pipeline_id
        `,
      ).resolves.toBeDefined();
    });
  });

  it('would have caught the ::uuid cast bug (KAN-1111 failure-mode demonstration)', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // PRE-FIX broken SQL — the ::uuid cast on d.tenant_id (text column)
      // raises 42883 against real Postgres. Mocked unit tests never exercised
      // this; CI green, PROD red. This test asserts the failure fires, which
      // is the runnable-documentation proof that integration coverage would
      // have caught KAN-1111 before deploy.
      await expect(
        prisma.$queryRawUnsafe(
          `
          SELECT
            deal.pipeline_id AS "pipelineId",
            AVG(d.confidence)::float AS avg_confidence
          FROM decisions d
          JOIN deals deal
            ON d.contact_id::uuid = deal.contact_id::uuid
            AND deal.tenant_id::uuid = d.tenant_id::uuid
          WHERE d.tenant_id::uuid = $1::uuid
            AND d.created_at > $2
            AND deal.status = 'open'
            AND deal.deleted_at IS NULL
          GROUP BY deal.pipeline_id
          `,
          tenant.id,
          sevenDaysAgo,
        ),
      ).rejects.toThrow(/42883|operator does not exist/i);
    });
  });

  it('returns expected avgConfidence shape for a tenant with Decision + Deal rows', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const contact = await createContact(prisma, tenant.id);
      const pipeline = await createPipeline(prisma, tenant.id);
      await createDeal(prisma, {
        tenantId: tenant.id,
        contactId: contact.id,
        pipelineId: pipeline.id,
        stageId: pipeline.stageId,
        status: 'open',
      });
      await createDecision(prisma, { tenantId: tenant.id, contactId: contact.id, confidence: 0.8 });
      await createDecision(prisma, { tenantId: tenant.id, contactId: contact.id, confidence: 0.6 });

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rows = await prisma.$queryRaw<
        Array<{ pipelineId: string; avg_confidence: number }>
      >`
        SELECT
          deal.pipeline_id AS "pipelineId",
          AVG(d.confidence)::float AS avg_confidence
        FROM decisions d
        JOIN deals deal
          ON d.contact_id = deal.contact_id
          AND deal.tenant_id = d.tenant_id
        WHERE d.tenant_id = ${tenant.id}
          AND d.created_at > ${sevenDaysAgo}
          AND deal.status = 'open'
          AND deal.deleted_at IS NULL
        GROUP BY deal.pipeline_id
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0]!.pipelineId).toBe(pipeline.id);
      expect(rows[0]!.avg_confidence).toBeCloseTo(0.7, 2);
    });
  });
});
