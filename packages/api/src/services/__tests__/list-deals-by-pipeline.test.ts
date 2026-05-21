/**
 * KAN-967 — deals.listDealsByPipeline service tests.
 *
 * The endpoint is the Pipelines kanban board's grouped read. It mixes Prisma
 * client queries (pipeline lookup + contact/company hydration) with TWO raw
 * SQL queries ($queryRaw): the per-stage capped deals fetch + the latest-
 * decision DISTINCT-ON join. Tests pin:
 *
 *   1. Grouped shape — stages array carries deals + truncatedCount per stage
 *   2. latestDecision join correctness — most-recent Decision per deal
 *   3. Cross-tenant isolation — load-bearing for raw-SQL (tenant_id is the
 *      ONLY safety check, not Prisma middleware). Pin that the tenantId
 *      argument flows into BOTH raw queries verbatim.
 *   4. Soft-delete contract — verified via the raw query's `deleted_at IS NULL`
 *      filter, which the test mock checks for in the SQL string
 *   5. 50-cap + truncatedCount — stage with >50 deals returns 50 + the overflow
 *      count
 *   6. Empty pipeline — returns one StageGroup per Stage in pipeline.stage
 *      order, all with empty deals + truncatedCount=0
 *   7. NOT_FOUND when pipeline ∉ tenant (no existence leak)
 *
 * Mock strategy: Prisma client is a stub. `$queryRaw` is invoked as a tagged-
 * template literal; we intercept it and route to a configurable canned
 * response keyed by which query is firing (deals vs decisions, detected by
 * SQL substring). Contact + company `.findMany` return fixture rows.
 */
import { describe, it, expect, vi } from "vitest";
import {
  listDealsByPipeline,
  LIST_BY_PIPELINE_PER_STAGE_CAP,
} from "../deals-router.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PIPELINE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STAGE_NEW = "stg_new";
const STAGE_REACHED = "stg_reached";
const STAGE_DEMO_SET = "stg_demo_set";

interface DealRowFixture {
  id: string;
  name: string;
  value: number;
  currency: string;
  current_stage_id: string;
  entered_stage_at: Date;
  contact_id: string;
  company_id: string | null;
  status: string;
  probability: number | null;
  stage_total: bigint;
}

interface DecisionRowFixture {
  deal_id: string;
  action_type: string;
  confidence: number;
}

// Captures every $queryRaw invocation so tests can assert which queries fired,
// in what order, and with what bound parameters. The mock returns the
// configured canned response based on a substring match in the SQL text.
interface QueryRawInvocation {
  sql: string;
  params: unknown[];
}

function makePrisma(opts: {
  pipeline: { id: string; stages: Array<{ id: string }> } | null;
  dealRows: DealRowFixture[];
  decisionRows: DecisionRowFixture[];
  contacts: Array<{ id: string; firstName: string | null; lastName: string | null }>;
  companies: Array<{ id: string; name: string }>;
}) {
  const queryRawCalls: QueryRawInvocation[] = [];

  const pipelineFindFirst = vi.fn(async () => opts.pipeline);
  const contactFindMany = vi.fn(async () => opts.contacts);
  const companyFindMany = vi.fn(async () => opts.companies);

  // $queryRaw is invoked as a tagged template literal:
  //   prisma.$queryRaw`SELECT ... WHERE x = ${val}`
  // → arguments: (strings: TemplateStringsArray, ...values: unknown[])
  // We reconstruct the SQL with $1, $2, ... placeholders so tests can match on
  // it cleanly, and we store both the SQL + the bound values.
  const queryRaw = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      let sql = "";
      for (let i = 0; i < strings.length; i++) {
        sql += strings[i];
        if (i < values.length) sql += `$${i + 1}`;
      }
      queryRawCalls.push({ sql, params: values });
      if (sql.includes("FROM deals")) {
        return opts.dealRows as unknown;
      }
      // KAN-970 — decisions query now reads directly FROM decisions (not
      // joined via deal_stage_history), so the mock router-key changes.
      if (sql.includes("FROM decisions")) {
        return opts.decisionRows as unknown;
      }
      throw new Error(`Unexpected $queryRaw SQL: ${sql.slice(0, 80)}…`);
    },
  );

  return {
    prisma: {
      pipeline: { findFirst: pipelineFindFirst },
      contact: { findMany: contactFindMany },
      company: { findMany: companyFindMany },
      $queryRaw: queryRaw,
    } as unknown as Parameters<typeof listDealsByPipeline>[0],
    mocks: {
      pipelineFindFirst,
      contactFindMany,
      companyFindMany,
      queryRaw,
      queryRawCalls,
    },
  };
}

