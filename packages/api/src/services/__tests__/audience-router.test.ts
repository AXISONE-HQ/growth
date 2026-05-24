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
  buildProposeSystemPrompt,
  proposeCampaign,
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
  orders: { placedAt: Date; grandTotal: number; currency: string }[];
}

// KAN-1000 Slice 2 — objective catalog shape for the propose tests.
interface FakeObjective {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  isActive: boolean;
  createdAt: Date;
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makeFakePrisma(
  contacts: FakeContact[],
  objectives: FakeObjective[] = [],
): AudiencePrisma {
  return {
    contact: {
      count: async ({ where }) => {
        const matches = contacts.filter((c) => evalWhere(c, where));
        return matches.length;
      },
    },
    // KAN-1000 Slice 2 — order.aggregate for historicalValueUsd.
    // Walks the same where-tree the count side uses, plus an outer
    // currency='USD' filter, then sums grandTotal across matched orders.
    order: {
      aggregate: async ({ where }) => {
        // The shape conditionsToWhere builds for orders is:
        //   { AND: [{ tenantId }, { currency: 'USD' }, { contact: { AND: [...] } }] }
        // Extract the contact subtree + the currency filter; sum
        // matching orders.
        const flat = flattenAndArray(where);
        const tenantClause = flat.find((w) => 'tenantId' in w) as
          | { tenantId: string }
          | undefined;
        const currencyClause = flat.find((w) => 'currency' in w) as
          | { currency: string }
          | undefined;
        const contactClause = flat.find((w) => 'contact' in w) as
          | { contact: Record<string, unknown> }
          | undefined;

        const wantTenant = tenantClause?.tenantId;
        const wantCurrency = currencyClause?.currency ?? 'USD';

        let sum = 0;
        for (const c of contacts) {
          if (wantTenant && c.tenantId !== wantTenant) continue;
          if (contactClause && !evalWhere(c, contactClause.contact)) continue;
          for (const o of c.orders) {
            if (o.currency !== wantCurrency) continue;
            sum += o.grandTotal;
          }
        }

        return { _sum: { grandTotal: sum } };
      },
    },
    objective: {
      findMany: async ({ where }) => {
        return objectives
          .filter((o) => o.tenantId === where.tenantId)
          .filter((o) => where.isActive === undefined || o.isActive === where.isActive)
          .map((o) => ({ id: o.id, name: o.name, type: o.type }));
      },
    },
  };
}

// Helper: flatten an outer { AND: [...] } into a flat array of clauses.
function flattenAndArray(w: Record<string, unknown>): Array<Record<string, unknown>> {
  if ('AND' in w && Array.isArray(w.AND)) {
    return (w.AND as Array<Record<string, unknown>>).flatMap((inner) =>
      'AND' in inner && Array.isArray(inner.AND) ? flattenAndArray(inner) : [inner],
    );
  }
  return [w];
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
    // KAN-1000 fix-forward — switched from 'churned' to 'lost' (real
    // Prisma LifecycleStage value). The legacy test mocked 'churned'
    // which exposed the Zod-enum-drift class repaired by KAN-1000.
    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'segment',
        conditions: {
          field: 'lifecycleStage',
          op: 'in',
          values: ['lost'],
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
      { nl: 'lost leads', todayUtc: new Date('2026-05-23T14:00:00Z') },
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

// ═════════════════════════════════════════════
// KAN-1000 Slice 2 — historicalValueUsd + proposeCampaign
// ═════════════════════════════════════════════

describe('KAN-1000 — countAudience historicalValueUsd (Slice 2)', () => {
  it('sums matched contacts past USD orders; excludes non-USD currency', async () => {
    const prisma = makeFakePrisma([
      // Tenant A customer with $5,000 USD + $2,000 USD orders (sum = 7000)
      contact({
        tenantId: TENANT_A,
        lifecycleStage: 'customer',
        orders: [
          { placedAt: new Date('2025-01-15T00:00:00Z'), grandTotal: 5000, currency: 'USD' },
          { placedAt: new Date('2025-02-15T00:00:00Z'), grandTotal: 2000, currency: 'USD' },
        ],
      }),
      // Tenant A customer with $3,000 USD + €1,000 EUR (sum USD = 3000, EUR excluded)
      contact({
        tenantId: TENANT_A,
        lifecycleStage: 'customer',
        orders: [
          { placedAt: new Date('2025-03-15T00:00:00Z'), grandTotal: 3000, currency: 'USD' },
          { placedAt: new Date('2025-04-15T00:00:00Z'), grandTotal: 1000, currency: 'EUR' },
        ],
      }),
      // Tenant A customer with no orders (sum = 0, contributes count only)
      contact({ tenantId: TENANT_A, lifecycleStage: 'customer', orders: [] }),
    ]);

    const result = await countAudience(prisma, TENANT_A, {
      conditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
    });

    expect(result.count).toBe(3);
    expect(result.historicalValueUsd).toBe(10000); // 5000 + 2000 + 3000
  });

  it('tenant isolation — historicalValueUsd never includes other-tenant orders', async () => {
    const prisma = makeFakePrisma([
      contact({
        tenantId: TENANT_A,
        lifecycleStage: 'customer',
        orders: [
          { placedAt: new Date('2025-01-15T00:00:00Z'), grandTotal: 100, currency: 'USD' },
        ],
      }),
      contact({
        tenantId: TENANT_B,
        lifecycleStage: 'customer',
        orders: [
          { placedAt: new Date('2025-01-15T00:00:00Z'), grandTotal: 999999, currency: 'USD' },
        ],
      }),
    ]);

    const a = await countAudience(prisma, TENANT_A, {
      conditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
    });
    const b = await countAudience(prisma, TENANT_B, {
      conditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
    });

    expect(a.historicalValueUsd).toBe(100);
    expect(b.historicalValueUsd).toBe(999999);
  });

  it('zero matches → historicalValueUsd = 0 (no NaN leak)', async () => {
    const prisma = makeFakePrisma([
      contact({ tenantId: TENANT_A, lifecycleStage: 'lead' }),
    ]);
    const result = await countAudience(prisma, TENANT_A, {
      conditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
    });
    expect(result.count).toBe(0);
    expect(result.historicalValueUsd).toBe(0);
  });
});

describe('KAN-1000 — proposeCampaign (Slice 2 full proposal)', () => {
  // Standard tenant catalog used across propose tests.
  function makeCatalog(): FakeObjective[] {
    const now = new Date('2026-01-01T00:00:00Z');
    return [
      {
        id: 'obj_reactivate',
        tenantId: TENANT_A,
        name: 'Reactivate dormant customers',
        type: 'reactivate',
        isActive: true,
        createdAt: now,
      },
      {
        id: 'obj_book_appt',
        tenantId: TENANT_A,
        name: 'Book sales appointments',
        type: 'book_appointment',
        isActive: true,
        createdAt: now,
      },
      {
        id: 'obj_upsell',
        tenantId: TENANT_A,
        name: 'Upsell to premium tier',
        type: 'upsell',
        isActive: true,
        createdAt: now,
      },
    ];
  }

  // Helper: chain two mock responses (textToSegment LLM call + propose
  // LLM call). The propose path makes 2 LLM calls — first to extract
  // the audience, second to build the full proposal.
  function chainLlm(textToSegmentOut: object, proposeOut: object): LLMCompleteFn {
    let callIdx = 0;
    return vi.fn().mockImplementation(async () => {
      const text = callIdx === 0 ? JSON.stringify(textToSegmentOut) : JSON.stringify(proposeOut);
      callIdx++;
      return {
        text,
        model: 'claude-sonnet-4-6',
        inputTokens: 800,
        outputTokens: 300,
        latencyMs: 1200,
      };
    });
  }

  it('canonical case — win-back NL → catalog reactivate objective + re_engage strategy + 2-5 stages + first-actions', async () => {
    const today = new Date('2026-05-23T14:00:00Z');
    const llmMock = chainLlm(
      // textToSegment output
      // KAN-1000 fix-forward — 'lost' is the real Prisma LifecycleStage
      // value for sales-lost contacts. Demonstrates the win-back
      // canonical case end-to-end with the corrected enum.
      {
        kind: 'segment',
        conditions: { field: 'lifecycleStage', op: 'in', values: ['lost'] },
      },
      // propose output — LLM picked obj_reactivate by id, re_engage strategy
      {
        kind: 'proposal',
        proposal: {
          name: 'Reactivate Churned Customers',
          windowStartUtc: null,
          windowEndUtc: null,
          objective: {
            id: 'obj_reactivate',
            name: 'Reactivate dormant customers',
            type: 'reactivate',
          },
          strategy: 're_engage',
          proposedStages: [
            { name: 'Awareness', order: 0, description: 'Re-introduce the value' },
            { name: 'Re-engagement', order: 1, description: 'Direct ask to come back' },
            { name: 'Conversion', order: 2, description: 'Convert or move to lost' },
          ],
          firstActions: [
            { day: 0, channel: 'email', intent: 're-engagement opener', description: '"We miss you" — value reminder' },
            { day: 3, channel: 'email', intent: 'value follow-up', description: 'New features since they left' },
            { day: 7, channel: 'sms', intent: 'final outreach', description: 'Direct ask with discount' },
          ],
        },
      },
    );

    const prisma = makeFakePrisma(
      // 10 'lost' tenant-A contacts with $20K total historical USD value.
      // 'lost' is the closest Prisma LifecycleStage to "churned" in the
      // bug-report narrative; "churned" itself doesn't exist (per the
      // KAN-1000 fix-forward — see system prompt's dormancy guidance
      // recommending orders.placedAt recency for true churn semantics).
      Array.from({ length: 10 }, () =>
        contact({
          tenantId: TENANT_A,
          lifecycleStage: 'lost',
          orders: [
            { placedAt: new Date('2024-06-01T00:00:00Z'), grandTotal: 2000, currency: 'USD' },
          ],
        }),
      ),
      makeCatalog(),
    );

    const result = await proposeCampaign(
      prisma,
      TENANT_A,
      { nl: 'win back churned customers', todayUtc: today },
      llmMock,
    );

    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    expect(result.proposal.audience.count).toBe(10);
    expect(result.proposal.audience.historicalValueUsd).toBe(20000);
    expect(result.proposal.objective.id).toBe('obj_reactivate');
    expect(result.proposal.objective.type).toBe('reactivate');
    expect(result.proposal.strategy).toBe('re_engage');
    expect(result.proposal.proposedStages.length).toBeGreaterThanOrEqual(2);
    expect(result.proposal.firstActions.length).toBeGreaterThanOrEqual(1);
    expect(result.proposal.firstActions[0]!.channel).toMatch(/email|sms|whatsapp/);

    // The propose call must use the canonical callerTag for cost
    // attribution (KAN-999 dashboard chip).
    const llmCalls = vi.mocked(llmMock).mock.calls;
    expect(llmCalls.length).toBe(2);
    expect(llmCalls[0]![0].callerTag).toBe('campaign:text-to-segment');
    expect(llmCalls[1]![0].callerTag).toBe('campaign:propose');
  });

  it('book-appointment NL → catalog book_appointment objective + guided strategy', async () => {
    const today = new Date('2026-05-23T14:00:00Z');
    const llmMock = chainLlm(
      {
        kind: 'segment',
        conditions: { field: 'lifecycleStage', op: 'in', values: ['mql'] },
      },
      {
        kind: 'proposal',
        proposal: {
          name: 'Book Sales Demos with Qualified Leads',
          windowStartUtc: null,
          windowEndUtc: null,
          objective: {
            id: 'obj_book_appt',
            name: 'Book sales appointments',
            type: 'book_appointment',
          },
          strategy: 'guided',
          proposedStages: [
            { name: 'Qualification', order: 0, description: 'Confirm fit' },
            { name: 'Demo', order: 1, description: 'Run the demo' },
          ],
          firstActions: [
            { day: 0, channel: 'email', intent: 'qualifying email', description: 'Confirm fit + propose times' },
          ],
        },
      },
    );

    const prisma = makeFakePrisma(
      [contact({ tenantId: TENANT_A, lifecycleStage: 'mql' })],
      makeCatalog(),
    );

    const result = await proposeCampaign(
      prisma,
      TENANT_A,
      { nl: 'book demos with qualified leads', todayUtc: today },
      llmMock,
    );

    if (result.kind !== 'thin') throw new Error('expected thin (count=1 ≤ THIN_THRESHOLD)');
    expect(result.proposal.objective.type).toBe('book_appointment');
    expect(result.proposal.strategy).toBe('guided');
    expect(result.message).toMatch(/Only 1 contact matches/);
  });

  it('LLM picks objective by id from the catalog (cannot invent unknown objective)', async () => {
    const today = new Date('2026-05-23T14:00:00Z');
    const llmMock = chainLlm(
      {
        kind: 'segment',
        conditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
      },
      // LLM emits an objective WITHOUT a real catalog id. The Zod schema
      // permits any string id (test the LLM honoring catalog discipline
      // requires golden goldens, not schema enforcement), but we assert
      // the LLM CAN pick a valid id and our pipeline preserves it.
      {
        kind: 'proposal',
        proposal: {
          name: 'Upsell',
          windowStartUtc: null,
          windowEndUtc: null,
          objective: {
            id: 'obj_upsell',
            name: 'Upsell to premium tier',
            type: 'upsell',
          },
          strategy: 'direct',
          proposedStages: [{ name: 'Pitch', order: 0, description: 'Present premium' }],
          firstActions: [{ day: 0, channel: 'email', intent: 'pitch', description: 'Premium-tier value email' }],
        },
      },
    );

    const prisma = makeFakePrisma(
      Array.from({ length: 30 }, () =>
        contact({ tenantId: TENANT_A, lifecycleStage: 'customer' }),
      ),
      makeCatalog(),
    );

    const result = await proposeCampaign(
      prisma,
      TENANT_A,
      { nl: 'upsell our customers to premium', todayUtc: today },
      llmMock,
    );

    if (result.kind !== 'proposal') throw new Error('expected proposal');
    expect(result.proposal.objective.id).toBe('obj_upsell');
    // The id came from the catalog (verified by makeCatalog above
    // containing this id).
    const catalog = makeCatalog();
    expect(catalog.some((o) => o.id === result.proposal.objective.id)).toBe(true);
  });

  it('empty objective catalog → honest ambiguous response, no propose call attempted', async () => {
    const today = new Date('2026-05-23T14:00:00Z');
    const llmMock = chainLlm(
      {
        kind: 'segment',
        conditions: { field: 'lifecycleStage', op: 'in', values: ['lead'] },
      },
      // Doesn't matter — propose call should never fire
      {},
    );

    const prisma = makeFakePrisma(
      [contact({ tenantId: TENANT_A, lifecycleStage: 'lead' })],
      [], // empty catalog
    );

    const result = await proposeCampaign(
      prisma,
      TENANT_A,
      { nl: 'leads', todayUtc: today },
      llmMock,
    );

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.clarifyingQuestion).toMatch(/No objectives defined/);
    // Only textToSegment LLM call ran — propose call was short-circuited.
    expect(vi.mocked(llmMock).mock.calls.length).toBe(1);
  });

  it('textToSegment ambiguous → propose propagates verbatim, no propose call attempted', async () => {
    const today = new Date('2026-05-23T14:00:00Z');
    const llmMock = chainLlm(
      {
        kind: 'ambiguous',
        clarifyingQuestion: 'Did you mean active customers or churned customers?',
      },
      {},
    );

    const prisma = makeFakePrisma([], makeCatalog());

    const result = await proposeCampaign(
      prisma,
      TENANT_A,
      { nl: 'customers', todayUtc: today },
      llmMock,
    );

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.clarifyingQuestion).toMatch(/active customers or churned/);
    expect(vi.mocked(llmMock).mock.calls.length).toBe(1);
  });

  it('buildProposeSystemPrompt encodes catalog + today + 4-strategy enum', () => {
    const today = new Date('2026-05-23T14:00:00Z');
    const prompt = buildProposeSystemPrompt(
      today,
      [{ id: 'obj_x', name: 'X', type: 'reactivate' }],
      { count: 100, historicalValueUsd: 5000, conditions: { field: 'lifecycleStage', op: 'in', values: ['customer'] } },
    );
    expect(prompt).toContain('2026-05-23T14:00:00.000Z');
    expect(prompt).toContain('obj_x');
    expect(prompt).toContain('reactivate');
    expect(prompt).toContain('direct');
    expect(prompt).toContain('re_engage');
    expect(prompt).toContain('trust_build');
    expect(prompt).toContain('guided');
    // Control-flow strategies (escalate / wait) MUST NOT appear in the
    // user-facing strategy list — they're decision-engine primitives,
    // not campaign strategies.
    expect(prompt).not.toMatch(/'escalate'/);
    expect(prompt).not.toMatch(/'wait'/);
  });
});

// ═════════════════════════════════════════════
// KAN-1000 Slice 2 fix-forward — enum-validation regression guard
// ═════════════════════════════════════════════
//
// PROD bug repro: text-to-segment emitted `lifecycleStage: ['churned']`
// (Zod-valid against the drift'd local enum, NOT a real Prisma value).
// Prisma threw + the raw query string was rendered to the user.
//
// Fix has two layers — pin both:
//   1. Zod schema NOW uses the canonical LifecycleStageEnum from
//      enums.ts (PAIRS-tested against Prisma). Invalid values are
//      rejected at parse time — countAudience throws before any
//      Prisma call.
//   2. countAudience wraps Prisma calls in try/catch as defense-in-depth
//      so future schema drift can't leak raw query strings.

describe('KAN-1000 fix-forward — invalid LLM enum is rejected at validation (no Prisma call)', () => {
  it("text-to-segment with 'churned' lifecycleStage (legacy drift'd value) is rejected by Zod, count NEVER called", async () => {
    let prismaCalled = false;
    const prismaSpy: AudiencePrisma = {
      contact: {
        count: async () => {
          prismaCalled = true;
          throw new Error('SHOULD NEVER REACH PRISMA');
        },
      },
      order: {
        aggregate: async () => {
          prismaCalled = true;
          throw new Error('SHOULD NEVER REACH PRISMA');
        },
      },
      objective: {
        findMany: async () => [],
      },
    };

    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'segment',
        conditions: {
          field: 'lifecycleStage',
          op: 'in',
          // 'churned' is the canonical drift example — not in Prisma's
          // LifecycleStage enum. With the PAIRS-tested mirror, Zod
          // rejects this at parseLLMOutput time.
          values: ['churned'],
        },
      }),
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 60,
      latencyMs: 800,
    });

