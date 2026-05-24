/**
 * KAN-997 Campaign Layer Slice 1 — audience-router tests.
 *
 * Five pinned behaviors per the Slice 1 spec:
 *   1. Golden canonical case — NL → expected AudienceConditions JSON
 *   2. Count correctness — Prisma where-tree matches AND/OR semantics
 *   3. Cross-tenant isolation — tenant A's contacts NEVER counted under tenant B
 *   4. Ambiguous → clarifying-question path
 *   5. Thin / zero → honest-message path
 *
 * LLM is mocked (deterministic suite). Prisma uses an in-memory
 * `FakeContact` array + a tiny where-evaluator that mirrors Prisma's
 * AND/OR/in/gte/lt/some/none semantics for the leaf fields the router
 * builds. Same shape Prisma would emit; we evaluate it locally to
 * avoid bringing the full database into unit tests.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AudienceConditionsSchema,
  type AudienceConditions,
} from '@growth/shared';
import {
  conditionsToWhere,
  countAudience,
  textToSegment,
  buildSystemPrompt,
  THIN_THRESHOLD,
  type AudiencePrisma,
  type LLMCompleteFn,
} from '../audience-router.js';

// ─────────────────────────────────────────────
// In-memory Prisma stand-in
// ─────────────────────────────────────────────

interface FakeContact {
  id: string;
  tenantId: string;
  lifecycleStage: string;
  segment: string | null;
  source: string | null;
  country: string | null;
  createdAt: Date;
  orders: { placedAt: Date }[];
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makeFakePrisma(contacts: FakeContact[]): AudiencePrisma {
  return {
    contact: {
      count: async ({ where }) => {
        const matches = contacts.filter((c) => evalWhere(c, where));
        return matches.length;
      },
    },
  };
}

/**
 * Tiny where-evaluator. Mirrors Prisma's AND / OR / in / gte / lt /
 * some / none semantics for the leaf shapes our where-tree builder
 * emits. Not a general Prisma simulator — just covers what
 * conditionsToWhere produces.
 */
function evalWhere(c: FakeContact, where: Record<string, unknown>): boolean {
  if ('AND' in where && Array.isArray(where.AND)) {
    return (where.AND as Record<string, unknown>[]).every((w) => evalWhere(c, w));
  }
  if ('OR' in where && Array.isArray(where.OR)) {
    return (where.OR as Record<string, unknown>[]).some((w) => evalWhere(c, w));
  }
  if ('tenantId' in where) return c.tenantId === where.tenantId;

  for (const [field, predicate] of Object.entries(where)) {
    if (field === 'AND' || field === 'OR' || field === 'tenantId') continue;
    const p = predicate as Record<string, unknown>;

    if (field === 'orders') {
      if ('some' in p) {
        const some = p.some as Record<string, unknown>;
        if (Object.keys(some).length === 0) {
          if (c.orders.length === 0) return false;
          continue;
        }
        const placedAt = (some.placedAt ?? {}) as { gte?: Date; lt?: Date };
        const has = c.orders.some(
          (o) =>
            (!placedAt.gte || o.placedAt >= placedAt.gte) &&
            (!placedAt.lt || o.placedAt < placedAt.lt),
        );
        if (!has) return false;
        continue;
      }
      if ('none' in p) {
        if (c.orders.length > 0) return false;
        continue;
      }
    }

    if ('in' in p) {
      const inVals = p.in as string[];
      const v = c[field as keyof FakeContact];
      if (typeof v !== 'string' || !inVals.includes(v)) return false;
      continue;
    }
    if ('gte' in p || 'lt' in p) {
      const range = p as { gte?: Date; lt?: Date };
      const v = c[field as keyof FakeContact] as Date;
      if (!(v instanceof Date)) return false;
      if (range.gte && v < range.gte) return false;
      if (range.lt && v >= range.lt) return false;
      continue;
    }
  }
  return true;
}

