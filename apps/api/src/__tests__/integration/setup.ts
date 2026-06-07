/**
 * KAN-1112 — Integration test setup: Prisma test client + fixture builders.
 *
 * Discipline boundary (Phase 1 Q3 lock):
 * - Per-test transaction rollback — every test wraps work in `prisma.$transaction`
 *   and throws at the end to roll back. No cross-test pollution; no manual
 *   cleanup ceremony.
 * - Programmatic fixture builders — small helpers that synthesize Tenant /
 *   Blueprint / Contact / Deal rows for the specific bug shape under test.
 *   Builders are minimal: only the columns the assertion exercises are
 *   populated; everything else takes Prisma defaults.
 *
 * The shared Prisma client is module-scoped; tests `import { withRollback } from
 * './setup'` and call it once per `it(...)` block. The client connects on
 * first use and is reused across tests in the same file. Vitest tears down
 * connections at process exit (no explicit `afterAll(disconnect)` needed —
 * Prisma's process-exit handler covers it).
 *
 * DATABASE_URL is read from the env at module-load time (per vitest.config.integration.ts).
 */
import { Prisma, PrismaClient } from '@prisma/client';

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }
  return _prisma;
}

/**
 * Runs `fn` inside a transaction that is ALWAYS rolled back. The test asserts
 * against the in-transaction state; nothing persists. This is the canonical
 * isolation pattern for integration tests against a shared Postgres.
 *
 * Implementation: we throw a sentinel error after `fn` resolves so Prisma
 * rolls back. The sentinel is caught here so it doesn't surface to the test.
 * Any other error inside `fn` propagates normally.
 */
const ROLLBACK_SENTINEL = Symbol('integration-test-rollback');

export async function withRollback<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = getPrisma();
  let result: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      result = await fn(tx as unknown as PrismaClient);
      throw ROLLBACK_SENTINEL;
    });
  } catch (err) {
    if (err !== ROLLBACK_SENTINEL) throw err;
  }
  return result as T;
}

/**
 * KAN-1119 — Concurrency-test isolation helper. Sibling to `withRollback`.
 *
 * The transaction-rollback pattern can't be used for concurrent-claim tests
 * because Prisma's $transaction ISOLATES the inner work — concurrent claims
 * from "two workers" inside one rollback transaction would see each other's
 * uncommitted state, masking the actual race semantics.
 *
 * `withCleanup` runs `fn` against the live database (committed writes) and
 * runs `cleanup` in `finally` so artifacts don't pollute subsequent tests.
 * Cleanup callback is responsible for deleting any fixture rows it created
 * (typically via `prisma.deferredSend.deleteMany({ where: { tenantId } })`
 * scoped to the tenant created in the test).
 *
 * Caller pattern:
 *
 *   await withCleanup(
 *     async (prisma) => { ... fixture builders + test work ... },
 *     async (prisma) => {
 *       await prisma.deferredSend.deleteMany({ where: { tenantId } });
 *       await prisma.contact.deleteMany({ where: { tenantId } });
 *       await prisma.tenant.delete({ where: { id: tenantId } });
 *     },
 *   );
 */
