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
import { PrismaClient } from '@prisma/client';

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
