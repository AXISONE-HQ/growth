/**
 * KAN-1208 — commit-action-plan populates audienceEvaluatedAt + audienceSnapshotCount.
 * (REAL Prisma.)
 *
 * Closes the 7th KAN-1184/1190 latent-bug/scope-gap arc artifact. After
 * KAN-1200 (FK) + KAN-1201 (state machine) + KAN-1203 (field names) +
 * KAN-1204 (audience tree) + KAN-1205 (commit concurrency) + KAN-1206
 * (post-commit destination view), Fred's PROD 8th smoke clicked Activate
 * 6× in 4 seconds. Server logs at 15:42:22-26 UTC showed 6× POST 200 to
 * `campaigns.activate` with no visible UI change — because:
 *
 *   `packages/api/src/services/commit-action-plan.ts` (chat-flow commit
 *   path) never populated `Campaign.audienceEvaluatedAt`. The legacy KAN-1002
 *   flow ran a separate `audience.evaluate` step between commit and activate
 *   that set this column. The chat-flow short-cut merged commit + audience
 *   evaluation semantically (operator confirms audienceConditions during
 *   chat) but DIDN'T populate the column.
 *
 *   `packages/api/src/services/campaign-activation.ts:329-336` requires
 *   `campaign.audienceEvaluatedAt !== null`; otherwise returns
 *   `{ kind: 'rejected', reason: 'audience_not_evaluated' }`. Every
 *   chat-flow-committed Campaign therefore rejected on activate. Always.
 *
 * KAN-1208 substrate fix: commit-action-plan.ts now sets
 *   - `audienceEvaluatedAt: todayUtc`
 *   - `audienceSnapshotCount: sum(plan.pipelines[].audienceCount)`
 *
 * inside the J2 transaction, alongside the existing
 * `status='committed' + activatedAt + committedPlan` write.
 *
 * Sibling UI fix in `apps/web/.../CommittedCampaignView.tsx` adds the
 * `kind: 'rejected'` branch to `handleActivate` — same pattern that the
 * sibling `handlePause` handler already had. Prevents silent fall-through
 * for ANY future rejection reason. See
 * `discriminated_union_rejected_variant_doctrine` memo.
 *
 * Substrate posture per banked memos:
 *   - `boundary_integration_gap_subclass` — 29th memo, subclass of
 *     operator_session_reveals_scope_gaps; chat-flow shortcut bypassed
 *     legacy multi-step column population
 *   - `discriminated_union_rejected_variant_doctrine` — 28th memo;
 *     UI handlers must branch on every kind discriminant
 *   - `integration_test_isolation_pattern_must_match_service_tx_shape`
 *     (KAN-1205) — withCleanup pattern required because commit-action-plan
 *     opens its own $transaction
 *
 * Import posture (KAN-689 variable-specifier): cross-rootDir modules
 * resolved via `const spec = '…js'; await import(spec)`.
 */
import { describe, expect, it } from 'vitest';
import { createTenant, withCleanup } from './setup.js';

const commitActionPlanSpec =
  '../../../../../packages/api/src/services/commit-action-plan.js';
const orchestratorSpec =
  '../../../../../packages/api/src/services/conversational-orchestrator.js';
const activationSpec =
  '../../../../../packages/api/src/services/campaign-activation.js';

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
  ) => Promise<{
    kind: string;
    campaignId: string;
    pipelineIds?: string[];
    message?: string;
  }>;
}

interface OrchestratorModule {
  createDraftCampaign: (
    prisma: unknown,
    tenantId: string,
  ) => Promise<{ id: string }>;
}

interface ActivationModule {
  activateCampaign: (
    prisma: unknown,
    tenantId: string,
    input: { campaignId: string; userId?: string },
    hooks: unknown,
    opts?: { publishesPerSecond?: number },
  ) => Promise<{
    kind: 'activated' | 'already_active' | 'rejected';
    campaignId: string;
    reason?: string;
    currentStatus?: string;
    memberCount?: number;
  }>;
}

/** Build a canonical ActionPlan + persist to Campaign.proposedPlan. Mirrors
 *  the shape commit-action-plan reads. */
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
      {
        name: 'Re-engage Quiet Customers',
        segment: 'inactive_customers_reengagement',
        strategy: 're_engage',
        audienceConditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
        audienceCount: 250,
        proposedStages: [
          { name: 'Re-intro', order: 0, description: 'Touch base' },
          { name: 'Offer', order: 1, description: 'Value proposition' },
        ],
        firstActions: [
          { day: 0, channel: 'email', intent: 'reengage', description: 'Re-intro touch' },
        ],
        projectedContribution: 25,
        shareOfGoal: 25,
      },
    ],
    confidence: 'high',
    confidenceReason: '200+ closed deals over 365d',
    gapAnalysis: {
      goalTarget: 100,
      projectedOrganic: 40,
      gapAbsolute: 60,
      gapPercent: 60,
      goalWindowDays: 90,
    },
    modelUsed: 'claude-sonnet-4-6',
    generatedAt: '2026-06-16T15:00:00.000Z',
  };
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      goalType: 'units',
      goalTarget: 100,
      goalDescription: 'Test campaign for KAN-1208',
      audienceConditions: { field: 'lifecycleStage', op: 'in', values: ['lead', 'customer'] },
      proposedPlan: plan as unknown as object,
    },
  });
}