describe("KAN-967 — listDealsByPipeline grouped shape + correctness", () => {
  it("returns one StageGroup per pipeline stage in stage-order, deals nested per currentStageId", async () => {
    const { prisma } = makePrisma({
      pipeline: {
        id: PIPELINE_A,
        stages: [{ id: STAGE_NEW }, { id: STAGE_REACHED }, { id: STAGE_DEMO_SET }],
      },
      dealRows: [
        {
          id: "deal_a",
          name: "Acme deal",
          value: 1000,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date("2026-05-21T10:00:00Z"),
          contact_id: "ct_a",
          company_id: "co_a",
          status: "open",
          probability: 50,
          stage_total: 1n,
        },
        {
          id: "deal_b",
          name: "Beta deal",
          value: 500,
          currency: "USD",
          current_stage_id: STAGE_REACHED,
          entered_stage_at: new Date("2026-05-20T10:00:00Z"),
          contact_id: "ct_b",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 1n,
        },
      ],
      decisionRows: [
        { deal_id: "deal_a", action_type: "send_follow_up", confidence: 0.82 },
      ],
      contacts: [
        { id: "ct_a", firstName: "Alice", lastName: "Anderson" },
        { id: "ct_b", firstName: "Bob", lastName: null },
      ],
      companies: [{ id: "co_a", name: "Acme Inc" }],
    });

    const result = await listDealsByPipeline(prisma, TENANT_A, {
      pipelineId: PIPELINE_A,
    });

    expect(result.stages).toHaveLength(3);
    expect(result.stages.map((s) => s.stageId)).toEqual([
      STAGE_NEW,
      STAGE_REACHED,
      STAGE_DEMO_SET,
    ]);
    // Stage NEW has 1 deal with full decision + company
    expect(result.stages[0]!.deals).toHaveLength(1);
    expect(result.stages[0]!.deals[0]).toMatchObject({
      id: "deal_a",
      name: "Acme deal",
      currentStageId: STAGE_NEW,
      contact: { firstName: "Alice", lastName: "Anderson" },
      company: { name: "Acme Inc" },
      latestDecision: { actionType: "send_follow_up", confidence: 0.82 },
    });
    expect(result.stages[0]!.truncatedCount).toBe(0);
    // Stage REACHED has 1 deal with no company + no decision (omit, not fabricate)
    expect(result.stages[1]!.deals[0]).toMatchObject({
      id: "deal_b",
      contact: { firstName: "Bob", lastName: null },
      company: null,
      latestDecision: null,
    });
    // Stage DEMO_SET has no deals — empty column rendered
    expect(result.stages[2]!.deals).toEqual([]);
    expect(result.stages[2]!.truncatedCount).toBe(0);
  });

  it("Decimal value coerces to string (matches listDeals contract)", async () => {
    // Prisma Decimal is shaped { toString(): string } at runtime; the service
    // calls .toString() — pin that the result is a string, not a number.
    class FakeDecimal {
      constructor(private v: string) {}
      toString() {
        return this.v;
      }
    }
    const { prisma } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [
        {
          id: "deal_a",
          name: "Acme",
          value: new FakeDecimal("1234.56") as unknown as number,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date(),
          contact_id: "ct_a",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 1n,
        },
      ],
      decisionRows: [],
      contacts: [{ id: "ct_a", firstName: "A", lastName: "A" }],
      companies: [],
    });
    const result = await listDealsByPipeline(prisma, TENANT_A, {
      pipelineId: PIPELINE_A,
    });
    expect(result.stages[0]!.deals[0]!.value).toBe("1234.56");
    expect(typeof result.stages[0]!.deals[0]!.value).toBe("string");
  });
});

