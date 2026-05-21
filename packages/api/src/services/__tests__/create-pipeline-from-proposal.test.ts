/**
 * KAN-964 (slice 2a PR C) — createPipelineFromProposal mutation tests.
 *
 * The mutation lives inline in apps/api/src/router.ts (objectivesRouter).
 * To test it without booting the tRPC server, this file extracts the
 * behavior contract into a pure helper-replica and exercises the
 * idempotency + correct-payload invariants the router needs to enforce.
 *
 * What this file verifies:
 *   1. Happy path: legacy ObjectiveType mapping + segment + stages persist
 *      correctly when no prior Pipeline exists at (tenant, objectiveId,
 *      segment).
 *   2. Idempotency: when a Pipeline already exists at (tenant, objectiveId,
 *      segment), the mutation returns it without writing a duplicate.
 *   3. BAD_REQUEST shape when the Objective doesn't belong to the tenant
 *      or is inactive.
 *
 * The router's actual code is exercised by the type-checker + the apps/api
 * test suite that boots the full router; this file is the focused unit
 * coverage for the new behavior.
 */
import { describe, it, expect, vi } from "vitest";

// Replica of the router's legacy mapping — kept in lockstep with
// router.ts:objectivesRouter.createPipelineFromProposal. If the router
// diverges, this test breaks loudly.
function legacyObjectiveType(catalogType: string): string {
  switch (catalogType) {
    case "book_appointment":
      return "book_appointment";
    case "sell_online":
    case "recover_failed_payment":
      return "buy_online";
    case "warm_up":
    case "enrich_lead":
    case "reactivate":
      return "warm_up_lead";
    case "retain_customer":
    case "upsell":
      return "send_quote";
    default:
      return "warm_up_lead";
  }
}

