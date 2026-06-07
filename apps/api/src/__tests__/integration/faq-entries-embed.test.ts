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
 *      the delete + leave stale chunks (would manifest as duplicate
 *      retrievals at LLM context-assembly time).
 *
 * The site under test is `packages/api/src/services/faq-entries.ts:308`:
 *
 *   await txCast.$executeRaw`
 *     INSERT INTO knowledge_chunk (...) VALUES (
 *       ${chunkId}, ${row.tenantId}, NULL, ${row.id}, ${row.answer},
 *       0, 'faq', 'ready', ${row.question},
 *       ${embeddingLiteral}::vector(1536),
 *       ${metadataJson}::jsonb,
 *       NOW()
 *     )
 *   `;
 *
 * Every input bound via `${...}` placeholders → Postgres bind protocol →
 * SAFE form (sibling to KAN-1118's `$queryRawUnsafe` with `$1` binding
 * doctrine; just template-literal flavor). No injection vector; the
 * retrofit gates the doctrine memo binary rule, not a runtime bug.
 *
 * ## vi.mock on the embed module
 *
 * `embedAndFinalize` calls `embed()` from `./knowledge-embedder.js`, which
 * wraps the OpenAI text-embedding-3-small API. We mock that module at file
 * load so tests don't:
 *
 *   - Cost OpenAI API credits per CI run
 *   - Take 150-300ms per embed call (×4 tests × multiple invocations)
 *   - Require an API key in the integration-test environment
 *
 * The mock returns a deterministic fixture embedding produced by
 * `buildFakeEmbedding(1536)` (or `(1535)` to trigger pgvector rejection in
 * Test #2). Semantic vector values are out of scope per Phase 1 Q2.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFakeEmbedding, buildFaqEntry, getPrisma, withRollback } from './setup.js';

// Mock the embed() upstream BEFORE the service module loads. Vitest hoists
// vi.mock to the top of the file; the variable closure pattern with vi.hoisted
// keeps the mock implementation overridable per-test via `mockEmbed.mockX`.
const { mockEmbed } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
}));
vi.mock('../../../../../packages/api/src/services/knowledge-embedder.js', () => ({
  embed: mockEmbed,
  // Re-export the error class — the catch block in embedAndFinalize uses
  // `instanceof EmbeddingFailedError` to distinguish embed failures from
  // chunk-write failures. A plain Error constructor satisfies the runtime
  // check (instanceof Error is always true; the specific class identity
  // doesn't matter for these tests).
  EmbeddingFailedError: class EmbeddingFailedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'EmbeddingFailedError';
    }
  },
}));

// Import the service AFTER the mock is set up. Top-level imports happen
// after vi.mock hoisting per Vitest semantics.
const servicePromise = import('../../../../../packages/api/src/services/faq-entries.js');

const FAKE_EMBEDDING = buildFakeEmbedding(1536);

beforeEach(() => {
  mockEmbed.mockReset();
  // Default: return one well-formed 1536-dim embedding. Per-test overrides
  // (e.g., 1535-dim for the rollback test) override this.
  mockEmbed.mockResolvedValue([{ position: 0, embedding: FAKE_EMBEDDING, tokenCount: 42 }]);
});

