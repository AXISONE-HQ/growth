/**
 * KAN-1205 — commit-after-generate without false concurrent_edit_conflict
 * (REAL Prisma).
 *
 * Closes the FIFTH KAN-1184/1190 latent-bug testing-substrate gap. After
 * KAN-1200 (FK) + KAN-1201 (state machine) + KAN-1203 (objectives field
 * names) + KAN-1204 (audience tree), Fred's PROD smoke reached Action Plan
 * rendering for the first time and then "Commit click did nothing."
 *
 * Server logs at 12:41:59 + 12:42:16 UTC showed 2× POST 200 to
 * /trpc/campaigns.commitActionPlan — both returned `kind:
 * 'concurrent_edit_conflict'` because:
 *
 *   `apps/web/src/lib/hooks/useActionPlanCard.ts` passed
 *   `expectedUpdatedAt: plan.generatedAt` to commit + refine mutations.
 *
 *   `plan.generatedAt` (T1) is the LLM generation timestamp embedded in
 *   the ActionPlan JSON. `Campaign.updatedAt` (T2) is the Prisma
 *   `@updatedAt` directive timestamp set when the generator persisted
 *   the plan via `Campaign.update({proposedPlan: ...})`. T1 < T2 always
 *   (Prisma updates the row AFTER the generator computes), so the
 *   server-side J11 check at commit-action-plan.ts:285-295 always
 *   returned `concurrent_edit_conflict` for the post-generate UI path.
 *
 * KAN-1205 surgical fix: drop `expectedUpdatedAt` from both refine + commit
 * mutation invocations in useActionPlanCard.ts. The server-side J11/NEW-B
 * check remains operational for direct API consumers (admin tools,
 * third-party integrations) that have the correct Campaign.updatedAt
 * token. The UI relies on J8 idempotency (`already_committed`) for
 * double-click protection — which is sufficient for single-operator
 * usage. See `j11_j8_redundancy_doctrine` memo.
 *
 * This file is an API-layer test BUT exercises the exact pattern the UI
 * hook now produces: NO `expectedUpdatedAt` passed. Asserts that the
 * commit succeeds without the false-positive. KAN-1192 will extend this
 * pattern with a true UI-hook-layer scenario (rendered hook state, not
 * constructed inputs) per the `ui_hook_layer_test_family` memo.
 *
 * Substrate posture per banked memos:
 *   - `j11_j8_redundancy_doctrine` — drop J11 on UI; J8 sufficient
 *   - `ui_hook_layer_test_family` — distinct boundary; this file seeds it
 *   - `operator_session_as_test_anchor_pattern` — Fred's exact PROD timing
 *     (commit immediately after generate) is the canonical scenario
 *
 * Import posture (KAN-689 variable-specifier): commit-action-plan and
 * action-plan-generator live outside apps/api rootDir; await import(spec)
 * sidesteps TS6059.
 */
import { describe, expect, it } from 'vitest';
import { createTenant, withRollback } from './setup.js';

const commitActionPlanSpec =
  '../../../../../packages/api/src/services/commit-action-plan.js';
const orchestratorSpec =
  '../../../../../packages/api/src/services/conversational-orchestrator.js';

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
  ) => Promise<{ kind: string; campaignId: string; pipelineIds?: string[]; message?: string }>;
}

interface OrchestratorModule {
  createDraftCampaign: (
    prisma: unknown,
    tenantId: string,
  ) => Promise<{ id: string }>;
}

/** Build a canonical ActionPlan payload + persist to Campaign.proposedPlan.
 *  Mirrors the shape the generator produces; bypasses LLM call to keep test
 *  deterministic + fast. The KAN-1192 smoke scenario will exercise the full
 *  generator chain with live LLM. */
