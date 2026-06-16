/**
 * KAN-1192 — Commit + UI-hook-layer scenarios (4 of 13).
 *
 * Scenarios:
 *  10. multi-pipeline materialization — committed; 2 Pipelines + N stages persist
 *  11. already_committed — second commit returns idempotent variant
 *  12. concurrent_edit_conflict — stale expectedUpdatedAt rejects (J11)
 *  13. UI-hook-layer commit-after-generate — NO expectedUpdatedAt → no false J11
 *
 * # Layer distinction (`ui_hook_layer_test_family` memo)
 *
 *   Scenarios 10/11/12 are API-layer integration tests — they call
 *   commitActionPlan() directly with explicit params. Scenario 13 is the
 *   UI-hook-layer test extending the KAN-1205 seed: it asserts the post-
 *   fix UI hook pattern (NO expectedUpdatedAt passed) survives end-to-end
 *   without producing a false concurrent_edit_conflict.
 *
 *   The UI-hook-layer scenario is NOT a re-render of the React hook
 *   (those live in apps/web/__tests__). It is the SERVICE-LAYER assertion
 *   that the exact param shape the post-KAN-1205 hook produces (no
 *   expectedUpdatedAt) maps onto the J8-idempotency path (not the J11
 *   concurrent-edit path) so the operator sees a green commit, not an
 *   error banner. See kan-1205-commit-after-generate-no-false-conflict.test.ts
 *   for the canonical reference.
 *
 * # withCleanup posture (KAN-1205 fix-forward memo)
 *
 *   commitActionPlan opens its OWN $transaction. Prisma forbids nested
 *   transactions, so withRollback breaks here. withCleanup runs against
 *   real DB with committed writes; cleanup deletes test rows in FK order:
 *     1. AuditLog (no FK to delete here; cascade-safe)
 *     2. Pipeline (cascades to PipelineStage)
 *     3. CampaignConversationTurn (FK on Campaign)
 *     4. Campaign
 *     5. Tenant
 *
 *   See `integration_test_isolation_pattern_must_match_service_tx_shape`.
 *
 * # Doctrine header
 *
 *   - `hybrid_llm_test_architecture` — commit doesn't call LLM directly; no
 *     fixtures needed. Bounds re-check + tx + audit are all deterministic.
 *   - `tests_encoding_current_bug_anti_pattern` — KAN-1205 anti-pattern
 *     guarded: scenario 13 asserts the bug pattern is unreachable.
 *   - `operator_experience_verification` — operator double-clicks Commit →
 *     scenario 11 asserts J8 idempotency holds.
 *   - `j11_j8_redundancy_doctrine` — scenario 12 asserts J11 still fires
 *     for direct API consumers passing expectedUpdatedAt; scenario 13
 *     asserts J11 is bypassed when expectedUpdatedAt is omitted (UI path).
 *   - `ui_hook_layer_test_family` — scenario 13 is the post-KAN-1205 layer.
 *   - `context_faithful_dispatch_discipline` — matches Phase 1 trace Step 5
 *
 * # KAN-689 imports — commit module outside apps/api rootDir.
 */
import { describe, expect, it } from 'vitest';
import type { CommitActionPlanResult } from '@growth/shared';
import { createTenant, withCleanup } from './setup.js';
import {
  buildCampaignWithProposedPlan,
  cleanupCampaignTestArtifacts,
} from './kan-1192-harness.js';

const commitSpec =
  '../../../../../packages/api/src/services/commit-action-plan.js';

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

// ─────────────────────────────────────────────
// Scenario 10: multi-pipeline materialization → committed
// ─────────────────────────────────────────────