async function cleanupTenant(
  prisma: import('@prisma/client').PrismaClient,
  tenantId: string,
): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.pipeline.deleteMany({ where: { tenantId } });
  await prisma.campaign.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
}

const TODAY = new Date('2026-06-16T15:30:00.000Z');

// ─────────────────────────────────────────────
// Scenario 1 — commit populates audienceEvaluatedAt + audienceSnapshotCount
// ─────────────────────────────────────────────

describe('KAN-1208 — commit-action-plan populates audience evaluation columns', () => {
  it('sets audienceEvaluatedAt + audienceSnapshotCount in the commit transaction', async () => {
    const { commitActionPlan } = (await import(commitActionPlanSpec)) as CommitModule;
    const { createDraftCampaign } = (await import(orchestratorSpec)) as OrchestratorModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const draft = await createDraftCampaign(prisma, tenant.id);
        await persistCanonicalPlan(prisma, draft.id);

        const result = await commitActionPlan(prisma, {
          campaignId: draft.id,
          tenantId: tenant.id,
          todayUtc: TODAY,
        });
        expect(result.kind).toBe('committed');

        const row = await prisma.campaign.findUniqueOrThrow({
          where: { id: draft.id },
          select: {
            status: true,
            audienceEvaluatedAt: true,
            audienceSnapshotCount: true,
          },
        });
        expect(row.status).toBe('committed');
        // Pre-KAN-1208 these two assertions failed (NULL + NULL).
        expect(row.audienceEvaluatedAt).not.toBeNull();
        // Sum of canonical plan's per-Pipeline audienceCount: 100 + 250 = 350.
        expect(row.audienceSnapshotCount).toBe(350);
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 2 — commit → activate end-to-end (the boundary integration gap)
// ─────────────────────────────────────────────

describe('KAN-1208 — commit → activate end-to-end succeeds', () => {
  it('chat-flow commit followed by activate returns kind=activated (NOT audience_not_evaluated)', async () => {
    const { commitActionPlan } = (await import(commitActionPlanSpec)) as CommitModule;
    const { createDraftCampaign } = (await import(orchestratorSpec)) as OrchestratorModule;
    const { activateCampaign } = (await import(activationSpec)) as ActivationModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const draft = await createDraftCampaign(prisma, tenant.id);
        await persistCanonicalPlan(prisma, draft.id);

        const commitResult = await commitActionPlan(prisma, {
          campaignId: draft.id,
          tenantId: tenant.id,
          todayUtc: TODAY,
        });
        expect(commitResult.kind).toBe('committed');

        // Activate hooks — minimal no-op stubs sufficient for this test.
        const hooks = {
          auditLog: {
            writeInTx: async (
              tx: { auditLog: { create: (args: unknown) => Promise<{ id: string }> } },
              payload: {
                tenantId: string;
                actor: string;
                actionType: string;
                payload: Record<string, unknown>;
                reasoning: string;
              },
            ): Promise<{ id: string }> =>
              tx.auditLog.create({
                data: {
                  tenantId: payload.tenantId,
                  actor: payload.actor,
                  actionType: payload.actionType,
                  payload: payload.payload,
                  reasoning: payload.reasoning,
                },
              }),
          },
          pubsub: {
            publishDecisionRun: async (): Promise<string> => 'stub-message-id',
          },
        };

        const activateResult = await activateCampaign(
          prisma,
          tenant.id,
          { campaignId: draft.id },
          hooks,
          { publishesPerSecond: 10 },
        );
        // Pre-KAN-1208 this returned kind='rejected', reason='audience_not_evaluated'.
        // The 6 rapid POSTs Fred fired in 4 seconds all hit this branch.
        expect(activateResult.kind).toBe('activated');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 3 — regression: activate rejects on non-committed Campaign
// ─────────────────────────────────────────────

describe('KAN-1208 — activate still rejects on non-committed Campaign (regression)', () => {
  it('returns kind=rejected reason=status_draft when called on a draft Campaign', async () => {
    const { createDraftCampaign } = (await import(orchestratorSpec)) as OrchestratorModule;
    const { activateCampaign } = (await import(activationSpec)) as ActivationModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const draft = await createDraftCampaign(prisma, tenant.id);
        // Skip commit — Campaign stays status='draft'.

        const hooks = {
          auditLog: {
            writeInTx: async (
              tx: { auditLog: { create: (args: unknown) => Promise<{ id: string }> } },
              payload: {
                tenantId: string;
                actor: string;
                actionType: string;
                payload: Record<string, unknown>;
                reasoning: string;
              },
            ): Promise<{ id: string }> =>
              tx.auditLog.create({
                data: {
                  tenantId: payload.tenantId,
                  actor: payload.actor,
                  actionType: payload.actionType,
                  payload: payload.payload,
                  reasoning: payload.reasoning,
                },
              }),
          },
          pubsub: {
            publishDecisionRun: async (): Promise<string> => 'stub-message-id',
          },
        };

        const result = await activateCampaign(
          prisma,
          tenant.id,
          { campaignId: draft.id },
          hooks,
          { publishesPerSecond: 10 },
        );
        expect(result.kind).toBe('rejected');
        expect(result.reason).toBe('status_draft');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });
});