describe("KAN-967 — cross-tenant isolation (load-bearing for raw SQL)", () => {
  it("tenantId argument flows into BOTH raw queries verbatim (deals + decisions)", async () => {
    // This is the critical invariant: raw SQL skips Prisma's tenant middleware.
    // If a future refactor accidentally drops the tenant_id predicate from
    // either WHERE clause, this test catches it.
    const { prisma, mocks } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [
        {
          id: "deal_a",
          name: "x",
          value: 0,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date(),
          contact_id: "ct_a",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 1n,
        },
      ],
      decisionRows: [],
      contacts: [{ id: "ct_a", firstName: "A", lastName: "A" }],
      companies: [],
    });

    await listDealsByPipeline(prisma, TENANT_A, { pipelineId: PIPELINE_A });

    expect(mocks.queryRawCalls).toHaveLength(2);

    // Deals query — tenant_id is the FIRST bound param, pipeline_id is the
    // SECOND, and the SQL text contains `d.tenant_id = $1` (or the equivalent
    // placeholder shape from the tagged template).
    const dealsCall = mocks.queryRawCalls[0]!;
    expect(dealsCall.sql).toContain("FROM deals");
    expect(dealsCall.sql).toContain("d.tenant_id =");
    expect(dealsCall.sql).toContain("d.pipeline_id =");
    expect(dealsCall.sql).toContain("d.deleted_at IS NULL");
    expect(dealsCall.params[0]).toBe(TENANT_A); // tenantId binding
    expect(dealsCall.params[1]).toBe(PIPELINE_A); // pipelineId binding

    // Decisions query — KAN-970 sources directly from `decisions` (not the
    // deal_stage_history join, which only surfaced transition-causing
    // decisions). Tenant filter stays load-bearing; dealIds match the
    // metadata->>'dealId' JSONB extractor.
    const decisionsCall = mocks.queryRawCalls[1]!;
    expect(decisionsCall.sql).toContain("FROM decisions");
    expect(decisionsCall.sql).toContain("dec.tenant_id =");
    expect(decisionsCall.sql).toContain("dec.metadata->>'dealId'");
    expect(decisionsCall.params[0]).toBe(TENANT_A);
  });

  it("pipeline lookup is tenant-scoped — wrong tenant gets NOT_FOUND, no leak", async () => {
    // Pipeline.findFirst returns null when (pipelineId, tenantId) doesn't
    // match. Service must throw NOT_FOUND (not return an empty board, which
    // could be misread as "the pipeline exists but has no deals").
    const { prisma } = makePrisma({
      pipeline: null,
      dealRows: [],
      decisionRows: [],
      contacts: [],
      companies: [],
    });
    await expect(
      listDealsByPipeline(prisma, TENANT_B, { pipelineId: PIPELINE_A }),
    ).rejects.toThrow(/not found in tenant catalog/i);
  });

  it("a deal in another tenant's pipeline NEVER returns (the raw query's tenant_id is the gate)", async () => {
    // Simulate the scenario: Tenant A queries; a deal belonging to Tenant B
    // happens to share Tenant A's pipelineId structure. The raw query MUST
    // exclude it because tenant_id = ${TENANT_A} is in the WHERE clause.
    // Here we model the contract by asserting the captured SQL contains the
    // predicate AND the tenantId param matches the caller.
    const { prisma, mocks } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      // The mock returns ONLY rows that the raw query would have filtered to.
      // If the WHERE clause is correct, Tenant B's rows are never in dealRows.
      // Empty dealRows here represent "Tenant B has deals, but our query
      // tenant-scoped to A returns 0 — which is the correct behavior".
      dealRows: [],
      decisionRows: [],
      contacts: [],
      companies: [],
    });
    const result = await listDealsByPipeline(prisma, TENANT_A, {
      pipelineId: PIPELINE_A,
    });
    expect(result.stages[0]!.deals).toEqual([]);
    // The raw query was issued with TENANT_A — that's the load-bearing gate
    // against cross-tenant leak.
    expect(mocks.queryRawCalls[0]!.params[0]).toBe(TENANT_A);
  });
});

