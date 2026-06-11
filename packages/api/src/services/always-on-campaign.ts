/**
 * KAN-1167 — Always-On Campaign per tenant.
 *
 * Catch-all Campaign that receives inbound leads not matching any active
 * outcome-Campaign's audience. Lowest priority (1000) so any intentional
 * Campaign takes precedence in Decision Engine arbitration.
 *
 * Idempotent: returns the existing Always-On Campaign for the tenant if one
 * exists; only creates if absent. Safe to call multiple times.
 *
 * Q1 lock from the June 11 brainstorm — see KAN-1166 epic doc.
 *
 * # Objective dependency
 *
 * Campaign.objectiveId is a REQUIRED + Restrict-on-delete FK. The caller MUST
 * supply an objectiveId; this helper does not seed an Objective. Sequencing
 * is the caller's responsibility:
 *   - Backfill script (Step 4): looks up the tenant's first existing Objective
 *     and throws with a clear error if none exists (manual operator step).
 *   - Tenant.create hook (Step 3 wire-up): DEFERRED to Senior PO architectural
 *     decision (HALT in Phase 2 build report). See KAN-1167 PR description.
 */
import type { PrismaClient } from '@prisma/client';

export const ALWAYS_ON_CAMPAIGN_NAME = 'Always-On (catch-all)';
/** Lowest priority — every intentional Campaign outranks Always-On in arbitration. */
export const ALWAYS_ON_CAMPAIGN_PRIORITY = 1000;

export interface EnsureAlwaysOnCampaignParams {
  tenantId: string;
  /**
   * Required: an existing Objective row owned by this tenant. Caller is
   * responsible for sequencing (e.g., backfill enumerates tenant Objectives
   * BEFORE calling). Helper throws if the Objective doesn't exist (FK
   * Restrict at Postgres level), preserving schema integrity.
   */
  objectiveId: string;
}

export interface EnsureAlwaysOnCampaignResult {
  campaignId: string;
  /** TRUE if this call created the Campaign; FALSE if it already existed. */
  created: boolean;
}

export async function ensureAlwaysOnCampaign(
  prisma: PrismaClient,
  params: EnsureAlwaysOnCampaignParams,
): Promise<EnsureAlwaysOnCampaignResult> {
  // Idempotency guard: cast-loose access because the new isAlwaysOn column was
  // added in the same migration as the helper's first caller; the generated
  // Prisma type sometimes lags compile-time visibility during the cross-PR
  // sequence. This pattern matches sibling new-field additions across the
  // KAN-1140 substrate.
  const existing = await (prisma as unknown as {
    campaign: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
  }).campaign.findFirst({
    where: { tenantId: params.tenantId, isAlwaysOn: true },
    select: { id: true },
  });

  if (existing) return { campaignId: existing.id, created: false };

  const created = await (prisma as unknown as {
    campaign: { create: (args: unknown) => Promise<{ id: string }> };
  }).campaign.create({
    data: {
      tenantId: params.tenantId,
      name: ALWAYS_ON_CAMPAIGN_NAME,
      objectiveId: params.objectiveId,
      audienceConditions: {}, // empty — Always-On matches all unaffiliated leads
      audienceMode: 'static',
      isAlwaysOn: true,
      status: 'active',
      priority: ALWAYS_ON_CAMPAIGN_PRIORITY,
      // No goal_* fields — Always-On is intent-less; it routes inbound leads
      // without prescribing an outcome target.
      // No windowStart/windowEnd — perpetual catch-all.
    },
    select: { id: true },
  });

  return { campaignId: created.id, created: true };
}
