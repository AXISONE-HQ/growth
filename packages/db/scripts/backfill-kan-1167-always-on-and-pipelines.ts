/**
 * KAN-1167 — One-time backfill for the Campaign-as-Conversation v0.1 foundation.
 *
 * Two phases per tenant (single transaction per chunk):
 *   1. Create the Always-On Campaign if absent (catch-all routing per Q1 lock).
 *   2. Assign any orphan Pipelines (campaign_id IS NULL) to that Always-On
 *      Campaign so the application-level Pipeline.campaignId guards (Step 5
 *      of KAN-1167) can land safely.
 *
 * Idempotent: re-running is safe (Always-On lookup short-circuits if it exists;
 * Pipeline.updateMany only touches NULL rows).
 *
 * Chunked at 100 tenants per batch to bound memory + Postgres connection
 * pressure across 2000+ tenants.
 *
 * # Sequencing in PROD
 *
 * 1. Deploy migration (Step 2)
 * 2. Run THIS script (must complete before application starts enforcing the
 *    pipelinesRouter.create guard from Step 5)
 * 3. Resume application traffic
 *
 * # Objective dependency
 *
 * Each tenant MUST have at least one Objective row before this backfill runs.
 * The script enumerates `tenant.objective.findFirst({ orderBy: createdAt asc })`
 * and throws with a clear error if none exists. Tenants in mid-onboarding
 * (no Objectives yet) need operator-manual seeding before the backfill can
 * cover them. The script writes per-chunk progress to stdout so the operator
 * can see which tenants block.
 */
import { PrismaClient } from '@prisma/client';
import { ensureAlwaysOnCampaign } from '../../api/src/services/always-on-campaign.js';

const CHUNK_SIZE = 100;

export interface BackfillSummary {
  tenantsScanned: number;
  alwaysOnCreated: number;
  pipelinesReassigned: number;
  tenantsSkipped: { tenantId: string; reason: string }[];
}

async function getDefaultObjectiveForTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<string> {
  const obj = await prisma.objective.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!obj) {
    throw new Error(
      `[backfill KAN-1167] Tenant ${tenantId} has no Objective rows. ` +
        'Seed at least one Objective before running the backfill for this ' +
        'tenant. Operator-manual step required.',
    );
  }
  return obj.id;
}

export async function backfillKan1167(prisma: PrismaClient): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    tenantsScanned: 0,
    alwaysOnCreated: 0,
    pipelinesReassigned: 0,
    tenantsSkipped: [],
  };

  let cursor: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tenants: { id: string }[] = await prisma.tenant.findMany({
      take: CHUNK_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (tenants.length === 0) break;

    // Per-chunk transaction. If any tenant in the chunk throws (e.g., missing
    // Objective), the whole chunk rolls back. Operator fixes the blocker and
    // re-runs the backfill — idempotency guarantees no double-work.
    await prisma.$transaction(async (tx) => {
      for (const tenant of tenants) {
        summary.tenantsScanned++;
        try {
          const objectiveId = await getDefaultObjectiveForTenant(
            tx as unknown as PrismaClient,
            tenant.id,
          );
          const { created } = await ensureAlwaysOnCampaign(
            tx as unknown as PrismaClient,
            { tenantId: tenant.id, objectiveId },
          );
          if (created) summary.alwaysOnCreated++;

          // Phase 2 — assign orphan Pipelines to this tenant's Always-On
          // Re-fetch the Always-On Campaign ID (may have been created above or
          // pre-existed; either way ensureAlwaysOnCampaign returned its id).
          const alwaysOn: { id: string } | null = await (
            tx as unknown as {
              campaign: {
                findFirst: (args: unknown) => Promise<{ id: string } | null>;
              };
            }
          ).campaign.findFirst({
            where: { tenantId: tenant.id, isAlwaysOn: true },
            select: { id: true },
          });
          if (!alwaysOn) {
            // Defensive: ensureAlwaysOnCampaign returned without error so this
            // would be a transactional anomaly. Surface clearly.
            throw new Error(
              `[backfill KAN-1167] Always-On lookup failed for tenant ${tenant.id} ` +
                'after ensureAlwaysOnCampaign succeeded (transaction anomaly).',
            );
          }

          const result = await tx.pipeline.updateMany({
            where: { tenantId: tenant.id, campaignId: null },
            data: { campaignId: alwaysOn.id },
          });
          summary.pipelinesReassigned += result.count;
        } catch (err) {
          // Capture the per-tenant skip reason and re-throw to roll back
          // the chunk. Operator sees both the per-tenant skip context AND
          // the chunk rollback.
          summary.tenantsSkipped.push({
            tenantId: tenant.id,
            reason: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    });

    console.log(
      `[backfill KAN-1167] chunk done — tenantsScanned=${summary.tenantsScanned} ` +
        `alwaysOnCreated=${summary.alwaysOnCreated} ` +
        `pipelinesReassigned=${summary.pipelinesReassigned}`,
    );

    cursor = tenants[tenants.length - 1]?.id;
    if (tenants.length < CHUNK_SIZE) break;
  }

  return summary;
}

// CLI entrypoint — idempotent re-run safe.
if (require.main === module) {
  const prisma = new PrismaClient();
  backfillKan1167(prisma)
    .then(async (s) => {
      console.log('[backfill KAN-1167] complete', s);
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('[backfill KAN-1167] FAILED', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
