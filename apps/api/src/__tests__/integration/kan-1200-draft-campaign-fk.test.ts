/**
 * KAN-1200 — createDraftCampaign FK regression lock (REAL Prisma).
 *
 * Closes the test substrate gap that let KAN-1184 ship with a zero-UUID
 * objectiveId placeholder. The original orchestrator unit tests injected
 * a campaignId and never exercised the create path against real Prisma,
 * so the FK violation `campaigns_objective_id_fkey` only surfaced when
 * Fred ran the first end-to-end UI smoke in PROD after KAN-1190 deployed.
 *
 * This test exercises `createDraftCampaign()` against a real Postgres
 * transaction (rolled back). Failure mode if the fix regresses:
 *
 *   - schema reverts to `Campaign.objectiveId String` → Prisma validation
 *     fails OR FK violation
 *   - orchestrator reverts to zero-UUID placeholder → P2003 FK violation
 *
 * Either reversion fails this test in CI before the chat path reaches PROD.
 *
 * Substrate posture per memo `feedback_query_raw_sql_syntax_validation_
 * must_execute_not_mock.md` extended: persistence-write paths constrained
 * by FK / NOT NULL must include at least one test that EXECUTES against
 * real Postgres (mocked Prisma validates call shape, not constraint
 * compliance).
 *
 * Import posture (KAN-689 variable-specifier): the orchestrator lives in
 * packages/api/src which is outside apps/api's rootDir. Imported via
 * variable-specifier `await import(spec)` so the apps/api tsc rootDir
 * scope (TS6059) doesn't drag the orchestrator module in at compile time.
 */
import { describe, expect, it } from 'vitest';
import { createTenant, withRollback } from './setup.js';

const orchestratorSpec =
  '../../../../../packages/api/src/services/conversational-orchestrator.js';

interface OrchestratorModule {
  createDraftCampaign: (
    prisma: unknown,
    tenantId: string,
  ) => Promise<{ id: string }>;
}

describe('KAN-1200 — createDraftCampaign against real Prisma', () => {
  it('inserts a draft Campaign with objectiveId = NULL (no FK violation)', async () => {
    const { createDraftCampaign } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);

      const draft = await createDraftCampaign(prisma, tenant.id);

      expect(draft.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: draft.id },
        select: {
          id: true,
          tenantId: true,
          name: true,
          status: true,
          objectiveId: true,
          audienceConditions: true,
        },
      });

      // Assertions for the KAN-1200 fix surface:
      //   1. objectiveId NULL — schema change applied + orchestrator no
      //      longer passes the zero-UUID placeholder
      //   2. status='draft' — KAN-1184 draft-on-first-turn invariant
      //   3. tenantId echoed — tenant scoping preserved
      //   4. audienceConditions={} — orchestrator fills these in as
      //      dimensions confirm (KAN-1184 C3 lock)
      expect(row.objectiveId).toBeNull();
      expect(row.status).toBe('draft');
      expect(row.tenantId).toBe(tenant.id);
      expect(row.audienceConditions).toEqual({});
      expect(row.name).toBe('Draft Campaign');
    });
  });

  it('inserts multiple draft Campaigns under the same tenant (no UNIQUE collisions)', async () => {
    // Regression: previously the zero-UUID placeholder caused all drafts
    // to collide on the FK constraint. With NULL objectiveId, multiple
    // drafts per tenant are valid.
    const { createDraftCampaign } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);

      const draftA = await createDraftCampaign(prisma, tenant.id);
      const draftB = await createDraftCampaign(prisma, tenant.id);

      expect(draftA.id).not.toBe(draftB.id);

      const count = await prisma.campaign.count({
        where: { tenantId: tenant.id, status: 'draft', objectiveId: null },
      });
      expect(count).toBe(2);
    });
  });
});