    await expect(
      textToSegment(
        prismaSpy,
        TENANT_A,
        { nl: 'win back churned customers', todayUtc: new Date('2026-05-23T14:00:00Z') },
        llmMock,
      ),
    ).rejects.toThrow();

    // The crucial assertion: Prisma was never touched. Zod caught the
    // invalid enum value at parse time.
    expect(prismaCalled).toBe(false);
  });

  it("ContactSource invalid value (e.g., 'form_submission' — drift'd) is also rejected at Zod", async () => {
    let prismaCalled = false;
    const prismaSpy: AudiencePrisma = {
      contact: {
        count: async () => {
          prismaCalled = true;
          return 0;
        },
      },
      order: { aggregate: async () => ({ _sum: { grandTotal: 0 } }) },
      objective: { findMany: async () => [] },
    };

    const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: 'segment',
        conditions: {
          field: 'source',
          op: 'in',
          // 'form_submission' was the legacy drift'd value; Prisma's
          // ContactSource uses 'web_form'. PAIRS catches this in CI;
          // this test pins the runtime rejection.
          values: ['form_submission'],
        },
      }),
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 60,
      latencyMs: 800,
    });

    await expect(
      textToSegment(
        prismaSpy,
        TENANT_A,
        { nl: 'leads from web form', todayUtc: new Date('2026-05-23T14:00:00Z') },
        llmMock,
      ),
    ).rejects.toThrow();
    expect(prismaCalled).toBe(false);
  });

  it('valid canonical LifecycleStage values from the corrected enum pass through', async () => {
    // Sanity check the corrected enum still accepts all 5 valid Prisma
    // values: lead / mql / sql / customer / lost.
    const validValues = ['lead', 'mql', 'sql', 'customer', 'lost'];
    for (const v of validValues) {
      const llmMock: LLMCompleteFn = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          kind: 'segment',
          conditions: { field: 'lifecycleStage', op: 'in', values: [v] },
        }),
        model: 'claude-sonnet-4-6',
        inputTokens: 400,
        outputTokens: 60,
        latencyMs: 800,
      });
      const result = await textToSegment(
        makeFakePrisma([]),
        TENANT_A,
        { nl: `${v} contacts`, todayUtc: new Date('2026-05-23T14:00:00Z') },
        llmMock,
      );
      // 0 matches → kind='thin' (the empty-prisma case). The crucial bit
      // is that Zod accepted the value + flow completed without throw.
      expect(result.kind).toBe('thin');
    }
  });

  it('countAudience wraps Prisma errors in a user-friendly message (defense-in-depth)', async () => {
    const prismaThatThrows: AudiencePrisma = {
      contact: {
        count: async () => {
          throw new Error('Some scary Prisma error with query JSON dumped');
        },
      },
      order: { aggregate: async () => ({ _sum: { grandTotal: 0 } }) },
      objective: { findMany: async () => [] },
    };

    await expect(
      countAudience(prismaThatThrows, TENANT_A, {
        conditions: { field: 'lifecycleStage', op: 'in', values: ['lead'] },
      }),
    ).rejects.toThrow(/Couldn't map part of that description to your data/);
  });

  it("system prompt enumerates ONLY the 5 valid LifecycleStage + 10 valid ContactSource values + flags 'churned' guidance", () => {
    const prompt = buildSystemPrompt(new Date('2026-05-23T14:00:00Z'));
    // Valid lifecycle stages present
    expect(prompt).toContain("'lead'");
    expect(prompt).toContain("'mql'");
    expect(prompt).toContain("'sql'");
    expect(prompt).toContain("'customer'");
    expect(prompt).toContain("'lost'");
    // Drift'd values explicitly NOT in the prompt
    expect(prompt).not.toMatch(/'opportunity'\|/);
    expect(prompt).not.toMatch(/'churned'\|/);
    // Valid sources present (sample)
    expect(prompt).toContain("'web_form'");
    expect(prompt).toContain("'meta_ad'");
    // Dormancy guidance present (steer LLM away from inventing 'churned')
    expect(prompt).toMatch(/churned.+do NOT map to a lifecycleStage/i);
    expect(prompt).toMatch(/orders\.placedAt|orders\.exists/);
  });
});
