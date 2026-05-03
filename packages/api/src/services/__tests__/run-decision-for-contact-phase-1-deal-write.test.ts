/**
 * KAN-786 Phase 1 sub-cohort (c) — orchestrator Deal-write hook tests.
 *
 * Tests the maybeWritePhase1Deal helper extracted from run-decision-for-contact.ts.
 * Helper fires after each decision-create in runAgentic + runFreeform; writes a
 * Deal row when (outcome === 'EXECUTED') AND (actionType is closed_won/_lost).
 *
 * Spec sources:
 *   - PRD §4 (commits 15723a0/d1c44fd/dd94027/80e2c7a on docs/phase-1-prd)
 *   - Edit 2 idempotency contract (correlationId = decision.id)
 *   - Q9.3 revised recommendation (hardcode null/USD per KAN-790 deferral)
 *   - feedback_prd_assumed_infrastructure_check_kan_786 (anchors #1 + #2)
 *
 * Sibling test pattern: matches run-decision-for-contact-freeform-matrix.test.ts
 * (vitest + hand-rolled prisma mocks via vi.fn()).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Deal, PrismaClient } from "@prisma/client";
import { maybeWritePhase1Deal } from "../run-decision-for-contact.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const CONTACT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DECISION_A = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const DECISION_B = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function makeMockPrisma() {
  const findUnique = vi.fn(
    async (_args: { where: { correlationId: string } }): Promise<Deal | null> => null,
  );
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }): Promise<Deal> => ({
    id: "deal_" + Math.random().toString(36).slice(2, 10),
    tenantId: data.tenantId as string,
    contactId: data.contactId as string,
    correlationId: (data.correlationId as string | undefined) ?? null,
    value: (data.value as never) ?? null,
    currency: data.currency as string,
    status: data.status as never,
    closedAt: (data.closedAt as Date | undefined) ?? null,
    metadata: (data.metadata as object) ?? {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const prisma = {
    deal: { findUnique, create },
  } as unknown as PrismaClient;
  return { prisma, findUnique, create };
}

describe("maybeWritePhase1Deal — happy paths", () => {
  let mock: ReturnType<typeof makeMockPrisma>;

  beforeEach(() => {
    mock = makeMockPrisma();
  });

  it("approved transition_to_closed_won writes Deal row (status, closedAt, correlationId, value=null, currency=USD)", async () => {
    await maybeWritePhase1Deal(mock.prisma, {
      decisionId: DECISION_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      actionType: "transition_to_closed_won",
      outcome: "EXECUTED",
    });

    expect(mock.findUnique).toHaveBeenCalledTimes(1);
    expect(mock.findUnique).toHaveBeenCalledWith({
      where: { correlationId: DECISION_A },
    });
    expect(mock.create).toHaveBeenCalledTimes(1);
    const args = mock.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.tenantId).toBe(TENANT_A);
    expect(args.data.contactId).toBe(CONTACT_A);
    expect(args.data.correlationId).toBe(DECISION_A);
    expect(args.data.status).toBe("closed_won");
    expect(args.data.value).toBeNull();
    expect(args.data.currency).toBe("USD");
    expect(args.data.metadata).toEqual({});
    expect(args.data.closedAt).toBeInstanceOf(Date);
  });

  it("approved transition_to_closed_lost writes Deal row with status=closed_lost", async () => {
    await maybeWritePhase1Deal(mock.prisma, {
      decisionId: DECISION_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      actionType: "transition_to_closed_lost",
      outcome: "EXECUTED",
    });

    expect(mock.create).toHaveBeenCalledTimes(1);
    const args = mock.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.status).toBe("closed_lost");
    expect(args.data.value).toBeNull();
    expect(args.data.currency).toBe("USD");
  });
});

describe("maybeWritePhase1Deal — correlationId idempotency contract (PRD Edit 2)", () => {
  it("same decision.id fired twice → no duplicate Deal (returns no-op on second call)", async () => {
    const mock = makeMockPrisma();
    const args = {
      decisionId: DECISION_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      actionType: "transition_to_closed_won",
      outcome: "EXECUTED" as const,
    };

    await maybeWritePhase1Deal(mock.prisma, args);
    expect(mock.findUnique).toHaveBeenCalledTimes(1);
    expect(mock.create).toHaveBeenCalledTimes(1);

    // Re-arm findUnique to return the existing row on the second call
    const existing: Deal = {
      id: "deal_existing",
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      correlationId: DECISION_A,
      value: null,
      currency: "USD",
      status: "closed_won" as never,
      closedAt: new Date(),
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mock.findUnique.mockResolvedValueOnce(existing);

    await maybeWritePhase1Deal(mock.prisma, args);
    expect(mock.findUnique).toHaveBeenCalledTimes(2);
    expect(mock.create).toHaveBeenCalledTimes(1); // create NOT called again
  });

  it("different decisions on same contact → multiple Deal rows (multi-cycle closed-won works)", async () => {
    const mock = makeMockPrisma();
    const argsA = {
      decisionId: DECISION_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      actionType: "transition_to_closed_won",
      outcome: "EXECUTED" as const,
    };
    const argsB = { ...argsA, decisionId: DECISION_B };

    await maybeWritePhase1Deal(mock.prisma, argsA);
    await maybeWritePhase1Deal(mock.prisma, argsB);

    expect(mock.findUnique).toHaveBeenCalledTimes(2);
    expect(mock.create).toHaveBeenCalledTimes(2); // 2 separate Deals, no cross-decision dedup
  });
});

describe("maybeWritePhase1Deal — gating conditions", () => {
  it("UNAPPROVED decision (outcome=ESCALATED) with closed_won action → NO Deal written", async () => {
    const mock = makeMockPrisma();
    await maybeWritePhase1Deal(mock.prisma, {
      decisionId: DECISION_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      actionType: "transition_to_closed_won",
      outcome: "ESCALATED",
    });

    expect(mock.findUnique).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("approved decision with non-transition action (e.g. send_email) → NO Deal written", async () => {
    const mock = makeMockPrisma();
    await maybeWritePhase1Deal(mock.prisma, {
      decisionId: DECISION_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      actionType: "send_email",
      outcome: "EXECUTED",
    });

    expect(mock.findUnique).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("approved decision with transition_to_qualified (other transition type) → NO Deal written", async () => {
    const mock = makeMockPrisma();
    await maybeWritePhase1Deal(mock.prisma, {
      decisionId: DECISION_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      actionType: "transition_to_qualified",
      outcome: "EXECUTED",
    });

    expect(mock.findUnique).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });
});

describe("maybeWritePhase1Deal — failure isolation (orchestrator must not abort)", () => {
  it("Deal write failure does NOT throw — orchestrator continues (best-effort try/catch)", async () => {
    const mock = makeMockPrisma();
    mock.create.mockRejectedValueOnce(new Error("simulated DB failure"));
    // Suppress the expected console.error so test output stays clean
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      maybeWritePhase1Deal(mock.prisma, {
        decisionId: DECISION_A,
        tenantId: TENANT_A,
        contactId: CONTACT_A,
        actionType: "transition_to_closed_won",
        outcome: "EXECUTED",
      }),
    ).resolves.toBeUndefined(); // returns void, does NOT throw

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toContain("phase-1-deal-write failed");
    errSpy.mockRestore();
  });

  it("findUnique failure does NOT throw — same isolation discipline", async () => {
    const mock = makeMockPrisma();
    mock.findUnique.mockRejectedValueOnce(new Error("simulated lookup failure"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      maybeWritePhase1Deal(mock.prisma, {
        decisionId: DECISION_A,
        tenantId: TENANT_A,
        contactId: CONTACT_A,
        actionType: "transition_to_closed_won",
        outcome: "EXECUTED",
      }),
    ).resolves.toBeUndefined();

    expect(mock.create).not.toHaveBeenCalled(); // failed lookup → no create attempt
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