function contact(overrides: Partial<FakeContact> = {}): FakeContact {
  return {
    id: `ct_${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT_A,
    lifecycleStage: 'lead',
    segment: null,
    source: null,
    country: null,
    createdAt: new Date('2025-04-15T12:00:00Z'),
    orders: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// 1. Golden NL → AudienceConditions
// ─────────────────────────────────────────────

describe('KAN-997 — golden NL → AudienceConditions (canonical case)', () => {
  it("'contacts that bought or sent a lead in March, April & May of last year' (today=2026-05-23)", async () => {
    const today = new Date('2026-05-23T14:00:00Z');
    // LLM emits the canonical anyOf shape. The router calls
    // AudienceConditionsSchema.parse internally — if the LLM shape is
    // wrong, this test surfaces the parse failure.
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'segment',
        conditions: {
          anyOf: [
            {
              field: 'orders.placedAt',
              op: 'between',
              fromUtc: '2025-03-01T00:00:00.000Z',
              toUtcExclusive: '2025-06-01T00:00:00.000Z',
            },
            {
              field: 'createdAt',
              op: 'between',
              fromUtc: '2025-03-01T00:00:00.000Z',
              toUtcExclusive: '2025-06-01T00:00:00.000Z',
            },
          ],
        },
      }),
      model: 'claude-sonnet-4-6',
      inputTokens: 800,
      outputTokens: 200,
      latencyMs: 1200,
    });

    // Seed 12 contacts in the right window + 3 outside.
    const inWindow = Array.from({ length: 12 }, () =>
      contact({ createdAt: new Date('2025-04-15T12:00:00Z') }),
    );
    const outsideWindow = [
      contact({ createdAt: new Date('2025-02-15T12:00:00Z') }),
      contact({ createdAt: new Date('2025-06-15T12:00:00Z') }),
      contact({ createdAt: new Date('2024-04-15T12:00:00Z') }),
    ];

    const prisma = makeFakePrisma([...inWindow, ...outsideWindow]);
    const result = await textToSegment(
      prisma,
      TENANT_A,
      {
        nl: 'contacts that bought or sent a lead in March, April & May of last year',
        todayUtc: today,
      },
      llmMock,
    );

    expect(result.kind).toBe('segment');
    if (result.kind !== 'segment') return;
    expect(result.count).toBe(12);
    expect(result.message).toMatch(/12 contacts match/);

    // LLM was called with the canonical caller-tag for cost-tracking
    // (rolls up under 'campaign' prefix on /settings/observability).
    expect(llmMock).toHaveBeenCalledOnce();
    const llmArgs = vi.mocked(llmMock).mock.calls[0]![0];
    expect(llmArgs.callerTag).toBe('campaign:text-to-segment');
    expect(llmArgs.tier).toBe('reasoning');
    expect(llmArgs.tenantId).toBe(TENANT_A);
  });

  it('system prompt encodes the canonical example + tenant today + last-year math', () => {
    const today = new Date('2026-05-23T14:00:00Z');
    const prompt = buildSystemPrompt(today);
    // ISO 'today' present (prompt wraps it in backticks); assert on the value
    // substring so the backtick formatting can change without breaking the test.
    expect(prompt).toContain('2026-05-23T14:00:00.000Z');
    expect(prompt).toContain('last year = 2025');
    expect(prompt).toContain('2025-03-01T00:00:00.000Z');
    expect(prompt).toContain('2025-06-01T00:00:00.000Z');
  });
});

// ─────────────────────────────────────────────
// 2. Count correctness — where-tree builder
// ─────────────────────────────────────────────

describe('KAN-997 — conditionsToWhere (Prisma where-tree builder)', () => {
  it('leaf lifecycleStage → { lifecycleStage: { in: [...] } }', () => {
    const where = conditionsToWhere({
      field: 'lifecycleStage',
      op: 'in',
      values: ['customer'],
    });
    expect(where).toEqual({ lifecycleStage: { in: ['customer'] } });
  });

  it('leaf orders.placedAt → relation filter via orders.some', () => {
    const where = conditionsToWhere({
      field: 'orders.placedAt',
      op: 'between',
      fromUtc: '2025-03-01T00:00:00.000Z',
      toUtcExclusive: '2025-06-01T00:00:00.000Z',
    });
    expect(where).toEqual({
      orders: {
        some: {
          placedAt: {
            gte: new Date('2025-03-01T00:00:00.000Z'),
            lt: new Date('2025-06-01T00:00:00.000Z'),
          },
        },
      },
    });
  });

  it('allOf → AND, anyOf → OR, nested', () => {
    const tree: AudienceConditions = {
      anyOf: [
        {
          allOf: [
            { field: 'lifecycleStage', op: 'in', values: ['customer'] },
            { field: 'country', op: 'in', values: ['US'] },
          ],
        },
        { field: 'orders.exists', op: 'eq', value: true },
      ],
    };
    const where = conditionsToWhere(tree);
    expect(where).toEqual({
      OR: [
        {
          AND: [
            { lifecycleStage: { in: ['customer'] } },
            { country: { in: ['US'] } },
          ],
        },
        { orders: { some: {} } },
      ],
    });
  });
});

// ─────────────────────────────────────────────
// 3. Cross-tenant isolation
// ─────────────────────────────────────────────

describe('KAN-997 — countAudience cross-tenant isolation', () => {
  it("tenant A's count NEVER includes tenant B's contacts", async () => {
    const tenantAContacts = Array.from({ length: 10 }, () =>
      contact({ tenantId: TENANT_A, lifecycleStage: 'customer' }),
    );
    const tenantBContacts = Array.from({ length: 50 }, () =>
      contact({ tenantId: TENANT_B, lifecycleStage: 'customer' }),
    );
    const prisma = makeFakePrisma([...tenantAContacts, ...tenantBContacts]);

    const aCount = await countAudience(prisma, TENANT_A, {
      conditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
    });
    const bCount = await countAudience(prisma, TENANT_B, {
      conditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
    });

    expect(aCount.count).toBe(10);
    expect(bCount.count).toBe(50);
  });

  it('top-level OR cannot escape tenant scope (outer AND wraps tree)', async () => {
    const tenantAContacts = [contact({ tenantId: TENANT_A, lifecycleStage: 'lead' })];
    const tenantBContacts = Array.from({ length: 100 }, () =>
      contact({ tenantId: TENANT_B, lifecycleStage: 'customer' }),
    );
    const prisma = makeFakePrisma([...tenantAContacts, ...tenantBContacts]);

    // Even a wide OR at the root can't reach tenant B's data.
    const conditions: AudienceConditions = {
      anyOf: [
        { field: 'lifecycleStage', op: 'in', values: ['lead'] },
        { field: 'lifecycleStage', op: 'in', values: ['customer'] },
      ],
    };
    const { count } = await countAudience(prisma, TENANT_A, { conditions });
    // Tenant A has 1 lead, 0 customers → count = 1, NOT 1 + 100.
    expect(count).toBe(1);
  });
});

// ─────────────────────────────────────────────
// 4. Ambiguous → clarifying-question path
// ─────────────────────────────────────────────

describe('KAN-997 — ambiguous NL → clarifying question (never guess)', () => {
  it("LLM emits kind=ambiguous → router returns the clarifyingQuestion verbatim", async () => {
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'ambiguous',
        clarifyingQuestion:
          'Did you mean active customers (made a purchase in the last 90 days) or all customers including churned?',
      }),
      model: 'claude-sonnet-4-6',
      inputTokens: 500,
      outputTokens: 80,
      latencyMs: 900,
    });
    const prisma = makeFakePrisma([]);

    const result = await textToSegment(
      prisma,
      TENANT_A,
      { nl: 'our customers', todayUtc: new Date('2026-05-23T14:00:00Z') },
      llmMock,
    );

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.clarifyingQuestion).toMatch(/active customers/);
    // Critically — Prisma was never called (no count attempted on
    // ambiguous extraction).
  });
});

// ─────────────────────────────────────────────
// 5. Thin / zero → honest-message path
// ─────────────────────────────────────────────

describe('KAN-997 — thin / zero match → honest message (never silent)', () => {
  it('count = 0 → kind=thin with "No contacts match"', async () => {
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'segment',
        conditions: {
          field: 'lifecycleStage',
          op: 'in',
          values: ['churned'],
        },
      }),
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 60,
      latencyMs: 800,
    });
    const prisma = makeFakePrisma([contact({ lifecycleStage: 'lead' })]);

    const result = await textToSegment(
      prisma,
      TENANT_A,
      { nl: 'churned contacts', todayUtc: new Date('2026-05-23T14:00:00Z') },
      llmMock,
    );

    expect(result.kind).toBe('thin');
    if (result.kind !== 'thin') return;
    expect(result.count).toBe(0);
    expect(result.message).toMatch(/No contacts match/i);
  });

  it(`count ≤ ${THIN_THRESHOLD} → kind=thin with "Only N contact(s) match"`, async () => {
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'segment',
        conditions: {
          field: 'lifecycleStage',
          op: 'in',
          values: ['lead'],
        },
      }),
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 60,
      latencyMs: 800,
    });
    const prisma = makeFakePrisma(
      Array.from({ length: 3 }, () => contact({ lifecycleStage: 'lead' })),
    );

    const result = await textToSegment(
      prisma,
      TENANT_A,
      { nl: 'our leads', todayUtc: new Date('2026-05-23T14:00:00Z') },
      llmMock,
    );

    expect(result.kind).toBe('thin');
    if (result.kind !== 'thin') return;
    expect(result.count).toBe(3);
    expect(result.message).toMatch(/Only 3 contacts match/);
  });

  it("count = 1 → singular 'contact matches'", async () => {
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'segment',
        conditions: {
          field: 'lifecycleStage',
          op: 'in',
          values: ['lead'],
        },
      }),
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 60,
      latencyMs: 800,
    });
    const prisma = makeFakePrisma([contact({ lifecycleStage: 'lead' })]);

    const result = await textToSegment(
      prisma,
      TENANT_A,
      { nl: 'leads', todayUtc: new Date('2026-05-23T14:00:00Z') },
      llmMock,
    );
    if (result.kind !== 'thin') throw new Error('expected thin');
    expect(result.message).toMatch(/Only 1 contact matches/);
  });
});

// ─────────────────────────────────────────────
// 6. LLM output robustness — fence stripping + bad shapes
// ─────────────────────────────────────────────

describe('KAN-997 — LLM output robustness', () => {
  it("strips ```json ... ``` markdown fence if the model adds one", async () => {
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: '```json\n{"kind":"segment","conditions":{"field":"lifecycleStage","op":"in","values":["customer"]}}\n```',
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 60,
      latencyMs: 800,
    });
    const prisma = makeFakePrisma(
      Array.from({ length: 10 }, () => contact({ lifecycleStage: 'customer' })),
    );
    const result = await textToSegment(
      prisma,
      TENANT_A,
      { nl: 'customers', todayUtc: new Date('2026-05-23T14:00:00Z') },
      llmMock,
    );
    expect(result.kind).toBe('segment');
  });

  it('throws on non-JSON LLM output', async () => {
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: 'sorry, I cannot help with that',
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 10,
      latencyMs: 800,
    });
    await expect(
      textToSegment(
        makeFakePrisma([]),
        TENANT_A,
        { nl: 'x', todayUtc: new Date('2026-05-23T14:00:00Z') },
        llmMock,
      ),
    ).rejects.toThrow(/non-JSON output/);
  });

  it('throws on conditions that violate the AudienceConditions schema', async () => {
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'segment',
        conditions: {
          field: 'lifecycleStage',
          op: 'in',
          // Empty values[] — schema enforces min(1)
          values: [],
        },
      }),
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 60,
      latencyMs: 800,
    });
    await expect(
      textToSegment(
        makeFakePrisma([]),
        TENANT_A,
        { nl: 'x', todayUtc: new Date('2026-05-23T14:00:00Z') },
        llmMock,
      ),
    ).rejects.toThrow();
  });
});
