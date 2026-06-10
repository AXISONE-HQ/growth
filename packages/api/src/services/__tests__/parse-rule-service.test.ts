/**
 * KAN-1140 Phase 3 PR 9a — Parse rule lifecycle service unit tests.
 *
 * Uses an in-memory fake Prisma surface. Each test seeds the minimal state
 * needed and asserts behavior on the service's contract:
 *
 *   - Tenant isolation (cross-tenant access surfaces NOT_FOUND)
 *   - Q10 rule count cap enforcement
 *   - Update snapshots prior body to ParseRuleVersion (upsert semantics)
 *   - Delete cascades ParseRuleVersion (via FK; here the fake mirrors)
 *   - Restore promotes snapshot + re-snapshots displaced
 *   - Body validation runs at create AND update (defense-in-depth)
 *   - Audit row written on every successful mutation
 */
import { describe, expect, it, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { MAX_RULES_PER_TENANT, type ParseRuleBody } from "@growth/shared";
import {
  createParseRule,
  updateParseRule,
  deleteParseRule,
  listParseRules,
  getParseRuleDetail,
  restoreParseRulePreviousVersion,
  activateParseRule,
  deactivateParseRule,
} from "../parse-rule-service.js";

interface FakeRule {
  id: string;
  tenantId: string;
  fingerprintId: string | null;
  format: string | null;
  vendor: string | null;
  body: unknown;
  label: string;
  status: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeVersion {
  id: string;
  ruleId: string;
  tenantId: string;
  body: unknown;
  label: string;
  status: string;
  archivedAt: Date;
  archivedBy: string;
}

interface FakeFingerprint {
  id: string;
  tenantId: string;
}

interface FakeAuditRow {
  tenantId: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
}

interface FakePrismaState {
  rules: FakeRule[];
  versions: FakeVersion[];
  fingerprints: FakeFingerprint[];
  audit: FakeAuditRow[];
  nextId: number;
}

function makePrisma(state: FakePrismaState): unknown {
  const newId = () => `id-${state.nextId++}`;
  return {
    parseRule: {
      count: async (args: { where: { tenantId: string } }) => {
        return state.rules.filter((r) => r.tenantId === args.where.tenantId).length;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row: FakeRule = {
          id: newId(),
          tenantId: args.data.tenantId as string,
          fingerprintId: (args.data.fingerprintId as string | null) ?? null,
          format: (args.data.format as string | null) ?? null,
          vendor: (args.data.vendor as string | null) ?? null,
          body: args.data.body,
          label: args.data.label as string,
          status: (args.data.status as string) ?? "pending",
          createdBy: args.data.createdBy as string,
          updatedBy: args.data.updatedBy as string,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.rules.push(row);
        return row;
      },
      findFirst: async (args: {
        where: { id: string; tenantId: string };
        include?: { version?: boolean };
      }) => {
        const r = state.rules.find(
          (x) => x.id === args.where.id && x.tenantId === args.where.tenantId,
        );
        if (!r) return null;
        if (args.include?.version) {
          const v = state.versions.find((x) => x.ruleId === r.id) ?? null;
          return { ...r, version: v };
        }
        return r;
      },
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy: Record<string, unknown>;
        take: number;
        skip: number;
      }) => {
        const w = args.where;
        let rows = state.rules.filter((r) => r.tenantId === w.tenantId);
        if (w.fingerprintId !== undefined) {
          rows = rows.filter((r) => r.fingerprintId === w.fingerprintId);
        }
        if (w.format !== undefined) rows = rows.filter((r) => r.format === w.format);
        if (w.vendor !== undefined) rows = rows.filter((r) => r.vendor === w.vendor);
        if (w.status !== undefined) rows = rows.filter((r) => r.status === w.status);
        return rows.slice(args.skip, args.skip + args.take);
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = state.rules.findIndex((r) => r.id === args.where.id);
        if (idx < 0) throw new Error("not found");
        const updated = { ...state.rules[idx], ...args.data, updatedAt: new Date() } as FakeRule;
        state.rules[idx] = updated;
        return updated;
      },
      delete: async (args: { where: { id: string } }) => {
        const idx = state.rules.findIndex((r) => r.id === args.where.id);
        if (idx < 0) throw new Error("not found");
        const removed = state.rules.splice(idx, 1)[0];
        // FK cascade — drop matching version row.
        state.versions = state.versions.filter((v) => v.ruleId !== args.where.id);
        return removed;
      },
    },
    parseRuleVersion: {
      upsert: async (args: {
        where: { ruleId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const idx = state.versions.findIndex((v) => v.ruleId === args.where.ruleId);
        if (idx >= 0) {
          state.versions[idx] = {
            ...state.versions[idx],
            ...args.update,
            archivedAt: (args.update.archivedAt as Date) ?? new Date(),
          } as FakeVersion;
          return state.versions[idx];
        }
        const row: FakeVersion = {
          id: newId(),
          ruleId: args.create.ruleId as string,
          tenantId: args.create.tenantId as string,
          body: args.create.body,
          label: args.create.label as string,
          status: args.create.status as string,
          archivedAt: new Date(),
          archivedBy: args.create.archivedBy as string,
        };
        state.versions.push(row);
        return row;
      },
      findUnique: async (args: { where: { ruleId: string } }) => {
        return state.versions.find((v) => v.ruleId === args.where.ruleId) ?? null;
      },
    },
    parseFingerprint: {
      findFirst: async (args: { where: { id: string; tenantId: string } }) => {
        const fp = state.fingerprints.find(
          (f) => f.id === args.where.id && f.tenantId === args.where.tenantId,
        );
        return fp ? { id: fp.id } : null;
      },
    },
    auditLog: {
      create: async (args: { data: FakeAuditRow }) => {
        state.audit.push(args.data);
        return args.data;
      },
    },
  };
}

function emptyState(): FakePrismaState {
  return { rules: [], versions: [], fingerprints: [], audit: [], nextId: 1 };
}

const validBody: ParseRuleBody = {
  extractors: [
    {
      field: "firstName",
      extractor: { type: "jsonPath", path: "$.contact.first_name", transforms: ["trim"] },
    },
  ],
};

describe("KAN-1140 PR 9a — createParseRule", () => {
  let state: FakePrismaState;
  beforeEach(() => {
    state = emptyState();
  });

  it("creates rule + writes audit row + returns id", async () => {
    const prisma = makePrisma(state) as never;
    const result = await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "Test Rule",
      body: validBody,
    });
    expect(result.id).toMatch(/^id-/);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0].status).toBe("pending");
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].actionType).toBe("parse_rule.created");
  });

  it("REJECTS when tenant rule count at MAX_RULES_PER_TENANT", async () => {
    for (let i = 0; i < MAX_RULES_PER_TENANT; i++) {
      state.rules.push({
        id: `seed-${i}`,
        tenantId: "t1",
        fingerprintId: null,
        format: null,
        vendor: null,
        body: validBody,
        label: `seed-${i}`,
        status: "pending",
        createdBy: "u1",
        updatedBy: "u1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const prisma = makePrisma(state) as never;
    await expect(
      createParseRule(prisma, { tenantId: "t1", userId: "u1", label: "over", body: validBody }),
    ).rejects.toThrow(TRPCError);
  });

  it("REJECTS cross-tenant fingerprint reference (NOT_FOUND)", async () => {
    state.fingerprints.push({ id: "fp-other-tenant", tenantId: "t2" });
    const prisma = makePrisma(state) as never;
    await expect(
      createParseRule(prisma, {
        tenantId: "t1",
        userId: "u1",
        label: "x",
        body: validBody,
        fingerprintId: "fp-other-tenant",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("accepts valid same-tenant fingerprint reference", async () => {
    state.fingerprints.push({ id: "fp-1", tenantId: "t1" });
    const prisma = makePrisma(state) as never;
    const result = await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "x",
      body: validBody,
      fingerprintId: "fp-1",
    });
    expect(result.id).toMatch(/^id-/);
    expect(state.rules[0].fingerprintId).toBe("fp-1");
  });

  it("REJECTS invalid body (Zod schema; defense-in-depth)", async () => {
    const prisma = makePrisma(state) as never;
    await expect(
      createParseRule(prisma, {
        tenantId: "t1",
        userId: "u1",
        label: "x",
        body: { extractors: [] } as unknown as ParseRuleBody, // empty → min 1 violation
      }),
    ).rejects.toThrow();
  });
});

describe("KAN-1140 PR 9a — updateParseRule", () => {
  let state: FakePrismaState;
  let createdId: string;
  beforeEach(async () => {
    state = emptyState();
    const prisma = makePrisma(state) as never;
    const { id } = await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "v1",
      body: validBody,
    });
    createdId = id;
  });

  it("snapshots prior body to ParseRuleVersion (upsert create path)", async () => {
    const prisma = makePrisma(state) as never;
    const newBody: ParseRuleBody = {
      extractors: [{ field: "lastName", extractor: { type: "jsonPath", path: "$.last" } }],
    };
    await updateParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      ruleId: createdId,
      body: newBody,
      label: "v2",
    });
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0].label).toBe("v1");
    expect(state.rules[0].label).toBe("v2");
  });

  it("second update overwrites prior snapshot (upsert update path; one previous version retained)", async () => {
    const prisma = makePrisma(state) as never;
    await updateParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      ruleId: createdId,
      label: "v2",
    });
    await updateParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      ruleId: createdId,
      label: "v3",
    });
    // Still exactly one snapshot row — the v2 body (the displaced before
    // v3 took over).
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0].label).toBe("v2");
    expect(state.rules[0].label).toBe("v3");
  });

  it("REJECTS update from wrong tenant (NOT_FOUND)", async () => {
    const prisma = makePrisma(state) as never;
    await expect(
      updateParseRule(prisma, {
        tenantId: "t-other",
        userId: "u1",
        ruleId: createdId,
        label: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("REJECTS invalid body on update (Zod; defense-in-depth)", async () => {
    const prisma = makePrisma(state) as never;
    await expect(
      updateParseRule(prisma, {
        tenantId: "t1",
        userId: "u1",
        ruleId: createdId,
        body: { extractors: [] } as unknown as ParseRuleBody,
      }),
    ).rejects.toThrow();
  });

  it("writes audit row with fieldsChanged", async () => {
    const prisma = makePrisma(state) as never;
    await updateParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      ruleId: createdId,
      label: "v2",
      status: "active",
    });
    const audit = state.audit.find((a) => a.actionType === "parse_rule.updated");
    expect(audit).toBeDefined();
    expect((audit?.payload.fieldsChanged as string[]).sort()).toEqual(["label", "status"]);
  });
});

describe("KAN-1140 PR 9a — deleteParseRule", () => {
  let state: FakePrismaState;
  let createdId: string;
  beforeEach(async () => {
    state = emptyState();
    const prisma = makePrisma(state) as never;
    const { id } = await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "x",
      body: validBody,
    });
    createdId = id;
    // Seed a snapshot to verify cascade behavior.
    await updateParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId: id, label: "x2" });
  });

  it("cascades ParseRuleVersion (FK onDelete: Cascade)", async () => {
    expect(state.versions).toHaveLength(1);
    const prisma = makePrisma(state) as never;
    await deleteParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId: createdId });
    expect(state.rules).toHaveLength(0);
    expect(state.versions).toHaveLength(0);
  });

  it("REJECTS delete from wrong tenant (NOT_FOUND)", async () => {
    const prisma = makePrisma(state) as never;
    await expect(
      deleteParseRule(prisma, { tenantId: "t-other", userId: "u1", ruleId: createdId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("writes audit row on successful delete", async () => {
    const prisma = makePrisma(state) as never;
    await deleteParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId: createdId });
    const audit = state.audit.find((a) => a.actionType === "parse_rule.deleted");
    expect(audit).toBeDefined();
  });
});

describe("KAN-1140 PR 9a — listParseRules", () => {
  let state: FakePrismaState;
  beforeEach(async () => {
    state = emptyState();
    state.fingerprints.push({ id: "fp-a", tenantId: "t1" });
    const prisma = makePrisma(state) as never;
    await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "global",
      body: validBody,
    });
    await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "fp-scoped",
      body: validBody,
      fingerprintId: "fp-a",
    });
    await createParseRule(prisma, {
      tenantId: "t2",
      userId: "u2",
      label: "other-tenant",
      body: validBody,
    });
  });

  it("only returns tenant-scoped rules", async () => {
    const prisma = makePrisma(state) as never;
    const { rows } = await listParseRules(prisma, { tenantId: "t1" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === "t1")).toBe(true);
  });

  it("filters by fingerprintId", async () => {
    const prisma = makePrisma(state) as never;
    const { rows } = await listParseRules(prisma, { tenantId: "t1", fingerprintId: "fp-a" });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("fp-scoped");
  });
});