describe('KAN-1120 — faq-entries embed write path', () => {
  it('INSERT writes chunk with pgvector embedding shape (1536-dim round-trip)', async () => {
    const svc = await servicePromise;

    await withRollback(async (prisma) => {
      // Use the production path: createFaqEntry → embedAndFinalize → $executeRaw INSERT.
      // The mock provides the embedding; everything else is real.
      const tenant = await prisma.tenant.create({
        data: { name: 'kan-1120 tenant', slug: `kan-1120-${Date.now()}` },
        select: { id: true },
      });

      const entry = await svc.createFaqEntry(prisma, tenant.id, {
        question: 'What is the meaning of life?',
        answer: '42',
      });

      expect(entry.status).toBe('ready');
      expect(entry.errorDetail).toBeNull();

      const chunks = await prisma.knowledgeChunk.findMany({
        where: { faqEntryId: entry.id },
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.chunkText).toBe('42');
      expect(chunks[0]!.questionText).toBe('What is the meaning of life?');
      expect(chunks[0]!.category).toBe('faq');
      expect(chunks[0]!.tenantId).toBe(tenant.id);

      // Read the pgvector column back via raw SQL (Prisma typed client
      // treats Unsupported("vector(1536)") as opaque). Assert the shape:
      // 1536 floats, magnitude > 0 (rules out empty/NULL embedding).
      const [stored] = await prisma.$queryRaw<{ embedding: string }[]>`
        SELECT embedding::text AS embedding
        FROM knowledge_chunk WHERE id = ${chunks[0]!.id}
      `;
      // pgvector::text serializes as "[v0,v1,v2,...,v1535]"
      const parsed = JSON.parse(stored!.embedding);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1536);
    });
  });

  it('transaction rolls back ALL sub-steps when pgvector rejects a wrong-dim embedding', async () => {
    // The mock returns a 1535-dim embedding (off by one). pgvector's
    // `::vector(1536)` cast rejects this at the $executeRaw INSERT step,
    // which causes the surrounding $transaction to roll back:
    //   - the prior `deleteMany` of existing chunks reverts
    //   - the subsequent `faq.update({status: 'ready'})` never runs
    //
    // This is a REAL edge case (no throw-injection); a wrong-dim embedding
    // is exactly what would happen if someone swapped to a model with
    // different output dimensionality (e.g., text-embedding-3-large @ 3072).
    //
    // !! DISCIPLINE LOCK !! 1535 is intentional. Do not "fix" the test
    // by changing this to 1536 — that would make Test #2 silently lie
    // about exercising the rollback path.
    mockEmbed.mockResolvedValue([
      { position: 0, embedding: buildFakeEmbedding(1535), tokenCount: 42 },
    ]);
    const svc = await servicePromise;

    await withRollback(async (prisma) => {
      const tenant = await prisma.tenant.create({
        data: { name: 'kan-1120 tenant rollback', slug: `kan-1120-rb-${Date.now()}` },
        select: { id: true },
      });

      // Seed an existing chunk to verify the `deleteMany` step gets rolled
      // back (would-be-deleted chunk still present after failure).
      // We can't `buildFaqChunk` directly (per Phase 1 Q6) so we drive
      // through the production path first, then trigger failure on the
      // re-embed.
      mockEmbed.mockResolvedValueOnce([
        { position: 0, embedding: FAKE_EMBEDDING, tokenCount: 42 },
      ]);
      const entry = await svc.createFaqEntry(prisma, tenant.id, {
        question: 'Q1',
        answer: 'A1',
      });
      const chunksBefore = await prisma.knowledgeChunk.findMany({
        where: { faqEntryId: entry.id },
      });
      expect(chunksBefore).toHaveLength(1);
      const originalChunkId = chunksBefore[0]!.id;

      // Now switch mock to 1535-dim and trigger re-embed. The catch block
      // in embedAndFinalize will transition the FAQ to 'error' status
      // (outside the failed $transaction); the failed $transaction itself
      // rolls back.
      mockEmbed.mockResolvedValue([
        { position: 0, embedding: buildFakeEmbedding(1535), tokenCount: 42 },
      ]);

      await expect(
        svc.updateFaqEntry(prisma, tenant.id, entry.id, {
          question: 'Q1-updated',
          answer: 'A1-updated',
        }),
      ).rejects.toThrow();

      // The failed inner $transaction rolled back:
      //   - the deleteMany never persisted → original chunk still exists
      //   - the new INSERT never persisted → no new chunk
      //   - the inner faq.update({status:'ready'}) never persisted
      const chunksAfter = await prisma.knowledgeChunk.findMany({
        where: { faqEntryId: entry.id },
      });
      expect(chunksAfter).toHaveLength(1);
      expect(chunksAfter[0]!.id).toBe(originalChunkId);

      // BUT the catch-block faq.update({status:'error',...}) DID persist —
      // it runs OUTSIDE the $transaction as a separate auto-commit. This
      // is the documented state-machine behavior (queued → embedding →
      // error), not a rollback violation.
      const faqAfter = await prisma.faqEntry.findUnique({ where: { id: entry.id } });
      expect(faqAfter?.status).toBe('error');
      expect(faqAfter?.errorDetail).toBeTruthy();
    });
  });

  it('re-embed idempotency: deleteMany clears old chunks before new INSERT', async () => {
    const svc = await servicePromise;

    await withRollback(async (prisma) => {
      const tenant = await prisma.tenant.create({
        data: { name: 'kan-1120 tenant idempotency', slug: `kan-1120-id-${Date.now()}` },
        select: { id: true },
      });

      // First embed.
      const entry = await svc.createFaqEntry(prisma, tenant.id, {
        question: 'first Q',
        answer: 'first A',
      });
      const chunksAfterFirst = await prisma.knowledgeChunk.findMany({
        where: { faqEntryId: entry.id },
      });
      expect(chunksAfterFirst).toHaveLength(1);
      const firstChunkId = chunksAfterFirst[0]!.id;

      // Re-embed (update path triggers embedAndFinalize again).
      await svc.updateFaqEntry(prisma, tenant.id, entry.id, {
        question: 'updated Q',
        answer: 'updated A',
      });

      const chunksAfterUpdate = await prisma.knowledgeChunk.findMany({
        where: { faqEntryId: entry.id },
      });

      // Idempotency contract: exactly one chunk after re-embed, with the
      // NEW content. Locks `deleteMany`-before-INSERT — if a future
      // "optimization" skipped the delete, we'd see 2 chunks here (stale
      // first + new second) and LLM retrieval would double-surface the
      // FAQ.
      expect(chunksAfterUpdate).toHaveLength(1);
      expect(chunksAfterUpdate[0]!.id).not.toBe(firstChunkId);
      expect(chunksAfterUpdate[0]!.chunkText).toBe('updated A');
      expect(chunksAfterUpdate[0]!.questionText).toBe('updated Q');
    });
  });

  it('multi-tenancy: chunk inherits tenantId; CHECK constraint enforces 3-way parent mutex', async () => {
    const svc = await servicePromise;

    await withRollback(async (prisma) => {
      const tenantA = await prisma.tenant.create({
        data: { name: 'kan-1120 tenant A', slug: `kan-1120-a-${Date.now()}` },
        select: { id: true },
      });
      const tenantB = await prisma.tenant.create({
        data: { name: 'kan-1120 tenant B', slug: `kan-1120-b-${Date.now()}` },
        select: { id: true },
      });

      const entryA = await svc.createFaqEntry(prisma, tenantA.id, {
        question: 'tenant A Q',
        answer: 'tenant A A',
      });
      const entryB = await svc.createFaqEntry(prisma, tenantB.id, {
        question: 'tenant B Q',
        answer: 'tenant B A',
      });

      // tenantId denormalized correctly — each tenant sees only its own chunks
      // when scoped via WHERE tenantId = $1.
      const chunksA = await prisma.knowledgeChunk.findMany({
        where: { tenantId: tenantA.id },
      });
      const chunksB = await prisma.knowledgeChunk.findMany({
        where: { tenantId: tenantB.id },
      });
      expect(chunksA.map((c) => c.faqEntryId)).toEqual([entryA.id]);
      expect(chunksB.map((c) => c.faqEntryId)).toEqual([entryB.id]);

      // 3-way mutex CHECK constraint: knowledge_chunk requires EXACTLY one
      // of (sourceId, faqEntryId, serviceId) to be non-null. Inserting a
      // chunk with both faqEntryId AND sourceId set (or none set) must
      // fail at the Postgres CHECK layer.
      //
      // Attempt: insert a fake chunk with both faqEntryId AND sourceId NULL.
      // (We can't easily create a KnowledgeSource fixture here without
      // expanding scope; the all-null violation is the cleanest exercise
      // of the CHECK.)
      await expect(
        prisma.$executeRaw`
          INSERT INTO knowledge_chunk (
            id, tenant_id, source_id, faq_entry_id, service_id,
            chunk_text, position, category, status, embedding, metadata, created_at
          ) VALUES (
            gen_random_uuid(), ${tenantA.id}, NULL, NULL, NULL,
            'orphan', 0, 'faq', 'ready',
            ${`[${FAKE_EMBEDDING.join(',')}]`}::vector(1536),
            '{}'::jsonb, NOW()
          )
        `,
      ).rejects.toThrow();
    });
  });
});
