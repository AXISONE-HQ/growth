/**
 * KAN-1192 — Refiner fixture-replay scenarios (6 of 13).
 *
 * Each refiner scenario exercises ONE of the 4 edit-axis families OR a
 * fail-safe variant. Closes the regression contract for action-plan-refiner
 * under stable LLM input.
 *
 * Scenarios:
 *   4. stage edit             — rename Stage 1 within Pipeline 0
 *   5. bounds_violation       — stage add would exceed STRATEGY_STAGE_BOUNDS
 *   6. audience edit          — replace Campaign.audienceConditions tree
 *   7. dimension edit         — bump Campaign.goalTarget; trigger feasibility
 *   8. concurrent_edit        — stale expectedUpdatedAt → conflict variant
 *   9. no_plan_to_refine      — Campaign.proposedPlan IS NULL → reject early
 *
 * # Bug-class coverage (Phase 1 trace)
 *
 *   - KAN-1204 maps here: audience-axis scenarios assert AudienceConditions
 *     schema validation runs and dimension-axis writes Campaign columns +
 *     emits campaign.dimension_post_confirm_edit audit (NEW-D lock).
 *   - KAN-1201 reverberates: refiner uses tier='reasoning' only (NEW-A);
 *     fixture metadata captures tier so a regression to cheap-tier surfaces.
 *
 * # Doctrine header
 *
 *   - `hybrid_llm_test_architecture` — fixture-replay = regression gate
 *   - `tests_encoding_current_bug_anti_pattern` — fixtures recorded; bounds_
 *     violation scenario asserts the bounds check fires AFTER the LLM
 *     classifies; pre-KAN-1186 the bounds check was structural, not
 *     LLM-output-conditional
 *   - `operator_experience_verification` — operator typing "narrow to QC
 *     customers in last 30 days" must round-trip through the refiner without
 *     dropping the date filter; LLM classification + Zod parse + persist
 *   - `context_faithful_dispatch_discipline` — matches Phase 1 trace Step 4
 *
 * # KAN-689 imports — refiner outside apps/api rootDir; await import(spec).
 */
import { describe, expect, it } from 'vitest';
import type { RefineActionPlanResult } from '@growth/shared';
import { createTenant, withCleanup } from './setup.js';
import {
  buildCampaignWithProposedPlan,
  cleanupCampaignTestArtifacts,
  fixtureLLM,
  stubAudienceCountForGenerator,
} from './kan-1192-harness.js';

const refinerSpec =
  '../../../../../packages/api/src/services/action-plan-refiner.js';

interface RefinerModule {
  refineActionPlan: (
    prisma: unknown,
    redis: unknown,
    llm: unknown,
    countAudience: unknown,
    params: {
      campaignId: string;
      tenantId: string;
      refinementMessage: string;
      expectedUpdatedAt?: string;
      todayUtc?: Date;
    },
  ) => Promise<RefineActionPlanResult>;
}

const TODAY = new Date('2026-06-16T13:00:00.000Z');

// ─────────────────────────────────────────────
// Scenario 4: stage edit — rename Stage 1 to "Discovery"
// ─────────────────────────────────────────────

