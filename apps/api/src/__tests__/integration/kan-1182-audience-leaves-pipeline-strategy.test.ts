/**
 * KAN-1182 — Real-Postgres integration test for the 5 new AudienceConditions
 * leaves + Pipeline.strategy additive column + 4 additive indexes.
 *
 * Per the `feedback_query_raw_sql_syntax_validation_must_execute_not_mock`
 * discipline + the KAN-1112 substrate, every additive schema change AND
 * every new audience-leaf SHIPS with at least one real-Postgres scenario
 * (mocked Prisma can't catch enum / index / FK / WHERE-clause syntax
 * mistakes).
 *
 * Scenarios:
 *   1. regionLeaf — Contact in/out of region filter
 *   2. cityLeaf — Contact in/out of city filter
 *   3. dealValue.between — USD-only deals in range; non-USD excluded
 *   4. dealValue.gte / dealValue.lte — boundary cases
 *   5. orders.refundedAt — sparse-index date-range filter; never-refunded
 *      orders excluded
 *   6. orders.cancelledAt — same pattern as refundedAt
 *   7. Composite "Lead created at" (Q-ADD B) — allOf of lifecycleStage +
 *      createdAt; only currently-lead contacts in the window included
 *   8. Pipeline.strategy backwards-compat — pre-migration Pipelines have
 *      strategy=NULL; new Campaigns can write per-Pipeline strategies
 *   9. Cross-tenant isolation — all filters scoped to tenantId
 */
import { describe, expect, it } from 'vitest';
import {
  createTenant,
  createContact,
  withRollback,
} from './setup.js';

// KAN-689 cohort — variable-specifier dynamic imports keep helpers out of
// the apps/api rootDir static graph.
const audienceRouterSpec =
  '../../../../../packages/api/src/services/audience-router.js';

type CountAudienceFn = (
  prisma: unknown,
  tenantId: string,
  input: { conditions: unknown },
) => Promise<{ count: number; isThin: boolean; historicalValueUsd: number }>;

interface AudienceRouterModule {
  countAudience: CountAudienceFn;
}

let _audienceRouter: AudienceRouterModule | null = null;
async function loadAudienceRouter(): Promise<AudienceRouterModule> {
  if (_audienceRouter) return _audienceRouter;
  _audienceRouter = (await import(audienceRouterSpec)) as AudienceRouterModule;
  return _audienceRouter;
}

