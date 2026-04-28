/**
 * KAN-706 backfill — synthetic KnowledgeSource records for legacy KnowledgeBase rows.
 *
 * Each existing `knowledge_base` row gets a synthetic `KnowledgeSource` of
 * type=structured_field with status=indexed (legacy content was already trained
 * into the AI brain). The synthetic source's content_hash is derived from the
 * KnowledgeBase row's id to keep the backfill idempotent — re-running the
 * script after partial completion picks up only the rows that don't yet have a
 * matching synthetic source.
 *
 * On the current axisone-growth tenant (2026-04-28), the audit shows zero
 * `knowledge_base` rows — the script processes nothing on this run but ships
 * idempotent + future-proof. Future tenants seeded with structured-field
 * knowledge will get backfilled on first run.
 *
 * Usage:
 *   DATABASE_URL='postgresql://...' tsx packages/db/scripts/backfill-knowledge-sources.ts
 *
 * Safe to re-run. Logs row counts before / after.
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  const before = {
    knowledgeBase: await prisma.knowledgeBase.count(),
    knowledgeSources: await prisma.knowledgeSource.count(),
  };
  console.log("[backfill] BEFORE:", JSON.stringify(before));

  // Pull legacy KnowledgeBase rows that don't yet have a synthetic source.
  // Idempotency key: content_hash = sha256("kb:" + knowledge_base.id).
  // Re-running the script never duplicates because the (tenantId, contentHash)
  // unique index rejects the second insert.
  const legacy = await prisma.knowledgeBase.findMany({
    select: { id: true, tenantId: true, category: true, createdAt: true },
  });

  let created = 0;
  let skipped = 0;

  for (const row of legacy) {
    const contentHash = createHash("sha256").update(`kb:${row.id}`).digest("hex");
    try {
      await prisma.knowledgeSource.create({
        data: {
          tenantId: row.tenantId,
          type: "structured_field",
          status: "indexed",
          contentHash,
          lastIndexedAt: row.createdAt,
          createdBy: null, // system-generated
        },
      });
      created += 1;
    } catch (e: any) {
      // Unique constraint violation = already backfilled. Idempotent skip.
      if (e?.code === "P2002") {
        skipped += 1;
      } else {
        console.error(`[backfill] FAILED on knowledge_base.id=${row.id}:`, e);
        throw e;
      }
    }
  }

  const after = {
    knowledgeBase: await prisma.knowledgeBase.count(),
    knowledgeSources: await prisma.knowledgeSource.count(),
  };
  console.log("[backfill] AFTER:", JSON.stringify(after));
  console.log(`[backfill] created=${created} skipped=${skipped}`);

  if (created === 0 && skipped === 0 && legacy.length === 0) {
    console.log("[backfill] no legacy knowledge_base rows — no-op");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