describe("KAN-967 — 50-cap + truncatedCount", () => {
  it("stage with >50 deals returns 50 cards + truncatedCount = total - 50", async () => {
    // Build 50 capped rows with stage_total=75 (simulating what the SQL
    // window-function output would emit for an oversized stage).
    const capped: DealRowFixture[] = Array.from({ length: 50 }, (_, i) => ({
      id: `deal_${i}`,
      name: `Deal ${i}`,
      value: 0,
      currency: "USD",
      current_stage_id: STAGE_NEW,
      entered_stage_at: new Date(),
      contact_id: `ct_${i}`,
      company_id: null,
      status: "open",
      probability: null,
      stage_total: 75n, // window function emits same total on every row of the stage
    }));
    const { prisma } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: capped,
      decisionRows: [],
      contacts: capped.map((c) => ({
        id: c.contact_id,
        firstName: "x",
        lastName: "x",
      })),
      companies: [],
    });

    const result = await listDealsByPipeline(prisma, TENANT_A, {
      pipelineId: PIPELINE_A,
    });

    expect(result.stages[0]!.deals).toHaveLength(50);
    expect(result.stages[0]!.truncatedCount).toBe(25); // 75 - 50
  });

  it("truncatedCount clamps to 0 when stage_total equals returned-card count", async () => {
    const { prisma } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [
        {
          id: "deal_a",
          name: "x",
          value: 0,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date(),
          contact_id: "ct_a",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 1n,
        },
      ],
      decisionRows: [],
      contacts: [{ id: "ct_a", firstName: "A", lastName: "A" }],
      companies: [],
    });
    const result = await listDealsByPipeline(prisma, TENANT_A, {
      pipelineId: PIPELINE_A,
    });
    expect(result.stages[0]!.deals).toHaveLength(1);
    expect(result.stages[0]!.truncatedCount).toBe(0);
  });

  it("LIST_BY_PIPELINE_PER_STAGE_CAP exported constant is 50 (drift pin — UI's '+N more' contract depends on it)", () => {
    expect(LIST_BY_PIPELINE_PER_STAGE_CAP).toBe(50);
  });
});

describe("KAN-967 — soft-delete + decision-join semantics", () => {
  it("raw query includes deleted_at IS NULL — tombstones excluded by contract", async () => {
    // We can't run real SQL here; pin the SQL TEXT contains the filter so
    // refactors don't silently drop it.
    const { prisma, mocks } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [],
      decisionRows: [],
      contacts: [],
      companies: [],
    });
    await listDealsByPipeline(prisma, TENANT_A, { pipelineId: PIPELINE_A });
    expect(mocks.queryRawCalls[0]!.sql).toContain("d.deleted_at IS NULL");
  });

  it("decision query uses DISTINCT ON metadata->>'dealId' + ORDER BY created_at DESC (KAN-970 most-recent-per-deal semantics)", async () => {
    // KAN-970 — query reads from `decisions` directly (not the
    // deal_stage_history join) so it surfaces non-transition decisions
    // like send_follow_up / wait_for_response / no_action.
    const { prisma, mocks } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [
        {
          id: "deal_a",
          name: "x",
          value: 0,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date(),
          contact_id: "ct_a",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 1n,
        },
      ],
      decisionRows: [],
      contacts: [{ id: "ct_a", firstName: "A", lastName: "A" }],
      companies: [],
    });
    await listDealsByPipeline(prisma, TENANT_A, { pipelineId: PIPELINE_A });
    const decisionsCall = mocks.queryRawCalls[1]!;
    expect(decisionsCall.sql).toMatch(
      /DISTINCT ON\s*\(\s*dec\.metadata->>'dealId'\s*\)/i,
    );
    expect(decisionsCall.sql).toMatch(
      /ORDER BY\s+dec\.metadata->>'dealId',\s*dec\.created_at\s+DESC/i,
    );
  });

  it("when no deals match, decision query is NOT fired (no n+1, no wasted round-trip)", async () => {
    const { prisma, mocks } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [],
      decisionRows: [],
      contacts: [],
      companies: [],
    });
    await listDealsByPipeline(prisma, TENANT_A, { pipelineId: PIPELINE_A });
    // Only the deals query fires; the decisions query is skipped by the
    // empty-pipeline early-return.
    expect(mocks.queryRawCalls).toHaveLength(1);
    expect(mocks.queryRawCalls[0]!.sql).toContain("FROM deals");
  });
});

// ─────────────────────────────────────────────
// KAN-970 — non-transition decision visibility regression
//
// The routing-flip visual smoke (2026-05-21) caught the original KAN-967
// query's blind spot: latestDecision joined through deal_stage_history,
// which only surfaces decisions that CAUSED a stage transition. The
// Brain's common-case actions — send_follow_up / wait_for_response /
// no_action — never write a stage_history row, so they were invisible
// on the board. KAN-970 sources from the `decisions` table directly via
// metadata->>'dealId'. These tests pin the new visibility contract.
// ─────────────────────────────────────────────