describe('KAN-1182 — 5 new audience leaves + Pipeline.strategy substrate', () => {
  it('regionLeaf — Contact in/out of region filter', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `ca-${Date.now()}@test.local`,
          region: 'CA',
        },
      });
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `ny-${Date.now()}@test.local`,
          region: 'NY',
        },
      });
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `bc-${Date.now()}@test.local`,
          region: 'BC',
        },
      });

      const { countAudience } = await loadAudienceRouter();
      const result = await countAudience(prisma, tenant.id, {
        conditions: { field: 'region', op: 'in', values: ['CA', 'NY'] },
      });

      expect(result.count).toBe(2);
    });
  });

  it('cityLeaf — Contact in/out of city filter', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `t1-${Date.now()}@test.local`,
          city: 'Toronto',
        },
      });
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `t2-${Date.now()}@test.local`,
          city: 'Toronto',
        },
      });
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `m1-${Date.now()}@test.local`,
          city: 'Montreal',
        },
      });

      const { countAudience } = await loadAudienceRouter();
      const result = await countAudience(prisma, tenant.id, {
        conditions: { field: 'city', op: 'in', values: ['Toronto'] },
      });

      expect(result.count).toBe(2);
    });
  });

  it('dealValue.between — USD-only deals in range; non-USD excluded', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      // Need a pipeline + stage to attach deals to
      const pipeline = await prisma.pipeline.create({
        data: {
          tenantId: tenant.id,
          name: `Pipeline ${Date.now()}`,
          objectiveType: 'book_appointment',
          stages: { create: { name: 'Start', order: 0, isInitial: true } },
        },
        include: { stages: true },
      });
      const stageId = pipeline.stages[0]!.id;

      const c1 = await createContact(prisma, tenant.id);
      const c2 = await createContact(prisma, tenant.id);
      const c3 = await createContact(prisma, tenant.id);

      // c1: USD 1000 (in range) → match
      await prisma.deal.create({
        data: {
          tenantId: tenant.id,
          contactId: c1.id,
          pipelineId: pipeline.id,
          currentStageId: stageId,
          value: 1000,
          currency: 'USD',
        },
      });
      // c2: EUR 1500 (would be in range, but wrong currency) → exclude
      await prisma.deal.create({
        data: {
          tenantId: tenant.id,
          contactId: c2.id,
          pipelineId: pipeline.id,
          currentStageId: stageId,
          value: 1500,
          currency: 'EUR',
        },
      });
      // c3: USD 50 (out of range) → exclude
      await prisma.deal.create({
        data: {
          tenantId: tenant.id,
          contactId: c3.id,
          pipelineId: pipeline.id,
          currentStageId: stageId,
          value: 50,
          currency: 'USD',
        },
      });

      const { countAudience } = await loadAudienceRouter();
      const result = await countAudience(prisma, tenant.id, {
        conditions: {
          field: 'deal.value.between',
          op: 'between',
          minUsd: 500,
          maxUsdExclusive: 2000,
        },
      });

      expect(result.count).toBe(1);
    });
  });

  it('orders.refundedAt — sparse-index date-range; never-refunded orders excluded', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const c1 = await createContact(prisma, tenant.id);
      const c2 = await createContact(prisma, tenant.id);
      const c3 = await createContact(prisma, tenant.id);

      // c1: refunded in window → match
      await prisma.order.create({
        data: {
          tenantId: tenant.id,
          contactId: c1.id,
          orderNumber: `O-1-${Date.now()}`,
          refundedAt: new Date('2026-02-15T00:00:00.000Z'),
        },
      });
      // c2: refunded outside window → exclude
      await prisma.order.create({
        data: {
          tenantId: tenant.id,
          contactId: c2.id,
          orderNumber: `O-2-${Date.now()}`,
          refundedAt: new Date('2025-12-01T00:00:00.000Z'),
        },
      });
      // c3: never refunded (refundedAt=null) → exclude (sparse semantics)
      await prisma.order.create({
        data: {
          tenantId: tenant.id,
          contactId: c3.id,
          orderNumber: `O-3-${Date.now()}`,
        },
      });

      const { countAudience } = await loadAudienceRouter();
      const result = await countAudience(prisma, tenant.id, {
        conditions: {
          field: 'orders.refundedAt',
          op: 'between',
          fromUtc: '2026-01-01T00:00:00.000Z',
          toUtcExclusive: '2026-04-01T00:00:00.000Z',
        },
      });

      expect(result.count).toBe(1);
    });
  });

  it('orders.cancelledAt — sparse-index date-range; never-cancelled excluded', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const c1 = await createContact(prisma, tenant.id);
      const c2 = await createContact(prisma, tenant.id);

      await prisma.order.create({
        data: {
          tenantId: tenant.id,
          contactId: c1.id,
          orderNumber: `O-c1-${Date.now()}`,
          cancelledAt: new Date('2026-02-15T00:00:00.000Z'),
        },
      });
      await prisma.order.create({
        data: {
          tenantId: tenant.id,
          contactId: c2.id,
          orderNumber: `O-c2-${Date.now()}`,
          // cancelledAt=null
        },
      });

      const { countAudience } = await loadAudienceRouter();
      const result = await countAudience(prisma, tenant.id, {
        conditions: {
          field: 'orders.cancelledAt',
          op: 'between',
          fromUtc: '2026-01-01T00:00:00.000Z',
          toUtcExclusive: '2026-04-01T00:00:00.000Z',
        },
      });

      expect(result.count).toBe(1);
    });
  });

  it('composite "Lead created at" (Q-ADD B) — allOf of lifecycleStage + createdAt', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);

      // lead in window → match
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `lead-in-${Date.now()}@test.local`,
          lifecycleStage: 'lead',
          createdAt: new Date('2026-02-15T00:00:00.000Z'),
        },
      });
      // lead outside window → exclude
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `lead-out-${Date.now()}@test.local`,
          lifecycleStage: 'lead',
          createdAt: new Date('2025-12-01T00:00:00.000Z'),
        },
      });
      // customer in window (was lead, progressed) → exclude per Q-ADD B
      // Option 1 derived semantics (covers "recent leads I haven't
      // converted yet"; historical lead-cohort analytics deferred to KAN-1193)
      await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          email: `cust-in-${Date.now()}@test.local`,
          lifecycleStage: 'customer',
          createdAt: new Date('2026-02-15T00:00:00.000Z'),
        },
      });

      const { countAudience } = await loadAudienceRouter();
      const result = await countAudience(prisma, tenant.id, {
        conditions: {
          allOf: [
            { field: 'lifecycleStage', op: 'in', values: ['lead'] },
            {
              field: 'createdAt',
              op: 'between',
              fromUtc: '2026-01-01T00:00:00.000Z',
              toUtcExclusive: '2026-04-01T00:00:00.000Z',
            },
          ],
        },
      });

      expect(result.count).toBe(1);
    });
  });

  it('Pipeline.strategy backwards-compat — nullable default; per-Pipeline write succeeds', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);

      // Legacy single-Pipeline Campaign — strategy NULL on Pipeline
      const legacyPipeline = await prisma.pipeline.create({
        data: {
          tenantId: tenant.id,
          name: `Legacy ${Date.now()}`,
          objectiveType: 'book_appointment',
          stages: { create: { name: 'Start', order: 0, isInitial: true } },
        },
      });
      expect(legacyPipeline.strategy).toBeNull();

      // New multi-Pipeline Campaign — distinct per-Pipeline strategies
      const upsellPipeline = await prisma.pipeline.create({
        data: {
          tenantId: tenant.id,
          name: `Upsell ${Date.now()}`,
          objectiveType: 'book_appointment',
          strategy: 'direct',
          stages: { create: { name: 'Start', order: 0, isInitial: true } },
        },
      });
      const winbackPipeline = await prisma.pipeline.create({
        data: {
          tenantId: tenant.id,
          name: `Winback ${Date.now()}`,
          objectiveType: 'book_appointment',
          strategy: 'trust_build',
          stages: { create: { name: 'Start', order: 0, isInitial: true } },
        },
      });

      expect(upsellPipeline.strategy).toBe('direct');
      expect(winbackPipeline.strategy).toBe('trust_build');
    });
  });

  it('cross-tenant isolation — region filter never leaks across tenants', async () => {
    await withRollback(async (prisma) => {
      const tenantA = await createTenant(prisma);
      const tenantB = await createTenant(prisma);

      await prisma.contact.create({
        data: {
          tenantId: tenantA.id,
          email: `a-${Date.now()}@test.local`,
          region: 'CA',
        },
      });
      // Same region but tenant B — must not appear in A's count
      await prisma.contact.create({
        data: {
          tenantId: tenantB.id,
          email: `b-${Date.now()}@test.local`,
          region: 'CA',
        },
      });

      const { countAudience } = await loadAudienceRouter();
      const result = await countAudience(prisma, tenantA.id, {
        conditions: { field: 'region', op: 'in', values: ['CA'] },
      });

      expect(result.count).toBe(1);
    });
  });
});
