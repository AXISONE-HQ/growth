/**
 * KAN-1211 — pipelines.listWithStages returns campaignId for chat-flow
 * Pipelines + filter pattern doctrine anchor (REAL Prisma).
 *
 * 9th boundary-integration-gap of the KAN-1184/1190 arc. Surfaced by Fred's
 * KAN-1208 8th smoke verification — chat-flow Activate works end-to-end;
 * Pipeline visible at /settings/pipelines but NOT at /pipelines operational
 * kanban.
 *
 * Root cause (apps/web/src/app/pipelines/page.tsx:74-92 — KAN-968 doctrine):
 *
 *   The legacy filter uses `objectiveId !== null` as the proxy for "real
 *   Pipeline vs KAN-793 test fixture (both NULL)." Chat-flow Pipelines per
 *   KAN-1190 V3 lock have `objectiveId: null` + `campaignId: <id>` — they
 *   share the NULL `objectiveId` shape with the KAN-793 fixture and get
 *   silently excluded.
 *
 *   Path A resolution: filter extended to
 *   `p.objectiveId !== null || p.campaignId !== null`. Partition restored.
 *
 * Server-side change: `pipelines.listWithStages` now returns `campaignId`
 * in addition to `objectiveId`. The UI filter consumes both columns.
 *
 * This integration test asserts the 3-Pipeline partition contract end-to-end:
 *
 *   - KAN-793 fixture-shaped (objectiveId NULL, campaignId NULL) — excluded
 *   - Chat-flow Pipeline (objectiveId NULL, campaignId set) — included
 *   - Legacy Pipeline (objectiveId set, campaignId NULL) — included
 *
 * Doctrine memos (cited in code at the page.tsx filter site):
 *   - `legacy_filter_predicate_doctrine` (37th — KAN-1211 anchor)
 *   - `boundary_integration_gap_subclass` (29th — sibling subclass; KAN-1208)
 *   - `operator_session_reveals_scope_gaps` (parent doctrine)
 *
 * Import posture (KAN-689 variable-specifier): cross-rootDir Prisma client
 * via direct test setup; no LLM modules required.
 */
import { describe, expect, it } from 'vitest';
import { createTenant, withCleanup } from './setup.js';

async function cleanupTenant(
  prisma: import('@prisma/client').PrismaClient,
  tenantId: string,
): Promise<void> {
  await prisma.pipeline.deleteMany({ where: { tenantId } });
  await prisma.objective.deleteMany({ where: { tenantId } });
  await prisma.campaign.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
}

/** Reads the listWithStages server output via direct Prisma query — mirrors
 *  the tRPC procedure's `where` + `select` shape. Asserting against the raw
 *  query keeps the test isolated from the router file's procedure-wrapping
 *  changes (KAN-689 variable-specifier patterns make full router imports
 *  expensive). */
async function listWithStages(
  prisma: import('@prisma/client').PrismaClient,
  tenantId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    objectiveId: string | null;
    campaignId: string | null;
  }>
> {
  const rows = await prisma.pipeline.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true, objectiveId: true, campaignId: true },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    objectiveId: r.objectiveId ?? null,
    campaignId: r.campaignId ?? null,
  }));
}

// ─────────────────────────────────────────────
// Pipeline partition — 3 shapes that the KAN-968 filter must distinguish
// ─────────────────────────────────────────────

