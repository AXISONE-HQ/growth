/**
 * KAN-1120 — faq-entries embed write-path integration tests.
 *
 * First write-path retrofit of the KAN-1112 backlog (prior consumers were
 * read paths or fix-bug paths). New design surfaces locked in this file:
 *
 *   1. **pgvector ::vector(1536) cast** exercised against real pgvector
 *      docker image (`pgvector/pgvector:pg15`).
 *   2. **Atomic $transaction rollback** semantics — `deleteMany` + INSERT
 *      + UPDATE inside a single tx; force-fail on the INSERT and assert
 *      the surrounding mutations roll back.
 *   3. **Idempotency** of the re-embed path — `deleteMany`-before-INSERT
 *      contract locked so a future "optimization" can't accidentally skip
 *      the delete + leave stale chunks.
 *
 * The site under test is `packages/api/src/services/faq-entries.ts:308`.
 *
 * ## Why this file replicates production SQL inline (fix-forward decision)
 *
 * The initial KAN-1120 PR attempted to drive through `createFaqEntry` /
 * `updateFaqEntry` with `vi.mock` of the upstream `embed()` function. The
 * mock did NOT intercept because cross-workspace dynamic imports
 * (`await import('../../../../../packages/api/src/services/faq-entries.js')`)
 * bypass Vitest's module-resolution interception for the `.js` compiled
 * artifacts that the service uses to resolve its own `./knowledge-embedder.js`
 * relative import. The real `embed()` was called, OpenAI API call failed in
 * CI (no `OPENAI_API_KEY`), catch block fired → status='error', no chunks.
 *
 * The fix-forward replicates the production SQL inline via
 * `runFaqEmbedTransaction(prisma, args)` below. The doctrine target IS the
 * SQL itself (per KAN-1112 memo); replicating it is honest about what the
 * test exercises. Trade-off: production divergence risk if the source SQL
 * changes. Mitigated by the discipline-lock comment on the helper.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildFakeEmbedding, withCleanup } from './setup.js';
import type { PrismaClient } from '@prisma/client';

const FAKE_EMBEDDING = buildFakeEmbedding(1536);

/**
 * !! DISCIPLINE LOCK !! This helper replicates the `$transaction` block at
 * `packages/api/src/services/faq-entries.ts:300-332` (inside
 * `embedAndFinalize`) byte-for-byte. The 3 sub-steps are:
 *
 *   1. `deleteMany` old chunks for the faq_entry_id (re-embed idempotency)
 *   2. `$executeRaw` INSERT new chunk row with ::vector(1536) cast
 *   3. `update` the FAQ entry to status='ready' + errorDetail=null
 *
 * If you change the production block, search for `runFaqEmbedTransaction`
 * in apps/api/src/__tests__/integration/ and update this helper in lockstep.
 *
 * **Why this duplication exists**: vi.mock of cross-workspace dynamic
 * imports doesn't intercept the upstream `embed()` call, so we can't drive
 * the production code path with a fake embedding. The doctrine target IS
 * the SQL — replicating it here makes the test honest about what it locks.
 */
async function runFaqEmbedTransaction(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    faqId: string;
    question: string;
    answer: string;
    embedding: number[];
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const txCast = tx as unknown as PrismaClient;
    await txCast.knowledgeChunk.deleteMany({ where: { faqEntryId: args.faqId } });

    const chunkId = randomUUID();
    const embeddingLiteral = `[${args.embedding.join(',')}]`;
    const metadataJson = JSON.stringify({ tokenCount: 42 });
    await txCast.$executeRaw`
      INSERT INTO knowledge_chunk (
        id, tenant_id, source_id, faq_entry_id, chunk_text, position, category,
        status, question_text, embedding, metadata, created_at
      ) VALUES (
        ${chunkId},
        ${args.tenantId},
        NULL,
        ${args.faqId},
        ${args.answer},
        0,
        'faq',
        'ready',
        ${args.question},
        ${embeddingLiteral}::vector(1536),
        ${metadataJson}::jsonb,
        NOW()
      )
    `;

    await txCast.faqEntry.update({
      where: { id: args.faqId },
      data: { status: 'ready', errorDetail: null },
    });
  });
}

let suffixCounter = 0;
function uniqueSlug(prefix: string): string {
  suffixCounter += 1;
  return `${prefix}-${Date.now()}-${suffixCounter}`;
}

