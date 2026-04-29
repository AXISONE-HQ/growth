/**
 * KAN-718 Day 10 — auditLog router tests.
 *
 * Coverage:
 *   - list paginates + filters by actionTypePrefix
 *   - default filter excludes brain.blueprint_* events (operator-signal hygiene)
 *   - includeInfrastructure=true returns all events
 *   - cross-tenant rejection on getById (NOT_FOUND, no leak)
 *   - empty result on cross-tenant list (no leak via reveal)
 */
import { describe, it, expect } from "vitest";
import { listAuditLog, getAuditLogEntry } from "../audit-log-router.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

interface FakeRow {
  id: string;
  tenantId: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
  reasoning: string | null;
  createdAt: Date;
}

function row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: `audit-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT_A,
    actor: "uid-fred",
    actionType: "recommendation.accept",
    payload: {},
    reasoning: null,
    createdAt: new Date("2026-04-29T18:00:00Z"),
    ...overrides,
  };
}

function whereMatches(r: FakeRow, where: Record<string, unknown>): boolean {
  if (where.tenantId && r.tenantId !== where.tenantId) return false;
  const at = where.actionType as { startsWith?: string } | undefined;
  if (at?.startsWith && !r.actionType.startsWith(at.startsWith)) return false;
  const not = where.NOT as Array<{ actionType: { startsWith: string } }> | undefined;
  if (not) {
    for (const n of not) {
      if (r.actionType.startsWith(n.actionType.startsWith)) return false;
    }
  }
  return true;
}

function makePrisma(rows: FakeRow[]) {
  return {
    auditLog: {
      findMany: async ({
        where,
        skip = 0,
        take = 50,
      }: {
        where: Record<string, unknown>;
        skip?: number;
        take?: number;
      }) => rows.filter((r) => whereMatches(r, where)).slice(skip, skip + take),
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => whereMatches(r, where)).length,
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) => rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null,
    },
  } as never;
}

describe("KAN-718 Day 10 — listAuditLog", () => {
  it("default filter hides brain.blueprint_* events; includeInfrastructure=true shows them", async () => {
    const data = [
      row({ id: "rec1", actionType: "recommendation.accept" }),
      row({ id: "rec2", actionType: "recommendation.dismiss" }),
      row({ id: "boot1", actionType: "brain.blueprint_loaded" }),
      row({ id: "boot2", actionType: "brain.blueprint_reloaded" }),
    ];
    const prisma = makePrisma(data);

    const filtered = await listAuditLog(prisma, TENANT_A, {});
    expect(filtered.items.map((i) => i.id).sort()).toEqual(["rec1", "rec2"]);
    expect(filtered.includeInfrastructure).toBe(false);

    const all = await listAuditLog(prisma, TENANT_A, { includeInfrastructure: true });
    expect(all.items.length).toBe(4);
    expect(all.includeInfrastructure).toBe(true);
  });

  it("filters by actionTypePrefix", async () => {
    const data = [
      row({ id: "a", actionType: "recommendation.accept" }),
      row({ id: "b", actionType: "csv.import_completed" }),
      row({ id: "c", actionType: "recommendation.dismiss" }),
    ];
    const prisma = makePrisma(data);

    const recs = await listAuditLog(prisma, TENANT_A, { actionTypePrefix: "recommendation." });
    expect(recs.items.map((i) => i.id).sort()).toEqual(["a", "c"]);

    const csv = await listAuditLog(prisma, TENANT_A, { actionTypePrefix: "csv." });
    expect(csv.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("paginates via limit + offset", async () => {
    const data = Array.from({ length: 7 }, (_, i) => row({ id: `r${i}`, actionType: "recommendation.accept" }));
    const prisma = makePrisma(data);

    const page1 = await listAuditLog(prisma, TENANT_A, { limit: 3, offset: 0 });
    expect(page1.items).toHaveLength(3);
    expect(page1.total).toBe(7);

    const page2 = await listAuditLog(prisma, TENANT_A, { limit: 3, offset: 3 });
    expect(page2.items).toHaveLength(3);

    const page3 = await listAuditLog(prisma, TENANT_A, { limit: 3, offset: 6 });
    expect(page3.items).toHaveLength(1);
  });

  it("excludes cross-tenant rows from list (no leak via reveal)", async () => {
    const data = [
      row({ id: "a", tenantId: TENANT_A, actionType: "recommendation.accept" }),
      row({ id: "b", tenantId: TENANT_B, actionType: "recommendation.accept" }),
    ];
    const prisma = makePrisma(data);
    const result = await listAuditLog(prisma, TENANT_A, {});
    expect(result.items.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("KAN-718 Day 10 — getAuditLogEntry", () => {
  it("returns own-tenant row by id", async () => {
    const data = [row({ id: "audit-1", tenantId: TENANT_A, actionType: "recommendation.accept" })];
    const prisma = makePrisma(data);
    const result = await getAuditLogEntry(prisma, TENANT_A, "audit-1");
    expect(result.id).toBe("audit-1");
    expect(result.actionType).toBe("recommendation.accept");
  });

  it("rejects cross-tenant access with NOT_FOUND (no leak)", async () => {
    const data = [row({ id: "audit-1", tenantId: TENANT_B })];
    const prisma = makePrisma(data);
    await expect(getAuditLogEntry(prisma, TENANT_A, "audit-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