describe('KAN-1192 commit — multi-pipeline materialization', () => {
  it('commits a 2-pipeline plan; Pipeline + Stage rows materialize', async () => {
    const { commitActionPlan } = (await import(commitSpec)) as CommitModule;
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
                { name: 'Close', order: 2, description: 'Propose + close' },
              ],
            },
            {
              name: 'Customer Pipeline',
              segment: 'inactive_customers_reengagement',
              strategy: 'guided',
              proposedStages: [
                { name: 'Educate', order: 0, description: 'Tier overview' },
                { name: 'Compare', order: 1, description: 'Plan compare' },
                { name: 'Recommend', order: 2, description: 'Recommend' },
                { name: 'Close', order: 3, description: 'Close' },
              ],
            },
          ],
        });
        const result = await commitActionPlan(prisma, {
          campaignId: campaign.id,
          tenantId: tenant.id,
          todayUtc: TODAY,
        });
        expect(result.kind).toBe('committed');
        if (result.kind === 'committed') {
          expect(result.pipelineIds).toHaveLength(2);
          expect(result.stageIds).toHaveLength(2);
          expect(result.stageIds[0]?.length).toBe(3);
          expect(result.stageIds[1]?.length).toBe(4);
          // Campaign.status flipped to 'committed' (J4 lock — NOT 'active')
          const row = await prisma.campaign.findUniqueOrThrow({
            where: { id: campaign.id },
            select: { status: true, committedPlan: true },
          });
          expect(row.status).toBe('committed');
          expect(row.committedPlan).toBeTruthy();
          // Pipeline rows materialized in DB
          const pipelines = await prisma.pipeline.findMany({
            where: { tenantId: tenant.id, campaignId: campaign.id },
            include: { stages: true },
          });
          expect(pipelines).toHaveLength(2);
          for (const p of pipelines) {
            expect(p.stages.length).toBeGreaterThanOrEqual(2);
          }
        }
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 11: already_committed — J8 idempotency
// ─────────────────────────────────────────────

describe('KAN-1192 commit — J8 idempotency', () => {
  it('second commit returns already_committed with same Pipeline IDs', async () => {
    const { commitActionPlan } = (await import(commitSpec)) as CommitModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id);
        const first = await commitActionPlan(prisma, {
          campaignId: campaign.id,
          tenantId: tenant.id,
          todayUtc: TODAY,
        });
        expect(first.kind).toBe('committed');
        const firstPipelineIds = first.kind === 'committed'
          ? first.pipelineIds
          : [];
        const second = await commitActionPlan(prisma, {
          campaignId: campaign.id,
          tenantId: tenant.id,
          todayUtc: TODAY,
        });
        expect(second.kind).toBe('already_committed');
        if (second.kind === 'already_committed') {
          expect(second.pipelineIds).toEqual(firstPipelineIds);
          expect(second.committedPlan).toBeTruthy();
        }
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Scenario 12: concurrent_edit_conflict — stale expectedUpdatedAt
//
// J11 contract preserved for direct API consumers. UI hook (post-KAN-1205)
// omits expectedUpdatedAt; admin tools / third-party integrations passing
// a stale token still see the conflict variant.
// ─────────────────────────────────────────────

describe('KAN-1192 commit — concurrent edit conflict (J11 direct API path)', () => {
  it('rejects commit with stale expectedUpdatedAt → concurrent_edit_conflict', async () => {
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
          expectedUpdatedAt: '2020-01-01T00:00:00.000Z', // stale
          todayUtc: TODAY,
        });
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
// Scenario 13: UI-hook-layer — commit-after-generate via hook path
//
// Extends the KAN-1205 seed test. Asserts the post-fix hook pattern (NO
// expectedUpdatedAt passed) maps to J8 idempotency, NOT J11 conflict.
// This is the "no false J11 positive" canary.
// ─────────────────────────────────────────────

describe('KAN-1192 commit — UI-hook-layer (no false J11)', () => {
  it('commit succeeds when expectedUpdatedAt is omitted (post-KAN-1205 hook pattern)', async () => {
    const { commitActionPlan } = (await import(commitSpec)) as CommitModule;
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;
        const campaign = await buildCampaignWithProposedPlan(prisma, tenant.id);
        // Post-KAN-1205 UI hook does NOT pass expectedUpdatedAt. J11 check
        // is bypassed; commit proceeds.
        const result = await commitActionPlan(prisma, {
          campaignId: campaign.id,
          tenantId: tenant.id,
          // expectedUpdatedAt INTENTIONALLY OMITTED — UI hook canonical pattern
          todayUtc: TODAY,
        });
        expect(result.kind).toBe('committed');
        expect(result.kind).not.toBe('concurrent_edit_conflict');
      },
      async (prisma) => {
        if (tenantId) await cleanupCampaignTestArtifacts(prisma, tenantId);
      },
    );
  });
});
