/**
 * KAN-1234 Phase A — campaigns.computeProjection (tRPC caller).
 *
 * Drives the scoreboard procedure end-to-end (campaign read → tenant industry →
 * measured-outcome count → reachable count → projection) with a mocked Prisma
 * so it runs without a DB. Canonical: "sell 10 used cars by end of month" →
 * 137 used cars × 6% × 30-day window = 8.2 projected vs goal 10 → STRETCH.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appRouter } from "../../router.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CID = "5869490d-e522-4e0e-ac6a-7db6bec81d11";

const campaignFindFirst = vi.fn();
const tenantFindUnique = vi.fn();
const campaignFindMany = vi.fn();
const vehicleCount = vi.fn();

const mockedPrisma = {
  campaign: { findFirst: campaignFindFirst, findMany: campaignFindMany },
  tenant: { findUnique: tenantFindUnique },
  vehicle: { count: vehicleCount },
};

function caller() {
  const ctx = {
    prisma: mockedPrisma as unknown,
    tenantId: TENANT,
    firebaseUser: { uid: "op-1", email: "op@example.com" },
  } as Parameters<typeof appRouter.createCaller>[0];
  return appRouter.createCaller(ctx);
}

const VEHICLE_CAMPAIGN = {
  goalTarget: 10,
  windowStart: new Date("2026-06-24T00:00:00.000Z"),
  windowEnd: new Date("2026-07-24T00:00:00.000Z"), // 30 days
  targetEntityType: "vehicle" as const,
  proposedPlan: { vehicleTargetDescriptor: { condition: "used", maxCount: 10 } },
  audienceConditions: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  campaignFindFirst.mockResolvedValue(VEHICLE_CAMPAIGN);
  tenantFindUnique.mockResolvedValue({ industry: "used_auto" });
  campaignFindMany.mockResolvedValue([]); // no measured outcomes
  vehicleCount.mockResolvedValue(137);
});

describe("KAN-1234 — campaigns.computeProjection", () => {
  it('canonical vehicle campaign → 137 reachable, 8.2 projected, STRETCH, industry source', async () => {
    const r = await caller().campaigns.computeProjection({ campaignId: CID });
    expect(r.reachableContacts).toBe(137);
    expect(r.closingRate).toBe(0.06);
    expect(r.closingRateSource).toBe("industry");
    expect(r.projected).toBe(8.2);
    expect(r.goal).toBe(10);
    expect(r.gap).toBe(1.8);
    expect(r.verdict).toBe("stretch");
    expect(r.daysInWindow).toBe(30);
  });

  it("vehicle count filtered by descriptor (conditionIn: used)", async () => {
    await caller().campaigns.computeProjection({ campaignId: CID });
    expect(vehicleCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          status: "active",
          condition: { in: ["used"] },
        }),
      }),
    );
  });

  it("partial state (no goalTarget) → reachableContacts only", async () => {
    campaignFindFirst.mockResolvedValue({ ...VEHICLE_CAMPAIGN, goalTarget: null });
    const r = await caller().campaigns.computeProjection({ campaignId: CID });
    expect(r.reachableContacts).toBe(137);
    expect(r.projected).toBeNull();
    expect(r.verdict).toBeNull();
    expect(r.goal).toBeNull();
  });

  it(">= 3 measured outcomes → tenant closing-rate source", async () => {
    campaignFindMany.mockResolvedValue([
      { actualOutcome: { goalHit: true } },
      { actualOutcome: { goalHit: true } },
      { actualOutcome: { goalHit: true } },
      { actualOutcome: { goalHit: false } },
      { actualOutcome: { goalHit: false } },
      { actualOutcome: null }, // unmeasured — excluded
    ]);
    const r = await caller().campaigns.computeProjection({ campaignId: CID });
    expect(r.closingRateSource).toBe("tenant");
    expect(r.closingRate).toBeCloseTo(0.6, 5); // 3 hits / 5 measured
  });

  it("campaign not found → all-null projection (graceful, no throw)", async () => {
    campaignFindFirst.mockResolvedValue(null);
    const r = await caller().campaigns.computeProjection({ campaignId: CID });
    expect(r.reachableContacts).toBeNull();
    expect(r.verdict).toBeNull();
  });
});