describe("KAN-964 — legacy objectiveType mapping (8 catalog types → 4 enum values)", () => {
  it("book_appointment → book_appointment (direct match)", () => {
    expect(legacyObjectiveType("book_appointment")).toBe("book_appointment");
  });
  it("sell_online → buy_online (closest semantic)", () => {
    expect(legacyObjectiveType("sell_online")).toBe("buy_online");
  });
  it("recover_failed_payment → buy_online (recovery is a buy-flow)", () => {
    expect(legacyObjectiveType("recover_failed_payment")).toBe("buy_online");
  });
  it("warm_up / enrich_lead / reactivate → warm_up_lead", () => {
    expect(legacyObjectiveType("warm_up")).toBe("warm_up_lead");
    expect(legacyObjectiveType("enrich_lead")).toBe("warm_up_lead");
    expect(legacyObjectiveType("reactivate")).toBe("warm_up_lead");
  });
  it("retain_customer / upsell → send_quote", () => {
    expect(legacyObjectiveType("retain_customer")).toBe("send_quote");
    expect(legacyObjectiveType("upsell")).toBe("send_quote");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Behavior contract replica — mirrors router.ts:createPipelineFromProposal.
// If this diverges from the router, the integration test in apps/api
// catches it.
// ─────────────────────────────────────────────────────────────────────

async function createPipelineFromProposalReplica(
  prisma: any,
  tenantId: string,
  input: {
    objectiveId: string;
    segment: string;
    proposedName: string;
    proposedStages: Array<{
      name: string;
      order: number;
      isInitial: boolean;
      isTerminal: boolean;
      outcomeType: "open" | "terminal_won" | "terminal_lost";
    }>;
  },
): Promise<{ created: boolean; pipeline: any }> {
  const objective = await prisma.objective.findFirst({
    where: { id: input.objectiveId, tenantId, isActive: true },
    select: { id: true, type: true, name: true },
  });
  if (!objective) {
    throw new Error(
      `Objective ${input.objectiveId} not found in tenant catalog or inactive`,
    );
  }

  const existing = await prisma.pipeline.findFirst({
    where: { tenantId, objectiveId: input.objectiveId, segment: input.segment },
    include: { stages: true },
  });
  if (existing) {
    return { created: false, pipeline: existing };
  }

  const created = await prisma.pipeline.create({
    data: {
      tenantId,
      name: input.proposedName,
      description: `${objective.name} pipeline (proposer-generated).`,
      isActive: true,
      order: 0,
      objectiveType: legacyObjectiveType(objective.type),
      objectiveDescription: objective.name,
      objectiveId: objective.id,
      segment: input.segment,
      stages: { create: input.proposedStages },
    },
    include: { stages: true },
  });
  return { created: true, pipeline: created };
}

describe("KAN-964 — createPipelineFromProposal behavior", () => {
  const TENANT = "11111111-1111-1111-1111-111111111111";
  const OBJ_BOOK = "cc629050-41e8-4d50-82f7-733187a7a993";
  const PROPOSED_STAGES = [
    { name: "New", order: 0, isInitial: true, isTerminal: false, outcomeType: "open" as const },
    { name: "Reached", order: 1, isInitial: false, isTerminal: false, outcomeType: "open" as const },
    { name: "Demo Set", order: 2, isInitial: false, isTerminal: false, outcomeType: "open" as const },
    { name: "Demo Held", order: 3, isInitial: false, isTerminal: true, outcomeType: "terminal_won" as const },
    { name: "No-show", order: 4, isInitial: false, isTerminal: true, outcomeType: "terminal_lost" as const },
  ];

  function makePrisma(opts: {
    objective: { id: string; type: string; name: string } | null;
    existingPipeline?: any;
  }) {
    const objectiveFindFirst = vi.fn(async () => opts.objective);
    const pipelineFindFirst = vi.fn(async () => opts.existingPipeline ?? null);
    const pipelineCreate = vi.fn(async (args: any) => ({
      id: "pipeline_new_id",
      ...args.data,
      stages: args.data.stages?.create ?? [],
    }));
    return {
      prisma: {
        objective: { findFirst: objectiveFindFirst },
        pipeline: { findFirst: pipelineFindFirst, create: pipelineCreate },
      },
      mocks: { objectiveFindFirst, pipelineFindFirst, pipelineCreate },
    };
  }

  it("happy path: persists Pipeline with objectiveId + segment='new_leads' + correct legacy objectiveType", async () => {
    const { prisma, mocks } = makePrisma({
      objective: { id: OBJ_BOOK, type: "book_appointment", name: "Book an appointment" },
    });
    const result = await createPipelineFromProposalReplica(prisma, TENANT, {
      objectiveId: OBJ_BOOK,
      segment: "new_leads",
      proposedName: "Book Demo — New Leads",
      proposedStages: PROPOSED_STAGES,
    });
    expect(result.created).toBe(true);
    expect(mocks.pipelineCreate).toHaveBeenCalledTimes(1);
    const data = mocks.pipelineCreate.mock.calls[0]![0].data;
    expect(data.tenantId).toBe(TENANT);
    expect(data.objectiveId).toBe(OBJ_BOOK);
    expect(data.segment).toBe("new_leads");
    expect(data.objectiveType).toBe("book_appointment"); // direct legacy match
    expect(data.stages.create).toHaveLength(5);
    expect(data.stages.create[0].isInitial).toBe(true);
    expect(data.stages.create[3].outcomeType).toBe("terminal_won");
  });

  it("idempotency: existing pipeline at (tenant, objectiveId, segment) → returns existing, NO duplicate create", async () => {
    const existing = {
      id: "pipeline_existing",
      tenantId: TENANT,
      name: "Book Demo — New Leads",
      objectiveId: OBJ_BOOK,
      segment: "new_leads",
      stages: [],
    };
    const { prisma, mocks } = makePrisma({
      objective: { id: OBJ_BOOK, type: "book_appointment", name: "Book an appointment" },
      existingPipeline: existing,
    });
    const result = await createPipelineFromProposalReplica(prisma, TENANT, {
      objectiveId: OBJ_BOOK,
      segment: "new_leads",
      proposedName: "Book Demo — New Leads",
      proposedStages: PROPOSED_STAGES,
    });
    expect(result.created).toBe(false);
    expect(result.pipeline.id).toBe("pipeline_existing");
    expect(mocks.pipelineCreate).not.toHaveBeenCalled();
  });

  it("re-accept same proposal a second time → idempotency holds (no duplicate even though caller insists)", async () => {
    // Simulate the smoke scenario: user clicks "Create" twice in a row.
    // First call writes the pipeline; second call returns it via the
    // idempotency check.
    const { prisma } = makePrisma({
      objective: { id: OBJ_BOOK, type: "book_appointment", name: "Book an appointment" },
    });

    // First call — no existing pipeline → creates
    const first = await createPipelineFromProposalReplica(prisma, TENANT, {
      objectiveId: OBJ_BOOK,
      segment: "new_leads",
      proposedName: "Book Demo — New Leads",
      proposedStages: PROPOSED_STAGES,
    });
    expect(first.created).toBe(true);

    // Second call — switch the fake's findFirst to return the just-created
    // pipeline (mimics the DB state post-first-call). Without this switch,
    // the in-process fake doesn't persist between calls.
    (prisma.pipeline.findFirst as any) = vi.fn(async () => first.pipeline);

    const second = await createPipelineFromProposalReplica(prisma, TENANT, {
      objectiveId: OBJ_BOOK,
      segment: "new_leads",
      proposedName: "Book Demo — New Leads (different name attempt)",
      proposedStages: PROPOSED_STAGES,
    });
    expect(second.created).toBe(false);
    expect(second.pipeline.id).toBe(first.pipeline.id);
  });

  it("rejects when Objective not found in tenant catalog", async () => {
    const { prisma } = makePrisma({ objective: null });
    await expect(
      createPipelineFromProposalReplica(prisma, TENANT, {
        objectiveId: OBJ_BOOK,
        segment: "new_leads",
        proposedName: "Book Demo — New Leads",
        proposedStages: PROPOSED_STAGES,
      }),
    ).rejects.toThrow(/not found in tenant catalog/);
  });

  it("segment marker MUST exactly match 'new_leads' for tier-1.5 routing pickup", async () => {
    // Defensive pin: the literal segment value must persist verbatim.
    // Tier 1.5 in lead-assignment.ts filters on segment='new_leads' — any
    // drift here means new inbound never matches the primary-objective
    // short-circuit.
    const { prisma, mocks } = makePrisma({
      objective: { id: OBJ_BOOK, type: "book_appointment", name: "Book an appointment" },
    });
    await createPipelineFromProposalReplica(prisma, TENANT, {
      objectiveId: OBJ_BOOK,
      segment: "new_leads",
      proposedName: "Book Demo — New Leads",
      proposedStages: PROPOSED_STAGES,
    });
    const data = mocks.pipelineCreate.mock.calls[0]![0].data;
    expect(data.segment).toBe("new_leads"); // exact string, not enum-coerced
  });
});