describe("KAN-970 — non-transition decisions surface on the card (routing-flip regression)", () => {
  it("send_follow_up decision (no stage_history row) IS surfaced as latestDecision", async () => {
    // PROD scenario: routing-flip2 deal received a send_follow_up @ 0.82
    // confidence. No DealStageHistory row was created (the deal stayed in
    // 'New'). Under the old query, latestDecision was null → card showed
    // no AI line. Under KAN-970, the decision is surfaced.
    const { prisma } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [
        {
          id: "deal_routing_flip2",
          name: "RoutingFlip2",
          value: 0,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date(),
          contact_id: "ct_dana",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 1n,
        },
      ],
      // Decision row exists; would have been invisible to the OLD
      // deal_stage_history join because no transition fired. Under KAN-970
      // it's found via metadata->>'dealId'.
      decisionRows: [
        {
          deal_id: "deal_routing_flip2",
          action_type: "send_follow_up",
          confidence: 0.82,
        },
      ],
      contacts: [{ id: "ct_dana", firstName: "Dana", lastName: "RoutingFlip" }],
      companies: [],
    });

    const result = await listDealsByPipeline(prisma, TENANT_A, {
      pipelineId: PIPELINE_A,
    });

    const card = result.stages[0]!.deals[0]!;
    // The CORE regression assertion: AI line data is now populated even
    // though no stage transition fired for this deal.
    expect(card.latestDecision).not.toBeNull();
    expect(card.latestDecision).toEqual({
      actionType: "send_follow_up",
      confidence: 0.82,
    });
  });

  it("decisions query binds dealIds via metadata->>'dealId' = ANY($dealIds::text[]) — not DealStageHistory.deal_id", async () => {
    // Pin the new binding shape. If a future refactor reverts to joining
    // through deal_stage_history, this test fails loudly.
    const { prisma, mocks } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [
        {
          id: "deal_a",
          name: "x",
          value: 0,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date(),
          contact_id: "ct_a",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 1n,
        },
      ],
      decisionRows: [],
      contacts: [{ id: "ct_a", firstName: "A", lastName: "A" }],
      companies: [],
    });
    await listDealsByPipeline(prisma, TENANT_A, { pipelineId: PIPELINE_A });

    const decisionsCall = mocks.queryRawCalls[1]!;
    // Predicate is JSONB key extraction, NOT a column join
    expect(decisionsCall.sql).toMatch(
      /dec\.metadata->>'dealId'\s*=\s*ANY/i,
    );
    // No vestigial deal_stage_history reference
    expect(decisionsCall.sql).not.toContain("deal_stage_history");
    expect(decisionsCall.sql).not.toContain("dsh.deal_id");
  });

  it("decisions for a different deal in the same tenant are ignored (DISTINCT ON scoping)", async () => {
    // Two deals on the same pipeline; only one has a decision. The other
    // gets latestDecision: null (no fabrication of cross-deal context).
    const { prisma } = makePrisma({
      pipeline: { id: PIPELINE_A, stages: [{ id: STAGE_NEW }] },
      dealRows: [
        {
          id: "deal_a",
          name: "Deal A",
          value: 0,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date(),
          contact_id: "ct_a",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 2n,
        },
        {
          id: "deal_b",
          name: "Deal B",
          value: 0,
          currency: "USD",
          current_stage_id: STAGE_NEW,
          entered_stage_at: new Date(),
          contact_id: "ct_b",
          company_id: null,
          status: "open",
          probability: null,
          stage_total: 2n,
        },
      ],
      decisionRows: [
        // Only deal_a has a decision
        {
          deal_id: "deal_a",
          action_type: "send_follow_up",
          confidence: 0.82,
        },
      ],
      contacts: [
        { id: "ct_a", firstName: "Alice", lastName: "A" },
        { id: "ct_b", firstName: "Bob", lastName: "B" },
      ],
      companies: [],
    });

    const result = await listDealsByPipeline(prisma, TENANT_A, {
      pipelineId: PIPELINE_A,
    });

    const cards = result.stages[0]!.deals;
    expect(cards).toHaveLength(2);
    const cardA = cards.find((c) => c.id === "deal_a")!;
    const cardB = cards.find((c) => c.id === "deal_b")!;
    expect(cardA.latestDecision?.actionType).toBe("send_follow_up");
    expect(cardB.latestDecision).toBeNull();
  });
});
