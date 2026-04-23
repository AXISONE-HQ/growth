/**
 * Backfill script — KAN-649 Step 4 demo.
 *
 * Runs decisions.runForContact once against every Contact in a tenant that
 * has zero Decision rows. Idempotent — safe to re-run.
 *
 * Usage:
 *   cd apps/api
 *   npx tsx scripts/backfill-decisions.ts --tenant <tenantId>
 *
 * Or grab the AxisOne Growth tenant by slug:
 *   npx tsx scripts/backfill-decisions.ts --tenant-slug axisone-growth
 *
 * File location: apps/api/scripts/backfill-decisions.ts
 */

import { PrismaClient } from '@prisma/client';
import { runDecisionForContact } from '@growth/api/services/run-decision-for-contact';

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce<[string, string][]>((acc, cur, i, arr) => {
      if (cur.startsWith('--') && arr[i + 1] && !arr[i + 1].startsWith('--')) {
        acc.push([cur.slice(2), arr[i + 1]]);
      }
      return acc;
    }, [])
  );

  const prisma = new PrismaClient();

  const tenant = args['tenant']
    ? await prisma.tenant.findUnique({ where: { id: args['tenant'] } })
    : args['tenant-slug']
    ? await prisma.tenant.findUnique({ where: { slug: args['tenant-slug'] } })
    : null;

  if (!tenant) {
    console.error('❌ Tenant not found. Pass --tenant <id> or --tenant-slug <slug>.');
    process.exit(1);
  }

  console.log(`🎯 Backfilling decisions for tenant: ${tenant.name} (${tenant.id})`);

  const contacts = await prisma.contact.findMany({
    where: {
      tenantId: tenant.id,
      decisions: { none: {} },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`📋 Found ${contacts.length} contact(s) with no prior decisions.`);

  if (contacts.length === 0) {
    console.log('✅ Nothing to do. Exiting.');
    return;
  }

  const results: Array<{ contactId: string; name: string; outcome: string; confidence: number; strategy: string; latencyMs: number; error?: string }> = [];

  for (const contact of contacts) {
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || contact.id;
    try {
      console.log(`\n─── Running Decision Engine for ${name} ───`);
      const r = await runDecisionForContact(prisma, {
        tenantId: tenant.id,
        contactId: contact.id,
        actor: { type: 'SYSTEM', id: 'backfill-decisions.ts' },
      });
      results.push({
        contactId: contact.id,
        name,
        outcome: r.outcome,
        confidence: Math.round(r.confidence * 100),
        strategy: r.strategy,
        latencyMs: r.latencyMs,
      });
      console.log(`✅ ${name}: ${r.outcome} — ${r.strategy} (${Math.round(r.confidence * 100)}% conf, ${r.latencyMs}ms)`);
      console.log(`   Reasoning: ${r.reasoning}`);
    } catch (err) {
      console.error(`❌ ${name}:`, err instanceof Error ? err.message : err);
      results.push({ contactId: contact.id, name, outcome: 'ERROR', confidence: 0, strategy: '-', latencyMs: 0, error: String(err) });
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('📊 Backfill summary');
  console.log('═══════════════════════════════════════════');
  console.table(results);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