describe("KAN-1140 PR 9a — getParseRuleDetail + restoreParseRulePreviousVersion", () => {
  let state: FakePrismaState;
  let ruleId: string;
  beforeEach(async () => {
    state = emptyState();
    const prisma = makePrisma(state) as never;
    const { id } = await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "v1",
      body: validBody,
    });
    ruleId = id;
    await updateParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      ruleId: id,
      label: "v2",
    });
  });

  it("getParseRuleDetail returns rule + previous version when one exists", async () => {
    const prisma = makePrisma(state) as never;
    const detail = await getParseRuleDetail(prisma, { tenantId: "t1", ruleId });
    expect(detail.label).toBe("v2");
    expect(detail.previousVersion).not.toBeNull();
    expect(detail.previousVersion?.label).toBe("v1");
  });

  it("getParseRuleDetail REJECTS wrong-tenant access (NOT_FOUND)", async () => {
    const prisma = makePrisma(state) as never;
    await expect(
      getParseRuleDetail(prisma, { tenantId: "t-other", ruleId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("restore promotes prior body back AND re-snapshots displaced (reversible)", async () => {
    const prisma = makePrisma(state) as never;
    await restoreParseRulePreviousVersion(prisma, {
      tenantId: "t1",
      userId: "u1",
      ruleId,
    });
    // Rule's current label is now v1 (restored).
    expect(state.rules[0].label).toBe("v1");
    // The displaced (v2) has become the new snapshot — restore is reversible.
    expect(state.versions[0].label).toBe("v2");
  });

  it("restore REJECTS when no snapshot exists (BAD_REQUEST)", async () => {
    // Fresh rule with no prior version.
    const prisma = makePrisma(state) as never;
    const { id: freshId } = await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "fresh",
      body: validBody,
    });
    await expect(
      restoreParseRulePreviousVersion(prisma, {
        tenantId: "t1",
        userId: "u1",
        ruleId: freshId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("KAN-1140 PR 9c — activateParseRule", () => {
  let state: FakePrismaState;
  let ruleId: string;
  beforeEach(async () => {
    state = emptyState();
    const prisma = makePrisma(state) as never;
    const { id } = await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "test rule",
      body: validBody,
    });
    ruleId = id;
  });

  it("pending → active; writes audit row; returns status", async () => {
    const prisma = makePrisma(state) as never;
    const result = await activateParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId });
    expect(result.status).toBe("active");
    expect(state.rules[0].status).toBe("active");
    const audit = state.audit.find((a) => a.actionType === "parse_rule.activated");
    expect(audit).toBeDefined();
    expect(audit?.payload.fromStatus).toBe("pending");
  });

  it("disabled → active", async () => {
    state.rules[0].status = "disabled";
    const prisma = makePrisma(state) as never;
    const result = await activateParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId });
    expect(result.status).toBe("active");
  });

  it("already active → idempotent no-op (no audit)", async () => {
    state.rules[0].status = "active";
    const beforeAuditCount = state.audit.length;
    const prisma = makePrisma(state) as never;
    const result = await activateParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId });
    expect(result.status).toBe("active");
    expect(state.audit.length).toBe(beforeAuditCount); // no new audit row
  });

  it("REJECTS wrong tenant (NOT_FOUND)", async () => {
    const prisma = makePrisma(state) as never;
    await expect(
      activateParseRule(prisma, { tenantId: "t-other", userId: "u1", ruleId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("KAN-1140 PR 9c — deactivateParseRule", () => {
  let state: FakePrismaState;
  let ruleId: string;
  beforeEach(async () => {
    state = emptyState();
    const prisma = makePrisma(state) as never;
    const { id } = await createParseRule(prisma, {
      tenantId: "t1",
      userId: "u1",
      label: "test rule",
      body: validBody,
    });
    ruleId = id;
    state.rules[0].status = "active";
  });

  it("active → disabled; writes audit row", async () => {
    const prisma = makePrisma(state) as never;
    const result = await deactivateParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId });
    expect(result.status).toBe("disabled");
    expect(state.rules[0].status).toBe("disabled");
    const audit = state.audit.find((a) => a.actionType === "parse_rule.deactivated");
    expect(audit).toBeDefined();
  });

  it("REJECTS pending → throws BAD_REQUEST (not active)", async () => {
    state.rules[0].status = "pending";
    const prisma = makePrisma(state) as never;
    await expect(
      deactivateParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("REJECTS disabled → throws BAD_REQUEST (already off)", async () => {
    state.rules[0].status = "disabled";
    const prisma = makePrisma(state) as never;
    await expect(
      deactivateParseRule(prisma, { tenantId: "t1", userId: "u1", ruleId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("REJECTS wrong tenant (NOT_FOUND)", async () => {
    const prisma = makePrisma(state) as never;
    await expect(
      deactivateParseRule(prisma, { tenantId: "t-other", userId: "u1", ruleId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// Note: testRuleAgainstSample tests deferred — the function uses dynamic
// import of parse-rule-executor + Prisma reads for sample lookup, which
// requires more mock surface than the existing FakePrismaState provides.
// Integration coverage via the in-UI sample test panel + a follow-up
// extension of FakePrismaState (KAN-1165) for unit isolation.
