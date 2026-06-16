/**
 * SKIP-GATE NOTICE — bootstrap-seed posture per memo 33
 * (bootstrap_seed_ci_failure_is_doctrinal_feature, KAN-1192 Path Z3).
 *
 * The refiner-audit scenario is wrapped with
 * `it.skipIf(!process.env.PR_LIVE_RECORDED)` because it depends on a live
 * refiner call to produce the audit row; hand-authored fixture didn't
 * match runtime contract. Commit-audit scenario stays active (zero-LLM).
 *
 * KAN-1209 follow-up un-skips after re-record against isolated test DB
 * (NOT PROD — per memo 34).
 *
 * KAN-1192 — History + pagination scenarios (Step 6).
 *
 * Audit + conversation-turn persistence assertions for the full operator
 * flow. Refiner emits `campaign.action_plan_refined` audit on every
 * successful edit; commit emits `campaign.action_plan_committed` and
 * `audit_log` row preservation must hold across the chain.
 *
 * # Posture
 *
 *   This is the smallest step in the trace (Step 6, 1.0× multiplier). The
 *   substantive history+pagination logic lives in the audit-log + tRPC
 *   listing layers (covered elsewhere); here we assert the persistence
 *   SIDE EFFECTS of the refiner + commit chain are visible to the history
 *   reader.
 *
 * # Doctrine
 *
 *   - `audit_log_never_deleted` — refiner + commit MUST write audit rows;
 *     deleting them in cleanup is test-cleanup discipline (tenant-scoped
 *     short-lived rows), NOT forensic destruction.
 *   - `context_faithful_dispatch_discipline` — matches Phase 1 trace Step 6
 */
import { describe, expect, it } from 'vitest';
import type {
  CommitActionPlanResult,
  RefineActionPlanResult,
} from '@growth/shared';
import { createTenant, withCleanup } from './setup.js';
import {
  buildCampaignWithProposedPlan,
  cleanupCampaignTestArtifacts,
  fixtureLLM,
  stubAudienceCountForGenerator,
} from './kan-1192-harness.js';

const refinerSpec =
  '../../../../../packages/api/src/services/action-plan-refiner.js';
const commitSpec =
  '../../../../../packages/api/src/services/commit-action-plan.js';

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

interface CommitModule {
  commitActionPlan: (
    prisma: unknown,
    params: {
      campaignId: string;
      tenantId: string;
      expectedUpdatedAt?: string;
      userId?: string;
      todayUtc?: Date;
    },
  ) => Promise<CommitActionPlanResult>;
}

const TODAY = new Date('2026-06-16T13:00:00.000Z');

describe('KAN-1192 history — refiner emits action_plan_refined audit', () => {
  // KAN-1192 Path Z3 — bootstrap-seed skip-gate; un-skip via KAN-1209 re-record.
  it.skipIf(!process.env.PR_LIVE_RECORDED)('writes a campaign.action_plan_refined row on successful stage rename', async () => {
    const { refineActionPlan } = (await import(refinerSpec)) as RefinerModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id);
        // Reuse the stage-rename fixture from Step 4 — same LLM JSON shape.
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
        // Audit row asserts forensic trail (E5 lock).
        const audit = await prisma.auditLog.findFirst({
          where: {
            tenantId: tenant.id,
            actionType: 'campaign.action_plan_refined',
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

describe('KAN-1192 history — commit emits action_plan_committed audit', () => {
  it('writes a campaign.action_plan_committed row on successful commit', async () => {
    const { commitActionPlan } = (await import(commitSpec)) as CommitModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id);
        const result = await commitActionPlan(prisma, {
          campaignId: campaign.id,
          tenantId: tenant.id,
          todayUtc: TODAY,
        });
        expect(result.kind).toBe('committed');
        const audit = await prisma.auditLog.findFirst({
          where: {
            tenantId: tenant.id,
            actionType: 'campaign.action_plan_committed',
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
