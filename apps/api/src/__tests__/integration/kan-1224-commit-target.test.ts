/**
 * KAN-1224 Phase A — commitTarget panel-commit propagation (tRPC caller).
 *
 * Verifies the server side of the panel-commit → dimension-advance flow:
 *   1. commitTarget derives a lowest-common-denominator vehicleTargetDescriptor
 *      from the selected vehicles and merges it into Campaign.proposedPlan
 *      (so the orchestrator's reconcileCommittedTargetState can mark the
 *      'product' dimension confirmed on the next chat turn).
 *   2. commitTarget emits a distinct `campaign.dimension_advanced` audit entry
 *      (Memo 53) alongside the existing `campaign.target_committed` entry.
 *
 * The orchestrator-side reconciliation (the behavior that stops the LLM
 * re-asking "how many?") is covered in conversational-orchestrator.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appRouter } from "../../router.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CID = "5869490d-e522-4e0e-ac6a-7db6bec81d11";

const campaignFindFirst = vi.fn();
const campaignUpdate = vi.fn();
const vehicleFindMany = vi.fn();
const auditCreate = vi.fn();

// commitTarget runs entirely inside ctx.prisma.$transaction(cb); we route the
// tx client to the same mock object so every tx.* call lands on these spies.
const tx = {
  campaign: { findFirst: campaignFindFirst, update: campaignUpdate },
  vehicle: { findMany: vehicleFindMany },
  auditLog: { create: auditCreate },
};
const mockedPrisma = {
  ...tx,
  $transaction: (cb: (txc: typeof tx) => unknown) => cb(tx),
};

function caller() {
  const ctx = {
    prisma: mockedPrisma as unknown,
    tenantId: TENANT,
    firebaseUser: { uid: "op-1", email: "op@example.com" },
  } as Parameters<typeof appRouter.createCaller>[0];
  return appRouter.createCaller(ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  // findFirst is called twice: (1) precondition select{id,targetEntityType},
  // (2) existing-proposedPlan read select{proposedPlan}. Branch on the select.
  campaignFindFirst.mockImplementation((args: { select?: Record<string, true> }) => {
    if (args.select?.proposedPlan) return Promise.resolve({ proposedPlan: null });
    return Promise.resolve({ id: CID, targetEntityType: null });
  });
  campaignUpdate.mockResolvedValue({
    id: CID,
    targetEntityType: "vehicle",
    targetEntityIds: ["veh-1", "veh-2"],
  });
  auditCreate.mockResolvedValue({});
});

function descriptorFromUpdateCalls(): Record<string, unknown> | undefined {
  const planCall = campaignUpdate.mock.calls.find(
    (c) => (c[0] as { data?: { proposedPlan?: unknown } }).data?.proposedPlan,
  );
  const plan = (planCall?.[0] as { data: { proposedPlan: Record<string, unknown> } })
    ?.data?.proposedPlan;
  return plan?.vehicleTargetDescriptor as Record<string, unknown> | undefined;
}

describe("KAN-1224 — campaigns.commitTarget vehicle descriptor + audit", () => {
  it("uniform selection → descriptor carries all shared fields + maxCount", async () => {
    vehicleFindMany.mockResolvedValue([
      { year: 2007, make: "Honda", model: "CR-V", condition: "used" },
      { year: 2007, make: "Honda", model: "CR-V", condition: "used" },
    ]);

    await caller().campaigns.commitTarget({
      campaignId: CID,
      entityType: "vehicle",
      entityIds: ["veh-1", "veh-2"],
    });

    expect(descriptorFromUpdateCalls()).toEqual({
      maxCount: 2,
      year: 2007,
      make: "Honda",
      model: "CR-V",
      condition: "used",
    });
  });

  it("mixed selection → lowest-common-denominator drops differing fields", async () => {
    vehicleFindMany.mockResolvedValue([
      { year: 2007, make: "Honda", model: "CR-V", condition: "used" },
      { year: 2010, make: "Honda", model: "Civic", condition: "new" },
    ]);

    await caller().campaigns.commitTarget({
      campaignId: CID,
      entityType: "vehicle",
      entityIds: ["veh-1", "veh-2"],
    });

    // Only `make` is shared; year/model/condition differ → omitted.
    expect(descriptorFromUpdateCalls()).toEqual({ maxCount: 2, make: "Honda" });
  });

  it("emits campaign.dimension_advanced alongside campaign.target_committed", async () => {
    vehicleFindMany.mockResolvedValue([
      { year: 2007, make: "Honda", model: "CR-V", condition: "used" },
    ]);

    await caller().campaigns.commitTarget({
      campaignId: CID,
      entityType: "vehicle",
      entityIds: ["veh-1"],
    });

    const actionTypes = auditCreate.mock.calls.map(
      (c) => (c[0] as { data: { actionType: string } }).data.actionType,
    );
    expect(actionTypes).toContain("campaign.target_committed");
    expect(actionTypes).toContain("campaign.dimension_advanced");

    const advanced = auditCreate.mock.calls.find(
      (c) =>
        (c[0] as { data: { actionType: string } }).data.actionType ===
        "campaign.dimension_advanced",
    );
    expect((advanced?.[0] as { data: { payload: unknown } }).data.payload).toMatchObject({
      campaignId: CID,
      dimension: "product",
      via: "panel_commit",
      entityType: "vehicle",
      count: 1,
    });
  });

  it("product-mode commit does NOT compute a vehicle descriptor", async () => {
    await caller().campaigns.commitTarget({
      campaignId: CID,
      entityType: "product",
      entityIds: ["prod-1"],
    });
    expect(vehicleFindMany).not.toHaveBeenCalled();
    expect(descriptorFromUpdateCalls()).toBeUndefined();
  });
});