export async function withCleanup<T>(
  fn: (prisma: PrismaClient) => Promise<T>,
  cleanup: (prisma: PrismaClient) => Promise<void>,
): Promise<T> {
  const prisma = getPrisma();
  try {
    return await fn(prisma);
  } finally {
    await cleanup(prisma).catch((err) => {
      // Test cleanup failures shouldn't mask the actual test error; log + continue.
      console.warn(`[withCleanup] cleanup failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Fixture builders (Phase 1 Q3 lock: programmatic, not seed scripts)
// ────────────────────────────────────────────────────────────────────

let _counter = 0;
function uniqueSuffix(): string {
  _counter += 1;
  return `${Date.now()}-${_counter}`;
}

export async function createTenant(
  prisma: PrismaClient,
  overrides: { blueprintId?: string | null } = {},
): Promise<{ id: string }> {
  const slug = `test-tenant-${uniqueSuffix()}`;
  return prisma.tenant.create({
    data: {
      name: `Test Tenant ${slug}`,
      slug,
      blueprintId: overrides.blueprintId ?? null,
    },
    select: { id: true },
  });
}

export async function createBlueprint(
  prisma: PrismaClient,
  overrides: { isActive?: boolean; vertical?: string } = {},
): Promise<{ id: string }> {
  return prisma.blueprint.create({
    data: {
      vertical: overrides.vertical ?? 'generic_b2b',
      customerModel: {},
      journeys: {},
      strategyTemplates: {},
      isActive: overrides.isActive ?? true,
    },
    select: { id: true },
  });
}

export async function createContact(
  prisma: PrismaClient,
  tenantId: string,
): Promise<{ id: string }> {
  return prisma.contact.create({
    data: {
      tenantId,
      email: `contact-${uniqueSuffix()}@test.local`,
    },
    select: { id: true },
  });
}

export async function createPipeline(
  prisma: PrismaClient,
  tenantId: string,
): Promise<{ id: string; stageId: string }> {
  const pipeline = await prisma.pipeline.create({
    data: {
      tenantId,
      name: `Test Pipeline ${uniqueSuffix()}`,
      objectiveType: 'book_appointment',
      stages: {
        create: {
          name: 'Initial',
          order: 0,
          isInitial: true,
        },
      },
    },
    select: { id: true, stages: { select: { id: true } } },
  });
  return { id: pipeline.id, stageId: pipeline.stages[0]!.id };
}

export async function createDeal(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    pipelineId: string;
    stageId: string;
    value?: number;
    status?: 'open' | 'won' | 'lost';
  },
): Promise<{ id: string }> {
  return prisma.deal.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      pipelineId: args.pipelineId,
      currentStageId: args.stageId,
      value: args.value ?? 0,
      status: args.status ?? 'open',
    },
    select: { id: true },
  });
}

/**
 * KAN-1132 PR 2 — Order fixture builder. Minimal required fields:
 * tenantId + contactId (FK) + orderNumber (no default). Money columns
 * default to 0; tests that need specific Decimal values pass them in
 * via overrides.
 *
 * Naming: `createOrder` matches the existing `createX` convention in this
 * file (KAN-1124 cleanup will rename all → `buildX` in one pass; until
 * then, follow precedent within the file rather than introduce
 * mixed-naming locally).
 */
export async function createOrder(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    orderNumber?: string;
    totalAmount?: number | string;
    taxAmount?: number | string;
    discountAmount?: number | string;
    grandTotal?: number | string;
  },
): Promise<{ id: string }> {
  return prisma.order.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      orderNumber: args.orderNumber ?? `ORD-${uniqueSuffix()}`,
      ...(args.totalAmount !== undefined ? { totalAmount: args.totalAmount } : {}),
      ...(args.taxAmount !== undefined ? { taxAmount: args.taxAmount } : {}),
      ...(args.discountAmount !== undefined ? { discountAmount: args.discountAmount } : {}),
      ...(args.grandTotal !== undefined ? { grandTotal: args.grandTotal } : {}),
    },
    select: { id: true },
  });
}

export async function createDecision(
  prisma: PrismaClient,
  args: { tenantId: string; contactId: string; confidence: number; createdAt?: Date },
): Promise<{ id: string }> {
  return prisma.decision.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      strategySelected: 'integration-test-strategy',
      actionType: 'send_follow_up',
      confidence: args.confidence,
      reasoning: 'integration-test',
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    },
    select: { id: true },
  });
}

/**
 * KAN-1120 — Deterministic 1536-dim embedding fixture. The semantic values
 * are intentionally meaningless: KAN-1120's test scope is storage + retrieval
 * shape (pgvector ::vector(1536) cast round-trip), NOT semantic similarity.
 *
 * `Math.sin(i) / Math.sqrt(dims)` keeps |v| ≈ 1 without normalization
 * gymnastics. Deterministic across runs so test assertions stay stable.
 *
 * Pass `dims` other than 1536 to deliberately trigger pgvector's dimension
 * check (Test #2 in faq-entries-embed.test.ts uses 1535 to force a real
 * pgvector rejection — no throw-injection needed).
 */
export function buildFakeEmbedding(dims: number = 1536): number[] {
  return Array.from({ length: dims }, (_, i) => Math.sin(i) / Math.sqrt(dims));
}

/**
 * KAN-1120 — FaqEntry fixture builder. Returns a `'queued'`-status row by
 * default so callers can drive it through the full embed → chunk INSERT →
 * status='ready' transition via the production `createFaqEntry` /
 * `updateFaqEntry` paths.
 */
export async function buildFaqEntry(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    question?: string;
    answer?: string;
    status?: 'queued' | 'embedding' | 'ready' | 'error';
  },
): Promise<{ id: string }> {
  return prisma.faqEntry.create({
    data: {
      tenantId: args.tenantId,
      question: args.question ?? `Integration test Q ${uniqueSuffix()}`,
      answer: args.answer ?? `Integration test A ${uniqueSuffix()}`,
      status: args.status ?? 'queued',
    },
    select: { id: true },
  });
}

/**
 * KAN-1119 — DeferredSend fixture builder. Naming aligns with Phase 1
 * trace + 16th-memo-candidate convention (build* vs the create* used by
 * older KAN-1112 builders in this file; rename of legacy builders deferred
 * to a separate cleanup ticket to keep KAN-1119 scope tight).
 */
export async function buildDeferredSend(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    dealId?: string | null;
    status?: 'pending' | 'processing' | 'dispatched' | 'expired' | 'cancelled';
    deferUntil?: Date;
    deferReason?: string;
    attempts?: number;
    payload?: Record<string, unknown>;
    replayVia?: 'action_send' | 'action_decided';
  },
): Promise<{ id: string }> {
  return prisma.deferredSend.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      dealId: args.dealId ?? null,
      status: args.status ?? 'pending',
      // Default: past defer_until so the cron CTE picks it up immediately.
      deferUntil: args.deferUntil ?? new Date(Date.now() - 60_000),
      deferReason: args.deferReason ?? 'integration-test',
      attempts: args.attempts ?? 0,
      payload: (args.payload ?? {}) as Prisma.InputJsonValue,
      replayVia: args.replayVia ?? 'action_send',
    },
    select: { id: true },
  });
}