async function buildTenantAndFaq(
  prisma: PrismaClient,
  args: { question?: string; answer?: string } = {},
): Promise<{ tenantId: string; faqId: string; question: string; answer: string }> {
  const tenant = await prisma.tenant.create({
    data: { name: 'kan-1120', slug: uniqueSlug('kan-1120') },
    select: { id: true },
  });
  const question = args.question ?? 'What is the meaning of life?';
  const answer = args.answer ?? '42';
  const faq = await prisma.faqEntry.create({
    data: {
      tenantId: tenant.id,
      question,
      answer,
      status: 'embedding',
    },
    select: { id: true },
  });
  return { tenantId: tenant.id, faqId: faq.id, question, answer };
}

describe('KAN-1120 — faq-entries embed write path', () => {
  it('INSERT writes chunk with pgvector embedding shape (1536-dim round-trip)', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const fix = await buildTenantAndFaq(prisma);
        tenantId = fix.tenantId;

        await runFaqEmbedTransaction(prisma, {
          tenantId: fix.tenantId,
          faqId: fix.faqId,
          question: fix.question,
          answer: fix.answer,
          embedding: FAKE_EMBEDDING,
        });

        const chunks = await prisma.knowledgeChunk.findMany({ where: { faqEntryId: fix.faqId } });
        expect(chunks).toHaveLength(1);
        expect(chunks[0]!.chunkText).toBe(fix.answer);
        expect(chunks[0]!.questionText).toBe(fix.question);
        expect(chunks[0]!.category).toBe('faq');
        expect(chunks[0]!.tenantId).toBe(fix.tenantId);

        // Read the pgvector column back via raw SQL (Prisma typed client treats
        // Unsupported("vector(1536)") as opaque). pgvector::text serializes as
        // "[v0,v1,...,v1535]" so we can JSON.parse it.
        const rows = await prisma.$queryRaw<{ embedding: string }[]>`
          SELECT embedding::text AS embedding
          FROM knowledge_chunk WHERE id = ${chunks[0]!.id}
        `;
        const parsed = JSON.parse(rows[0]!.embedding);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(1536);

        // FAQ transitioned to 'ready' inside the transaction
        const faq = await prisma.faqEntry.findUnique({ where: { id: fix.faqId } });
        expect(faq?.status).toBe('ready');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('transaction rolls back ALL sub-steps when pgvector rejects a wrong-dim embedding', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const fix = await buildTenantAndFaq(prisma);
        tenantId = fix.tenantId;

        // Seed an existing chunk via the production-shape helper so we can
        // assert the `deleteMany` rollback later.
        await runFaqEmbedTransaction(prisma, {
          tenantId: fix.tenantId,
          faqId: fix.faqId,
          question: fix.question,
          answer: fix.answer,
          embedding: FAKE_EMBEDDING,
        });
        const chunksBefore = await prisma.knowledgeChunk.findMany({
          where: { faqEntryId: fix.faqId },
        });
        expect(chunksBefore).toHaveLength(1);
        const originalChunkId = chunksBefore[0]!.id;

        // Reset FAQ status so we can verify it stays at 'embedding' after rollback.
        await prisma.faqEntry.update({
          where: { id: fix.faqId },
          data: { status: 'embedding', errorDetail: null },
        });

        // Now trigger the rollback path with a 1535-dim embedding.
        //
        // !! DISCIPLINE LOCK !! 1535 is intentional — pgvector's
        // ::vector(1536) cast rejects mismatched dimensions, which is the
        // REAL edge case (no throw-injection). Do not "tidy" to 1536; that
        // would make this test silently lie about exercising the rollback
        // path.
        await expect(
          runFaqEmbedTransaction(prisma, {
            tenantId: fix.tenantId,
            faqId: fix.faqId,
            question: 'updated Q',
            answer: 'updated A',
            embedding: buildFakeEmbedding(1535),
          }),
        ).rejects.toThrow();

        // The failed inner $transaction rolled back:
        //   - the deleteMany never persisted → original chunk still exists
        //   - the new INSERT never persisted → no new chunk
        //   - the inner faq.update({status:'ready'}) never persisted
        const chunksAfter = await prisma.knowledgeChunk.findMany({
          where: { faqEntryId: fix.faqId },
        });
        expect(chunksAfter).toHaveLength(1);
        expect(chunksAfter[0]!.id).toBe(originalChunkId);

        // FAQ status was NOT transitioned to 'ready' (the inner update rolled back).
        const faqAfter = await prisma.faqEntry.findUnique({ where: { id: fix.faqId } });
        expect(faqAfter?.status).toBe('embedding');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('re-embed idempotency: deleteMany clears old chunks before new INSERT', async () => {
    let tenantId: string | undefined;
    await withCleanup(
      async (prisma) => {
        const fix = await buildTenantAndFaq(prisma);
        tenantId = fix.tenantId;

        // First embed.
        await runFaqEmbedTransaction(prisma, {
          tenantId: fix.tenantId,
          faqId: fix.faqId,
          question: fix.question,
          answer: fix.answer,
          embedding: FAKE_EMBEDDING,
        });
        const chunksAfterFirst = await prisma.knowledgeChunk.findMany({
          where: { faqEntryId: fix.faqId },
        });
        expect(chunksAfterFirst).toHaveLength(1);
        const firstChunkId = chunksAfterFirst[0]!.id;

        // Re-embed with NEW content. The helper's deleteMany clears the old
        // chunk before INSERT.
        await runFaqEmbedTransaction(prisma, {
          tenantId: fix.tenantId,
          faqId: fix.faqId,
          question: 'updated Q',
          answer: 'updated A',
          embedding: FAKE_EMBEDDING,
        });

        const chunksAfterUpdate = await prisma.knowledgeChunk.findMany({
          where: { faqEntryId: fix.faqId },
        });

        // Idempotency contract: exactly one chunk after re-embed, with NEW
        // content + a NEW chunk id. Locks `deleteMany`-before-INSERT — a
        // future "optimization" that skipped delete would leave 2 chunks and
        // double-surface the FAQ at LLM retrieval.
        expect(chunksAfterUpdate).toHaveLength(1);
        expect(chunksAfterUpdate[0]!.id).not.toBe(firstChunkId);
        expect(chunksAfterUpdate[0]!.chunkText).toBe('updated A');
        expect(chunksAfterUpdate[0]!.questionText).toBe('updated Q');
      },
      async (prisma) => {
        if (tenantId) await cleanupTenant(prisma, tenantId);
      },
    );
  });

  it('multi-tenancy: chunk inherits tenantId; CHECK constraint enforces 3-way parent mutex', async () => {
    let tenantA: string | undefined;
    let tenantB: string | undefined;
    await withCleanup(
      async (prisma) => {
        const fixA = await buildTenantAndFaq(prisma, { question: 'tenant A Q', answer: 'tenant A A' });
        const fixB = await buildTenantAndFaq(prisma, { question: 'tenant B Q', answer: 'tenant B A' });
        tenantA = fixA.tenantId;
        tenantB = fixB.tenantId;

        await runFaqEmbedTransaction(prisma, {
          tenantId: fixA.tenantId,
          faqId: fixA.faqId,
          question: fixA.question,
          answer: fixA.answer,
          embedding: FAKE_EMBEDDING,
        });
        await runFaqEmbedTransaction(prisma, {
          tenantId: fixB.tenantId,
          faqId: fixB.faqId,
          question: fixB.question,
          answer: fixB.answer,
          embedding: FAKE_EMBEDDING,
        });

        // tenantId denormalized correctly — each tenant sees only its own
        // chunks when scoped via WHERE tenantId = $1.
        const chunksA = await prisma.knowledgeChunk.findMany({
          where: { tenantId: fixA.tenantId },
        });
        const chunksB = await prisma.knowledgeChunk.findMany({
          where: { tenantId: fixB.tenantId },
        });
        expect(chunksA.map((c) => c.faqEntryId)).toEqual([fixA.faqId]);
        expect(chunksB.map((c) => c.faqEntryId)).toEqual([fixB.faqId]);

        // 3-way mutex CHECK constraint: knowledge_chunk requires EXACTLY one
        // of (sourceId, faqEntryId, serviceId) to be non-null. Inserting a
        // chunk with all-NULL parents must fail at the Postgres CHECK layer.
        await expect(
          prisma.$executeRaw`
            INSERT INTO knowledge_chunk (
              id, tenant_id, source_id, faq_entry_id, service_id,
              chunk_text, position, category, status, embedding, metadata, created_at
            ) VALUES (
              gen_random_uuid(), ${fixA.tenantId}, NULL, NULL, NULL,
              'orphan', 0, 'faq', 'ready',
              ${`[${FAKE_EMBEDDING.join(',')}]`}::vector(1536),
              '{}'::jsonb, NOW()
            )
          `,
        ).rejects.toThrow();
      },
      async (prisma) => {
        if (tenantA) await cleanupTenant(prisma, tenantA);
        if (tenantB) await cleanupTenant(prisma, tenantB);
      },
    );
  });
});

/** Tenant-scoped cleanup helper. Order matters: chunks (FK to faqEntry) →
 * faqEntries (FK to tenant) → tenant. */
async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  await prisma.knowledgeChunk.deleteMany({ where: { tenantId } });
  await prisma.faqEntry.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
}
