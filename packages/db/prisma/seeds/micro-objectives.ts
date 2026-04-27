/**
 * KAN-701 — Platform-default MicroObjective seed.
 *
 * Three jobs:
 *   1. Source-of-truth list: PLATFORM_DEFAULT_MICRO_OBJECTIVES — used by
 *      the migration SQL (in lockstep), per-tenant materialization, and the
 *      backfill script. The migration is canonical for prod inserts; this
 *      module is canonical for the per-tenant clone path.
 *   2. seedPlatformDefaults(prisma) — idempotent upsert of the 5 platform
 *      defaults (tenantId=null). Mirrors the migration; useful in tests +
 *      ephemeral local DBs where the migration may not have run.
 *   3. materializeDefaultsForTenant(prisma, tenantId) — clones the 5
 *      defaults to per-tenant rows (tenantId=<id>, isDefault=false). Called
 *      from the tenant-create flow so every new tenant gets the set.
 *      Idempotent: skips MicroObjectives that already exist for the tenant
 *      with the same name.
 *
 * Matches Fred's confirmed V1 list. Completion-criteria types:
 *   any_reply_received | fields_present (deterministic rules — evaluable today)
 *   intent_extracted | buying_timeframe_extracted | competitor_mentioned
 *     (LLM-evaluated — Sprint 3-4 agentic loop wires the evaluator)
 */

import type { PrismaClient } from '@prisma/client';

export interface PlatformDefaultMicroObjective {
  id: string;
  name: string;
  description: string;
  completionCriteria: Record<string, unknown>;
  order: number;
}

export const PLATFORM_DEFAULT_MICRO_OBJECTIVES: readonly PlatformDefaultMicroObjective[] = [
  {
    id: '8df2c0d3-0001-4001-8001-000000000001',
    name: 'Consumer engagement',
    description: 'Has the recipient replied to any message?',
    completionCriteria: { type: 'any_reply_received', lookback_days: 30 },
    order: 1,
  },
  {
    id: '8df2c0d3-0001-4001-8001-000000000002',
    name: 'Have all relevant contact info',
    description: 'Name, email, phone, company, role',
    completionCriteria: {
      type: 'fields_present',
      fields: ['firstName', 'lastName', 'email', 'phone', 'companyName', 'jobTitle'],
      threshold: 5,
    },
    order: 2,
  },
  {
    id: '8df2c0d3-0001-4001-8001-000000000003',
    name: "Understand what they're trying to accomplish",
    description: 'The use case / pain point',
    completionCriteria: { type: 'intent_extracted', min_confidence: 0.7 },
    order: 3,
  },
  {
    id: '8df2c0d3-0001-4001-8001-000000000004',
    name: 'Know when they want to buy',
    description: 'Buying timeframe',
    completionCriteria: { type: 'buying_timeframe_extracted', min_confidence: 0.6 },
    order: 4,
  },
  {
    id: '8df2c0d3-0001-4001-8001-000000000005',
    name: 'Looking for similar products (competitors)',
    description: 'Competitive awareness',
    completionCriteria: { type: 'competitor_mentioned', min_confidence: 0.7 },
    order: 5,
  },
] as const;

/**
 * Idempotent upsert of the 5 platform defaults (tenantId=null, isDefault=true).
 *
 * In prod, the migration handles this via INSERT ... ON CONFLICT DO NOTHING.
 * This function is the JS-side mirror — used by tests + local dev where the
 * migration may not have run yet. Re-runs are safe.
 */
export async function seedPlatformDefaults(prisma: PrismaClient): Promise<void> {
  for (const mo of PLATFORM_DEFAULT_MICRO_OBJECTIVES) {
    await prisma.microObjective.upsert({
      where: { id: mo.id },
      create: {
        id: mo.id,
        tenantId: null,
        name: mo.name,
        description: mo.description,
        completionCriteria: mo.completionCriteria as object,
        isDefault: true,
        order: mo.order,
      },
      update: {}, // existing row wins; never overwrite tenant customizations
    });
  }
}

/**
 * Clone the 5 platform defaults into per-tenant MicroObjective rows for the
 * given tenant. Skips entries that already exist (matched by name within
 * the tenant scope).
 *
 * Called from the tenant-create flow (best-effort — failure logged but does
 * not block tenant creation; the backfill script can recover stragglers).
 */
export async function materializeDefaultsForTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const mo of PLATFORM_DEFAULT_MICRO_OBJECTIVES) {
    const existing = await prisma.microObjective.findFirst({
      where: { tenantId, name: mo.name },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.microObjective.create({
      data: {
        tenantId,
        name: mo.name,
        description: mo.description,
        completionCriteria: mo.completionCriteria as object,
        // Tenant copies are not platform defaults — they're tenant-owned and
        // freely customizable. Keeping isDefault=false makes the platform-
        // vs-tenant query simple downstream.
        isDefault: false,
        order: mo.order,
      },
    });
    created++;
  }
  return { created, skipped };
}