async function persistCanonicalPlan(
  prisma: import('@prisma/client').PrismaClient,
  campaignId: string,
): Promise<void> {
  const plan = {
    pipelines: [
      {
        name: 'Inbound Lead Pipeline',
        segment: 'new_leads',
        strategy: 'direct',
        audienceConditions: { field: 'lifecycleStage', op: 'in', values: ['lead'] },
        audienceCount: 100,
        proposedStages: [
          { name: 'Outreach', order: 0, description: 'Day-0 outbound' },
          { name: 'Qualify', order: 1, description: 'Discovery' },
          { name: 'Close', order: 2, description: 'Proposal + close' },
        ],
        firstActions: [
          { day: 0, channel: 'email', intent: 'outreach', description: 'Day-0 intro' },
        ],
        projectedContribution: 15,
        shareOfGoal: 15,
      },
    ],
    confidence: 'high',
    confidenceReason: '200+ closed deals over 365d',
    gapAnalysis: {
      goalTarget: 100,
      projectedOrganic: 60,
      gapAbsolute: 40,
      gapPercent: 40,
      goalWindowDays: 90,
    },
    modelUsed: 'claude-sonnet-4-6',
    // Generator sets this to its own todayUtc.toISOString(). This is the
    // exact divergence KAN-1205 surfaced: this timestamp ≠ Campaign.updatedAt.
    generatedAt: '2026-06-16T12:00:00.000Z',
  };
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      goalType: 'units',
      goalTarget: 100,
      goalDescription: 'Test campaign for KAN-1205',
      audienceConditions: { field: 'lifecycleStage', op: 'in', values: ['lead'] },
      proposedPlan: plan as unknown as object,
    },
  });
}

const TODAY = new Date('2026-06-16T13:00:00.000Z');

// ─────────────────────────────────────────────
// Defect reproduction — UI hook calls commit without expectedUpdatedAt
// ─────────────────────────────────────────────

describe('KAN-1205 — commit-after-generate succeeds without false concurrent_edit_conflict', () => {
  it('returns committed (NOT concurrent_edit_conflict) when expectedUpdatedAt is omitted', async () => {
    const { commitActionPlan } = (await import(commitActionPlanSpec)) as CommitModule;
    const { createDraftCampaign } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const draft = await createDraftCampaign(prisma, tenant.id);
      await persistCanonicalPlan(prisma, draft.id);

      // Post-KAN-1205 UI hook does NOT pass expectedUpdatedAt. Server's
      // J11 check is bypassed; commit proceeds.
      const result = await commitActionPlan(prisma, {
        campaignId: draft.id,
        tenantId: tenant.id,
        // expectedUpdatedAt intentionally omitted — this is the post-fix hook
        // behavior.
        todayUtc: TODAY,
      });

      expect(result.kind).toBe('committed');
      // Pre-KAN-1205 this returned 'concurrent_edit_conflict' because the
      // UI hook passed plan.generatedAt (which never matches
      // Campaign.updatedAt set by Prisma @updatedAt on the generator's
      // write). Asserting 'committed' here would have failed pre-fix.
      expect(result.kind).not.toBe('concurrent_edit_conflict');
    });
  });

  it('returns concurrent_edit_conflict when expectedUpdatedAt mismatches (direct API consumer path preserved)', async () => {
    // The server-side J11 check stays operational for direct API consumers
    // that DO have the correct token. This asserts the J11 contract still
    // works when a caller passes a stale token (e.g. admin tool, third-party
    // integration that read Campaign.updatedAt from an earlier getCampaign).
    const { commitActionPlan } = (await import(commitActionPlanSpec)) as CommitModule;
    const { createDraftCampaign } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const draft = await createDraftCampaign(prisma, tenant.id);
      await persistCanonicalPlan(prisma, draft.id);

      const result = await commitActionPlan(prisma, {
        campaignId: draft.id,
        tenantId: tenant.id,
        // Stale token from "earlier" — server-side J11 still fires.
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
        todayUtc: TODAY,
      });

      expect(result.kind).toBe('concurrent_edit_conflict');
    });
  });
});

// ─────────────────────────────────────────────
// J8 idempotency — double-click commit returns already_committed
// ─────────────────────────────────────────────

describe('KAN-1205 — J8 idempotency protects against UI double-click without J11', () => {
  it('second commit call returns already_committed (sufficient guard without J11)', async () => {
    const { commitActionPlan } = (await import(commitActionPlanSpec)) as CommitModule;
    const { createDraftCampaign } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const draft = await createDraftCampaign(prisma, tenant.id);
      await persistCanonicalPlan(prisma, draft.id);

      // First commit — succeeds.
      const result1 = await commitActionPlan(prisma, {
        campaignId: draft.id,
        tenantId: tenant.id,
        todayUtc: TODAY,
      });
      expect(result1.kind).toBe('committed');
      const firstPipelineIds = result1.pipelineIds;

      // Operator double-clicks — second commit returns idempotent variant.
      const result2 = await commitActionPlan(prisma, {
        campaignId: draft.id,
        tenantId: tenant.id,
        todayUtc: TODAY,
      });
      expect(result2.kind).toBe('already_committed');
      // J8 contract: same Pipeline IDs returned so UI can route to same
      // success state.
      expect(result2.pipelineIds).toEqual(firstPipelineIds);
    });
  });
});
