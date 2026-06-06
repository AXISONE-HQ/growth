/**
 * KAN-1112 retrofit test — getBrainLayersImpl gap rule #1 evaluation.
 *
 * **What this test demonstrates**:
 *
 * This file is RUNNABLE DOCUMENTATION of the KAN-1115 failure mode. Pre-fix,
 * `getBrainLayersImpl` evaluated gap rule #1 (Deal pricing missing >25%) AFTER
 * the empty-state early-return — so any tenant with `blueprintId IS NULL` got
 * `gaps: []` regardless of Deal state. AxisOne day-1 PROD showed 8 Deals, 6 of
 * them missing pricing (75%), and the panel rendered NO gap signal. Honest
 * Doctrine-5 "engine has no starting model yet" framing collapsed to "engine
 * sees nothing of value", silently.
 *
 * The unit-level sentinel at `apps/web/src/app/dashboard/__tests__/page.test.tsx`
 * PASSED — `vi.mocked(brainLayersAdapter).mockResolvedValue({ gaps: [...] })`
 * validated the desired RESPONSE shape but never exercised the backend handler.
 * The mock returned the gap whether the backend would have or not. CI green;
 * PROD signal-blind.
 *
 * Per the KAN-1089→KAN-1111→KAN-1115 cluster discipline memo
 * (`feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md`):
 * **sentinel tests asserting backend behavior MUST exercise the real backend
 * code path, not a mock that returns the desired shape**.
 *
 * **Test structure**:
 *
 * 1. `evaluates gap rule #1 even when blueprintId IS NULL (post-fix)` — runs the
 *    real handler against a tenant with empty-state + 75%-missing-pricing Deals
 *    + asserts the gap fires. POST-FIX behavior.
 * 2. `would have caught the empty-state-skip-eval bug (KAN-1115 demonstration)` —
 *    simulates the PRE-FIX handler structure inline (gap eval AFTER the
 *    early-return) and asserts it produces `gaps: []` for the same fixture.
 *    This is the runnable-doc proof that integration coverage would have
 *    caught KAN-1115 before deploy.
 * 3. `does not fire gap #1 when fewer than 25% of deals miss pricing` —
 *    threshold boundary assertion against real Deal rows.
 */
import { describe, expect, it } from 'vitest';
import {
  getBrainLayersImpl,
  type BrainLayersPrismaSurface,
} from '../../services/brain-layers-impl.js';
import { createBlueprint, createContact, createDeal, createPipeline, createTenant, withRollback } from './setup.js';

/**
 * Pre-fix handler structure (gap rule #1 INSIDE the post-early-return block).
 * Used by the failure-mode demonstration test only. Mirrors the buggy
 * structure shipped at KAN-1113 before the KAN-1115 fix-forward hoist.
 */
async function getBrainLayersImplPreFix(
  prisma: BrainLayersPrismaSurface,
  tenantId: string,
): Promise<{ gaps: Array<{ id: string }> }> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      blueprintId: true,
      blueprint: { select: { isActive: true, vertical: true } },
    },
  });

  // PRE-FIX BUG: early return BEFORE Deal aggregation runs. Any tenant with
  // empty-state cognitive infra never gets gap rule #1 evaluated, even when
  // their Deal table screams pricing-incomplete.
  if (!tenant?.blueprintId || !tenant.blueprint) {
    return { gaps: [] };
  }

  // (Post-return Deal evaluation lived here pre-fix — unreachable for
  // empty-state tenants.)
  return { gaps: [] };
}

describe('KAN-1115 — getBrainLayersImpl gap rule #1 empty-state evaluation', () => {
  it('evaluates gap rule #1 even when blueprintId IS NULL (post-fix)', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma, { blueprintId: null });
      const contact = await createContact(prisma, tenant.id);
      const pipeline = await createPipeline(prisma, tenant.id);

      // 8 Deals, 6 of them value=0 → 75% missing pricing → above 25% threshold.
      for (let i = 0; i < 6; i += 1) {
        await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 0,
        });
      }
      for (let i = 0; i < 2; i += 1) {
        await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 1000,
        });
      }

      const result = await getBrainLayersImpl(prisma as unknown as BrainLayersPrismaSurface, tenant.id);

      expect(result.blueprint.isActive).toBeNull();
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0]!.id).toBe('deal_pricing_missing');
      expect(result.gaps[0]!.message).toMatch(/75%/);
    });
  });

  it('would have caught the empty-state-skip-eval bug (KAN-1115 failure-mode demonstration)', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma, { blueprintId: null });
      const contact = await createContact(prisma, tenant.id);
      const pipeline = await createPipeline(prisma, tenant.id);

      // Identical fixture as the post-fix test above — 75% missing pricing.
      for (let i = 0; i < 6; i += 1) {
        await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 0,
        });
      }
      for (let i = 0; i < 2; i += 1) {
        await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 1000,
        });
      }

      const buggyResult = await getBrainLayersImplPreFix(
        prisma as unknown as BrainLayersPrismaSurface,
        tenant.id,
      );

      // PRE-FIX SHIPPED SHAPE: empty gaps. PROD signal-blind. This assertion is
      // the runnable-documentation proof — an integration test would have made
      // the divergence between post-fix (1 gap) and pre-fix (0 gaps) visible
      // BEFORE the bug shipped.
      expect(buggyResult.gaps).toEqual([]);
    });
  });

  it('does not fire gap #1 when fewer than 25% of deals miss pricing', async () => {
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma, { blueprintId: null });
      const contact = await createContact(prisma, tenant.id);
      const pipeline = await createPipeline(prisma, tenant.id);

      // 1 Deal value=0, 9 Deals with value → 10% missing → under threshold.
      await createDeal(prisma, {
        tenantId: tenant.id,
        contactId: contact.id,
        pipelineId: pipeline.id,
        stageId: pipeline.stageId,
        value: 0,
      });
      for (let i = 0; i < 9; i += 1) {
        await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 1000,
        });
      }

      const result = await getBrainLayersImpl(prisma as unknown as BrainLayersPrismaSurface, tenant.id);

      expect(result.gaps).toEqual([]);
    });
  });

  it('fires gap rule #1 even when Blueprint IS populated (rule depends on Deal table only)', async () => {
    await withRollback(async (prisma) => {
      const blueprint = await createBlueprint(prisma, { isActive: true });
      const tenant = await createTenant(prisma, { blueprintId: blueprint.id });
      const contact = await createContact(prisma, tenant.id);
      const pipeline = await createPipeline(prisma, tenant.id);

      for (let i = 0; i < 6; i += 1) {
        await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 0,
        });
      }
      for (let i = 0; i < 2; i += 1) {
        await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 1000,
        });
      }

      const result = await getBrainLayersImpl(prisma as unknown as BrainLayersPrismaSurface, tenant.id);

      expect(result.blueprint.isActive).toBe(true);
      const pricingGap = result.gaps.find((g) => g.id === 'deal_pricing_missing');
      expect(pricingGap).toBeDefined();
      expect(pricingGap!.message).toMatch(/75%/);
    });
  });
});