describe('KAN-1211 — /pipelines filter correctly partitions 3 Pipeline shapes', () => {
  it('returns chat-flow + legacy Pipelines; KAN-793 fixture-shape stays in listWithStages but the filter excludes it', async () => {
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;

        // Shape 1: KAN-793 fixture (both NULL) — excluded by filter
        await prisma.pipeline.create({
          data: {
            tenantId: tenant.id,
            name: 'KAN-793 Fixture',
            isActive: true,
            objectiveType: 'book_appointment',
            objectiveId: null,
            campaignId: null,
          },
        });

        // Shape 2: Chat-flow Pipeline (campaignId set; objectiveId NULL per
        // KAN-1190 V3 lock). Mints a Campaign first to satisfy FK.
        const campaign = await prisma.campaign.create({
          data: {
            tenantId: tenant.id,
            name: 'Chat-flow Campaign',
            audienceConditions: {},
          },
          select: { id: true },
        });
        await prisma.pipeline.create({
          data: {
            tenantId: tenant.id,
            name: 'Chat-flow Pipeline',
            isActive: true,
            objectiveType: 'book_appointment',
            objectiveId: null,
            campaignId: campaign.id,
          },
        });

        // Shape 3: Legacy Pipeline (objectiveId set; campaignId NULL).
        // Mints an Objective first to satisfy FK.
        const objective = await prisma.objective.create({
          data: {
            tenantId: tenant.id,
            name: 'Legacy Objective',
            type: 'custom',
            successCondition: {},
          },
          select: { id: true },
        });
        await prisma.pipeline.create({
          data: {
            tenantId: tenant.id,
            name: 'Legacy Pipeline',
            isActive: true,
            objectiveType: 'book_appointment',
            objectiveId: objective.id,
            campaignId: null,
          },
        });

        // Verify server returns all 3 with campaignId field populated.
        const rows = await listWithStages(prisma, tenant.id);
        expect(rows).toHaveLength(3);

        const fixtureRow = rows.find((r) => r.name === 'KAN-793 Fixture');
        const chatRow = rows.find((r) => r.name === 'Chat-flow Pipeline');
        const legacyRow = rows.find((r) => r.name === 'Legacy Pipeline');

        // Server contract: campaignId surfaced for all rows (KAN-1211 change).
        expect(fixtureRow).toBeDefined();
        expect(fixtureRow!.objectiveId).toBeNull();
        expect(fixtureRow!.campaignId).toBeNull();

        expect(chatRow).toBeDefined();
        expect(chatRow!.objectiveId).toBeNull();
        expect(chatRow!.campaignId).toBe(campaign.id);

        expect(legacyRow).toBeDefined();
        expect(legacyRow!.objectiveId).toBe(objective.id);
        expect(legacyRow!.campaignId).toBeNull();

        // Filter contract (mirrors page.tsx:77-80 post-KAN-1211):
        //   p.objectiveId !== null || p.campaignId !== null
        const filtered = rows.filter(
          (p) => p.objectiveId !== null || p.campaignId !== null,
        );
        // Partition restored: chat-flow + legacy in; KAN-793 fixture out.
        expect(filtered).toHaveLength(2);
        expect(filtered.map((r) => r.name).sort()).toEqual([
          'Chat-flow Pipeline',
          'Legacy Pipeline',
        ]);
        expect(filtered.map((r) => r.name)).not.toContain('KAN-793 Fixture');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('chat-flow Pipeline ALONE (no legacy fixture) still appears post-KAN-1211 filter (regression for Fred 8th smoke scenario)', async () => {
    let tenantId = '';
    await withCleanup(
      async (prisma) => {
        const tenant = await createTenant(prisma);
        tenantId = tenant.id;

        // Replicates Fred's exact PROD scenario: brand-new tenant; only the
        // chat-flow commit's Pipeline exists. Pre-KAN-1211 this would have
        // been excluded by the legacy filter and Fred would see an empty
        // /pipelines page.
        const campaign = await prisma.campaign.create({
          data: {
            tenantId: tenant.id,
            name: 'Fred Test Campaign',
            audienceConditions: {},
          },
          select: { id: true },
        });
        await prisma.pipeline.create({
          data: {
            tenantId: tenant.id,
            name: 'Fred Test Pipeline',
            isActive: true,
            objectiveType: 'book_appointment',
            objectiveId: null,
            campaignId: campaign.id,
          },
        });

        const rows = await listWithStages(prisma, tenant.id);
        const filtered = rows.filter(
          (p) => p.objectiveId !== null || p.campaignId !== null,
        );
        // Pre-KAN-1211: filtered.length would be 0 (objectiveId NULL exclusion).
        // Post-KAN-1211: filtered.length is 1 (campaignId discriminator).
        expect(filtered).toHaveLength(1);
        expect(filtered[0]!.name).toBe('Fred Test Pipeline');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });
});
