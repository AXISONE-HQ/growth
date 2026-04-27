/**
 * KAN-701 — One-off backfill: clone the 5 platform-default MicroObjectives
 * into per-tenant rows for every existing tenant.
 *
 * Run once post-merge for axisone + gorush (and any other tenants present
 * before KAN-701 wired the auto-clone into the tenant-create flow). The
 * tenant signup hook handles new tenants going forward.
 *
 * Idempotent: materializeDefaultsForTenant skips per-tenant rows that
 * already exist (matched by name within the tenant scope). Re-running this
 * script is safe.
 *
 * Run from a shell with prod DATABASE_URL access (e.g. via Cloud SQL Auth
 * Proxy on 5432, same setup the KAN-709 GHA workflow uses):
 *
 *   cd packages/db && DATABASE_URL='postgresql://...' npx tsx scripts/backfill-microobjectives-existing-tenants.ts
 */

import { PrismaClient } from '@prisma/client';
import { materializeDefaultsForTenant } from '../prisma/seeds/micro-objectives.js';

async function main() {
  const prisma = new PrismaClient();
  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, slug: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`[backfill] ${tenants.length} tenants to process`);

    let totalCreated = 0;
    let totalSkipped = 0;
    for (const t of tenants) {
      const result = await materializeDefaultsForTenant(prisma, t.id);
      console.log(
        `[backfill] tenant=${t.slug} (${t.id}) created=${result.created} skipped=${result.skipped}`,
      );
      totalCreated += result.created;
      totalSkipped += result.skipped;
    }

    console.log(
      `[backfill] DONE — tenants=${tenants.length} createdRows=${totalCreated} skippedRows=${totalSkipped}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