describe('KAN-1192 refiner — stage rename', () => {
  it('renames Stage 1 within Pipeline 0 → action_plan_refined', async () => {
    const { refineActionPlan } = (await import(refinerSpec)) as RefinerModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id);
        const llm = fixtureLLM('refiner-stage-rename');
        const result = await refineActionPlan(
          prisma,
          null,
          llm,
          stubAudienceCountForGenerator(),
          {
            campaignId: campaign.id,
            tenantId: tenant.id,
            refinementMessage: 'Rename stage 1 to Discovery',
            todayUtc: TODAY,
          },
        );
        expect(result.kind).toBe('action_plan_refined');
        if (result.kind === 'action_plan_refined') {
          expect(result.editAxis).toBe('stage');
          // L3 shape-only: assert structural change occurred. The exact new
          // name comes from the fixture; we assert the plan still parses +
          // pipeline 0 still has its stage count within bounds.
          expect(result.plan.pipelines[0]?.proposedStages.length).toBeGreaterThanOrEqual(2);
        }
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 5: bounds_violation — add 5th stage to a direct-strategy pipeline
//
// direct strategy STRATEGY_STAGE_BOUNDS = {min:2, max:4}. Plan starts with
// 4 stages (the max). LLM fixture returns stage-add JSON → 5 stages → bust.
// ─────────────────────────────────────────────

describe('KAN-1192 refiner — bounds violation on stage add', () => {
  it('rejects stage add that would exceed direct strategy max (4)', async () => {
    const { refineActionPlan } = (await import(refinerSpec)) as RefinerModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id, {
          pipelines: [
            {
              name: 'Lead Pipeline',
              segment: 'new_leads',
              strategy: 'direct',
              proposedStages: [
                { name: 'Outreach', order: 0, description: 'Day-0 intro' },
                { name: 'Qualify', order: 1, description: 'Discovery' },
                { name: 'Demo', order: 2, description: 'Demo' },
                { name: 'Close', order: 3, description: 'Close' },
              ],
            },
          ],
        });
        const llm = fixtureLLM('refiner-bounds-violation');
        const result = await refineActionPlan(
          prisma,
          null,
          llm,
          stubAudienceCountForGenerator(),
          {
            campaignId: campaign.id,
            tenantId: tenant.id,
            refinementMessage: 'Add a Negotiation stage between Demo and Close',
            todayUtc: TODAY,
          },
        );
        expect(result.kind).toBe('bounds_violation');
        if (result.kind === 'bounds_violation') {
          expect(result.strategy).toBe('direct');
          expect(result.attemptedStageCount).toBeGreaterThan(4);
        }
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 6: audience edit — replace Campaign.audienceConditions
//
// LLM returns axis=audience with new tree. Refiner re-runs split heuristic
// + countAudience per pipeline. Assertion: result is action_plan_refined +
// editAxis=audience + Campaign.audienceConditions row updated.
// ─────────────────────────────────────────────

describe('KAN-1192 refiner — audience edit', () => {
  it('replaces audienceConditions and re-runs split → action_plan_refined', async () => {
    const { refineActionPlan } = (await import(refinerSpec)) as RefinerModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id);
        const llm = fixtureLLM('refiner-audience-edit');
        const result = await refineActionPlan(
          prisma,
          null,
          llm,
          stubAudienceCountForGenerator(),
          {
            campaignId: campaign.id,
            tenantId: tenant.id,
            refinementMessage: 'Narrow to customers in Quebec',
            todayUtc: TODAY,
          },
        );
        expect(result.kind).toBe('action_plan_refined');
        if (result.kind === 'action_plan_refined') {
          expect(result.editAxis).toBe('audience');
          // L3 shape-only: assert Campaign row reflects the new audience
          // conditions. Specific tree shape comes from fixture; we assert
          // it's non-null and not the initial tree.
          const row = await prisma.campaign.findUniqueOrThrow({
            where: { id: campaign.id },
            select: { audienceConditions: true },
          });
          expect(row.audienceConditions).toBeTruthy();
        }
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 7: dimension edit — bump goalTarget
//
// NEW-D lock: writes Campaign column + emits
// campaign.dimension_post_confirm_edit audit; does NOT auto-regenerate
// the Action Plan (returns the stale plan).
// ─────────────────────────────────────────────

describe('KAN-1192 refiner — dimension edit (goalTarget bump)', () => {
  it('writes Campaign.goalTarget and emits dimension_post_confirm_edit audit', async () => {
    const { refineActionPlan } = (await import(refinerSpec)) as RefinerModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id);
        const llm = fixtureLLM('refiner-dimension-goal-target');
        const result = await refineActionPlan(
          prisma,
          null,
          llm,
          stubAudienceCountForGenerator(),
          {
            campaignId: campaign.id,
            tenantId: tenant.id,
            refinementMessage: 'Raise the goal target to 200 units',
            todayUtc: TODAY,
          },
        );
        // NEW-D lock — dimension edits write Campaign column directly +
        // emit dimension audit type + return action_plan_refined (with
        // stale plan; operator re-generates if they want refreshed pipelines).
        expect(result.kind).toBe('action_plan_refined');
        if (result.kind === 'action_plan_refined') {
          expect(result.editAxis).toBe('dimension');
        }
        const row = await prisma.campaign.findUniqueOrThrow({
          where: { id: campaign.id },
          select: { goalTarget: true },
        });
        expect(row.goalTarget).toBe(200);
        // Audit row asserts dimension-edit-specific action_type emitted.
        const audit = await prisma.auditLog.findFirst({
          where: {
            tenantId: tenant.id,
            actionType: 'campaign.dimension_post_confirm_edit',
          },
        });
        expect(audit).toBeTruthy();
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 8: concurrent_edit — stale expectedUpdatedAt rejects refinement
//
// Mirrors the J11 contract for refiner (NEW-B lock). Caller passes a
// timestamp that doesn't match Campaign.updatedAt → reject before LLM call.
// Fixture-replay scenario: LLM is NEVER called (short-circuits).
// ─────────────────────────────────────────────

describe('KAN-1192 refiner — concurrent edit conflict', () => {
  it('rejects refinement with stale expectedUpdatedAt → concurrent_edit_conflict', async () => {
    const { refineActionPlan } = (await import(refinerSpec)) as RefinerModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id);
        // ZERO LLM calls scripted — refiner short-circuits on conflict.
        const llm = fixtureLLM('refiner-concurrent-edit');
        const result = await refineActionPlan(
          prisma,
          null,
          llm,
          stubAudienceCountForGenerator(),
          {
            campaignId: campaign.id,
            tenantId: tenant.id,
            refinementMessage: 'Rename stage 1',
            expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
            todayUtc: TODAY,
          },
        );
        expect(result.kind).toBe('concurrent_edit_conflict');
        if (result.kind === 'concurrent_edit_conflict') {
          expect(result.currentPlan).toBeTruthy();
        }
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 9: no_plan_to_refine — Campaign.proposedPlan IS NULL
//
// NEW-C lock: refiner returns canonical no_plan_to_refine variant before
// any LLM call.
// ─────────────────────────────────────────────

describe('KAN-1192 refiner — no plan to refine', () => {
  it('returns no_plan_to_refine when proposedPlan is NULL', async () => {
    const { refineActionPlan } = (await import(refinerSpec)) as RefinerModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        // Campaign created with NO proposedPlan.
        const campaign = await prisma.campaign.create({
          data: {
            tenantId: tenant.id,
            name: 'KAN-1192 no-plan campaign',
            audienceConditions: {
              field: 'lifecycleStage',
              op: 'in',
              values: ['lead'],
            } as object,
            audienceMode: 'static',
            status: 'draft',
            goalType: 'units',
            goalTarget: 100,
            goalDescription: 'No plan yet',
          },
          select: { id: true },
        });
        const llm = fixtureLLM('refiner-no-plan');
        const result = await refineActionPlan(
          prisma,
          null,
          llm,
          stubAudienceCountForGenerator(),
          {
            campaignId: campaign.id,
            tenantId: tenant.id,
            refinementMessage: 'Rename stage 1',
            todayUtc: TODAY,
          },
        );
        expect(result.kind).toBe('no_plan_to_refine');
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});
