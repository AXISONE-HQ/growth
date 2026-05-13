/**
 * KAN-907 — Ingestion Cohort 2.3 row-level classification — backend tests.
 *
 * Coverage (per the close-out spec):
 *
 *   heuristicClassifyRow (pure, no IO):
 *     1.  Rule (f) empty row → 'skipped' @ 100
 *     2.  Rule (f) fires FIRST — empty row with discriminator column still skipped
 *     3.  Rule (a) discriminator: 'contact' → 'contacts' @ 100
 *     4.  Rule (a) discriminator variants: 'Opportunity' → 'deals'
 *     5.  Rule (b) order signal: order_number → 'orders' @ 90
 *     6.  Rule (b) order signal: total + payment_method → 'orders' @ 90
 *     7.  Rule (c) deal signal: deal_name → 'deals' @ 85
 *     8.  Rule (d) company signal: domain + industry → 'companies' @ 85
 *     9.  Rule (d) company exclusion: name + domain + email → falls through to contacts
 *     10. Rule (e) contact signal: email + first_name → 'contacts' @ 80
 *     11. No rule fires → null
 *     12. Header normalization: 'Order #' matches order_number heuristic
 *     13. Header normalization: 'Email Address' matches email heuristic
 *
 *   parseAndValidateBatchResponse (pure):
 *     14. Happy path — array of valid entries
 *     15. Reject row_index outside expected batch
 *     16. Reject duplicate row_index
 *     17. Reject invalid entity_type
 *     18. Gap-fill missing rows with 'unknown' @ 0
 *
 *   runRowClassification (end-to-end, mocked complete + downloadObject):
 *     19. Single-entity (detectedEntityType=contacts) — heuristic-only, no LLM call
 *     20. Mixed file — heuristic + LLM batch combined → staging rows created
 *     21. Boundary confidence (heuristic <85) → review_recommended=true
 *     22. LLM low confidence (<70) → review_recommended=true
 *     23. LLM high confidence (>=70) → review_recommended=false
 *     24. Multi-tenant boundary → NOT_FOUND
 *     25. detectedEntityType=null → BAD_REQUEST + no LLM call
 *     26. detectedEntityType=unknown → BAD_REQUEST + no LLM call
 *     27. Mirror columns are NULL on staging rows (decision D)
 *
 *   confirmRowClassification:
 *     28. Happy path — sets confirmedAt
 *     29. Idempotent — re-confirm updates timestamp
 *     30. BAD_REQUEST when classification not yet completed
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ImportJob, PrismaClient } from "@prisma/client";

const llmCompleteMock = vi.fn();
vi.mock("../llm-client.js", () => ({
  complete: (...args: unknown[]) => llmCompleteMock(...args),
}));

const downloadObjectMock = vi.fn();
vi.mock("../import-storage.js", () => ({
  downloadObject: (...args: unknown[]) => downloadObjectMock(...args),
}));

import {
  confirmRowClassification,
  heuristicClassifyRow,
  parseAndValidateBatchResponse,
  runRowClassification,
} from "../import-row-classification.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const JOB_ID = "job_kan907_001";

function makeJob(
  overrides: {
    status?: ImportJob["status"];
    tenantId?: string;
    detectedEntityType?: ImportJob["detectedEntityType"];
    rowClassificationCompletedAt?: Date | null;
  } = {},
): ImportJob {
  const detectedEntityType: ImportJob["detectedEntityType"] =
    "detectedEntityType" in overrides
      ? (overrides.detectedEntityType as ImportJob["detectedEntityType"])
      : "mixed";

  return {
    id: JOB_ID,
    tenantId: overrides.tenantId ?? TENANT_A,
    createdByUserId: "user-1",
    fileName: "mixed.csv",
    fileSize: 1024,
    fileMimeType: "text/csv",
    gcsObjectPath: "tenants/T/imports/job/mixed.csv",
    mode: "update_add",
    status: overrides.status ?? "inspected",
    detectedFileType: "csv",
    detectedRowCount: 10,
    detectedColumnCount: 6,
    detectedHeaders: ["email", "first_name", "last_name"] as unknown,
    sampleRows: [] as unknown,
    detectedEntityType,
    detectionConfidence: 95,
    detectionReasoning: "mixed file",
    detectionStartedAt: new Date(),
    detectionCompletedAt: new Date(),
    detectionError: null,
    detectionErrorAt: null,
    detectionInputTokens: 200,
    detectionOutputTokens: 50,
    detectionLlmModel: "claude-haiku-4-5-20251001",
    fieldMappings: null,
    fieldMappingConfidence: null,
    fieldMappingReasoning: null,
    fieldMappingStartedAt: null,
    fieldMappingCompletedAt: null,
    fieldMappingError: null,
    fieldMappingErrorAt: null,
    fieldMappingInputTokens: null,
    fieldMappingOutputTokens: null,
    fieldMappingLlmModel: null,
    fieldMappingConfirmedAt: null,
    rowClassificationCounts: null,
    rowClassificationStartedAt: null,
    rowClassificationCompletedAt: overrides.rowClassificationCompletedAt ?? null,
    rowClassificationError: null,
    rowClassificationErrorAt: null,
    rowClassificationInputTokens: null,
    rowClassificationOutputTokens: null,
    rowClassificationLlmModel: null,
    rowClassificationConfirmedAt: null,
    errorMessage: null,
    errorAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    uploadConfirmedAt: new Date(),
    inspectionStartedAt: new Date(),
    inspectionCompletedAt: new Date(),
  } as ImportJob;
}

function makePrismaMock(job: ImportJob | null) {
  const findFirst = vi.fn().mockResolvedValue(job);
  const update = vi.fn().mockImplementation(async (args: { data: Partial<ImportJob> }) => {
    if (!job) throw new Error("update called when findFirst returned null");
    return { ...job, ...args.data };
  });

  // createMany / deleteMany stubs for all 4 staging tables.
  const stagingContactCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const stagingCompanyCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const stagingDealCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const stagingOrderCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const stagingContactDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const stagingCompanyDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const stagingDealDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const stagingOrderDeleteMany = vi.fn().mockResolvedValue({ count: 0 });

  // $transaction passes through the array of promise-like items.
  const transaction = vi
    .fn()
    .mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));

  const prisma = {
    importJob: { findFirst, update },
    importStagingContact: { createMany: stagingContactCreateMany, deleteMany: stagingContactDeleteMany },
    importStagingCompany: { createMany: stagingCompanyCreateMany, deleteMany: stagingCompanyDeleteMany },
    importStagingDeal: { createMany: stagingDealCreateMany, deleteMany: stagingDealDeleteMany },
    importStagingOrder: { createMany: stagingOrderCreateMany, deleteMany: stagingOrderDeleteMany },
    $transaction: transaction,
  } as unknown as PrismaClient;

  return {
    prisma,
    findFirst,
    update,
    stagingContactCreateMany,
    stagingCompanyCreateMany,
    stagingDealCreateMany,
    stagingOrderCreateMany,
    transaction,
  };
}

beforeEach(() => {
  llmCompleteMock.mockReset();
  downloadObjectMock.mockReset();
});

// ─────────────────────────────────────────────
// heuristicClassifyRow
// ─────────────────────────────────────────────

describe("KAN-907 — heuristicClassifyRow", () => {
  it("(1) rule (f) — empty row → 'skipped' @ 100", () => {
    const r = heuristicClassifyRow({ email: "", first_name: "", last_name: "" });
    expect(r).toMatchObject({ entityType: "skipped", confidence: 100 });
  });

  it("(2) rule (f) fires FIRST — empty row with discriminator column still skipped", () => {
    // 1 non-empty column (record_type) out of 6 = 83% empty > 80% threshold.
    const r = heuristicClassifyRow({
      record_type: "contact",
      email: "",
      first_name: "",
      last_name: "",
      phone: "",
      company: "",
    });
    // Empty wins — empty row classification beats discriminator.
    expect(r).toMatchObject({ entityType: "skipped", confidence: 100 });
  });

  it("(3) rule (a) — discriminator 'contact' → 'contacts' @ 100", () => {
    const r = heuristicClassifyRow({
      record_type: "contact",
      email: "a@b.com",
      first_name: "Alice",
      last_name: "Smith",
    });
    expect(r).toMatchObject({ entityType: "contacts", confidence: 100 });
  });

  it("(4) rule (a) — discriminator variant 'Opportunity' → 'deals' @ 100", () => {
    const r = heuristicClassifyRow({
      type: "Opportunity",
      deal_name: "Big deal",
      amount: "50000",
    });
    expect(r).toMatchObject({ entityType: "deals", confidence: 100 });
  });

  it("(5) rule (b) — order_number → 'orders' @ 90", () => {
    const r = heuristicClassifyRow({
      order_number: "INV-001",
      total: "100",
    });
    expect(r).toMatchObject({ entityType: "orders", confidence: 90 });
  });

  it("(6) rule (b) — (total + payment_method) → 'orders' @ 90", () => {
    const r = heuristicClassifyRow({
      total: "150",
      payment_method: "card",
    });
    expect(r).toMatchObject({ entityType: "orders", confidence: 90 });
  });

  it("(7) rule (c) — deal_name → 'deals' @ 85", () => {
    const r = heuristicClassifyRow({
      deal_name: "Acme renewal",
    });
    expect(r).toMatchObject({ entityType: "deals", confidence: 85 });
  });

  it("(8) rule (d) — (domain + industry) → 'companies' @ 85", () => {
    const r = heuristicClassifyRow({
      name: "Acme Co",
      domain: "acme.io",
      industry: "SaaS",
    });
    expect(r).toMatchObject({ entityType: "companies", confidence: 85 });
  });

  it("(9) rule (d) — name + domain + email falls through (email excluded → contacts)", () => {
    const r = heuristicClassifyRow({
      name: "Acme Co",
      domain: "acme.io",
      email: "ceo@acme.io",
      first_name: "Alice",
    });
    // Rule (d) wants `(name + domain + NO email)`, so it excludes here.
    // Falls through to rule (e) which matches.
    expect(r?.entityType).toBe("contacts");
  });

  it("(10) rule (e) — email + first_name → 'contacts' @ 80", () => {
    const r = heuristicClassifyRow({
      email: "a@b.com",
      first_name: "Alice",
    });
    expect(r).toMatchObject({ entityType: "contacts", confidence: 80 });
  });

  it("(11) no rule fires — returns null", () => {
    const r = heuristicClassifyRow({
      custom_field_1: "foo",
      custom_field_2: "bar",
      custom_field_3: "baz",
    });
    expect(r).toBeNull();
  });

  it("(12) header normalization — 'Order #' matches order_number heuristic", () => {
    const r = heuristicClassifyRow({
      "Order #": "INV-002",
      Total: "200",
    });
    expect(r?.entityType).toBe("orders");
  });

  it("(13) header normalization — 'Email Address' matches email heuristic", () => {
    const r = heuristicClassifyRow({
      "Email Address": "alice@acme.io",
      "First Name": "Alice",
    });
    expect(r?.entityType).toBe("contacts");
  });
});

// ─────────────────────────────────────────────
// parseAndValidateBatchResponse
// ─────────────────────────────────────────────

describe("KAN-907 — parseAndValidateBatchResponse", () => {
  const EXPECTED = new Set([0, 1, 2]);

  it("(14) happy path — valid entries parsed", () => {
    const raw = JSON.stringify([
      { row_index: 0, entity_type: "contacts", confidence: 95, reasoning: "x" },
      { row_index: 1, entity_type: "deals", confidence: 70, reasoning: "y" },
      { row_index: 2, entity_type: "orders", confidence: 80, reasoning: "z" },
    ]);
    const out = parseAndValidateBatchResponse(raw, EXPECTED);
    expect(out).toHaveLength(3);
    expect(out.find((e) => e.rowIndex === 1)?.entityType).toBe("deals");
  });

  it("(15) row_index outside batch → throws", () => {
    const raw = JSON.stringify([
      { row_index: 999, entity_type: "contacts", confidence: 95, reasoning: "x" },
    ]);
    expect(() => parseAndValidateBatchResponse(raw, EXPECTED)).toThrow(
      /not in this batch/,
    );
  });

  it("(16) duplicate row_index → throws", () => {
    const raw = JSON.stringify([
      { row_index: 0, entity_type: "contacts", confidence: 95, reasoning: "x" },
      { row_index: 0, entity_type: "deals", confidence: 90, reasoning: "y" },
    ]);
    expect(() => parseAndValidateBatchResponse(raw, EXPECTED)).toThrow(
      /returned twice/,
    );
  });

  it("(17) invalid entity_type → throws", () => {
    const raw = JSON.stringify([
      { row_index: 0, entity_type: "garbage", confidence: 95, reasoning: "x" },
    ]);
    expect(() => parseAndValidateBatchResponse(raw, EXPECTED)).toThrow(
      /entity_type 'garbage' is not valid/,
    );
  });

  it("(18) gap-fill missing rows with 'unknown' @ 0", () => {
    const raw = JSON.stringify([
      { row_index: 0, entity_type: "contacts", confidence: 95, reasoning: "x" },
      // row_index 1 + 2 omitted intentionally
    ]);
    const out = parseAndValidateBatchResponse(raw, EXPECTED);
    expect(out).toHaveLength(3);
    const r1 = out.find((e) => e.rowIndex === 1);
    const r2 = out.find((e) => e.rowIndex === 2);
    expect(r1?.entityType).toBe("unknown");
    expect(r1?.confidence).toBe(0);
    expect(r2?.entityType).toBe("unknown");
  });
});

// ─────────────────────────────────────────────
// runRowClassification (end-to-end)
// ─────────────────────────────────────────────

describe("KAN-907 — runRowClassification end-to-end", () => {
  it("(19) single-entity (contacts) — heuristic-only, no LLM call", async () => {
    const job = makeJob({ detectedEntityType: "contacts" });
    const { prisma, stagingContactCreateMany } = makePrismaMock(job);

    // papaparse skipEmptyLines:'greedy' drops the all-empty row at parse
    // time. To exercise rule (f) we need a row that's >80% empty but
    // has ≥1 non-empty cell so papaparse keeps it. 6 columns with 1
    // stray value = 83% empty > 80% threshold.
    const csv = `email,first_name,last_name,phone,extra_a,extra_b
alice@a.com,Alice,Apple,5551111,,
bob@b.com,Bob,Banana,5552222,,
,,,,one-stray-value,
charlie@c.com,Charlie,Cherry,5553333,,
`;
    downloadObjectMock.mockResolvedValue(Buffer.from(csv, "utf-8"));

    const result = await runRowClassification(prisma, JOB_ID, TENANT_A);

    expect(llmCompleteMock).not.toHaveBeenCalled();
    expect(stagingContactCreateMany).toHaveBeenCalledOnce();
    const insertArg = stagingContactCreateMany.mock.calls[0]![0] as {
      data: unknown[];
    };
    expect(insertArg.data).toHaveLength(3); // 3 non-empty rows staged

    const counts = result.rowClassificationCounts as {
      total: number;
      byEntity: { contacts: number; skipped: number };
      bySource: { heuristic: number; llm: number };
    };
    expect(counts.total).toBe(4); // 4 rows in (1 mostly-empty)
    expect(counts.byEntity.contacts).toBe(3);
    expect(counts.byEntity.skipped).toBe(1);
    expect(counts.bySource.heuristic).toBe(4);
    expect(counts.bySource.llm).toBe(0);
  });

  it("(20) mixed file — heuristic-classified rows skip LLM; null-rule rows batch", async () => {
    const job = makeJob({ detectedEntityType: "mixed" });
    const { prisma, stagingContactCreateMany, stagingOrderCreateMany } = makePrismaMock(job);

    // 3 rows:
    //   row 0 — contact (heuristic-matched)
    //   row 1 — order (heuristic-matched)
    //   row 2 — ambiguous (no rule → LLM)
    const csv = `email,first_name,order_number,total,extra_col
alice@a.com,Alice,,,
,,INV-001,150,
,,,,some-value
`;
    downloadObjectMock.mockResolvedValue(Buffer.from(csv, "utf-8"));
    llmCompleteMock.mockResolvedValue({
      text: JSON.stringify([
        { row_index: 2, entity_type: "unknown", confidence: 30, reasoning: "no signal" },
      ]),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 500,
      outputTokens: 50,
      latencyMs: 1200,
      fallbackUsed: false,
    });

    const result = await runRowClassification(prisma, JOB_ID, TENANT_A);

    expect(llmCompleteMock).toHaveBeenCalledOnce();
    expect(stagingContactCreateMany).toHaveBeenCalled();
    expect(stagingOrderCreateMany).toHaveBeenCalled();

    const counts = result.rowClassificationCounts as {
      total: number;
      byEntity: { contacts: number; orders: number; unknown: number };
      bySource: { heuristic: number; llm: number };
    };
    expect(counts.total).toBe(3);
    expect(counts.byEntity.contacts).toBe(1);
    expect(counts.byEntity.orders).toBe(1);
    expect(counts.byEntity.unknown).toBe(1);
    expect(counts.bySource.heuristic).toBe(2);
    expect(counts.bySource.llm).toBe(1);
  });

  it("(21) boundary heuristic confidence (<85) → review_recommended=true on staging row", async () => {
    const job = makeJob({ detectedEntityType: "mixed" });
    const { prisma, stagingContactCreateMany } = makePrismaMock(job);

    // Single contact row that matches rule (e) at 80% — below the 85 boundary.
    const csv = `email,first_name
alice@a.com,Alice
`;
    downloadObjectMock.mockResolvedValue(Buffer.from(csv, "utf-8"));

    const result = await runRowClassification(prisma, JOB_ID, TENANT_A);

    const insertArg = stagingContactCreateMany.mock.calls[0]![0] as {
      data: Array<{ sourceRowData: Record<string, unknown> }>;
    };
    const meta = insertArg.data[0]!.sourceRowData._classification as {
      review_recommended?: boolean;
      source: string;
      confidence: number;
    };
    expect(meta.source).toBe("heuristic");
    expect(meta.confidence).toBe(80);
    expect(meta.review_recommended).toBe(true);

    const counts = result.rowClassificationCounts as { lowConfidenceFlags: number };
    expect(counts.lowConfidenceFlags).toBe(1);
  });

  it("(22) LLM low confidence (<70) → review_recommended=true", async () => {
    const job = makeJob({ detectedEntityType: "mixed" });
    const { prisma, stagingContactCreateMany } = makePrismaMock(job);

    const csv = `mystery_col_a,mystery_col_b
foo,bar
`;
    downloadObjectMock.mockResolvedValue(Buffer.from(csv, "utf-8"));
    llmCompleteMock.mockResolvedValue({
      text: JSON.stringify([
        { row_index: 0, entity_type: "contacts", confidence: 50, reasoning: "weak signal" },
      ]),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 300,
      outputTokens: 40,
      latencyMs: 900,
      fallbackUsed: false,
    });

    await runRowClassification(prisma, JOB_ID, TENANT_A);

    const insertArg = stagingContactCreateMany.mock.calls[0]![0] as {
      data: Array<{ sourceRowData: Record<string, unknown> }>;
    };
    const meta = insertArg.data[0]!.sourceRowData._classification as {
      review_recommended?: boolean;
      source: string;
      confidence: number;
    };
    expect(meta.source).toBe("llm");
    expect(meta.confidence).toBe(50);
    expect(meta.review_recommended).toBe(true);
  });

  it("(23) LLM high confidence (>=70) → review_recommended absent/false", async () => {
    const job = makeJob({ detectedEntityType: "mixed" });
    const { prisma, stagingDealCreateMany } = makePrismaMock(job);

    // Row matches no heuristic rule (custom columns) → routes to LLM.
    const csv = `custom_signal_a,custom_signal_b
alpha,beta
`;
    downloadObjectMock.mockResolvedValue(Buffer.from(csv, "utf-8"));
    llmCompleteMock.mockResolvedValue({
      text: JSON.stringify([
        { row_index: 0, entity_type: "deals", confidence: 88, reasoning: "strong" },
      ]),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 300,
      outputTokens: 40,
      latencyMs: 900,
      fallbackUsed: false,
    });

    await runRowClassification(prisma, JOB_ID, TENANT_A);

    const insertArg = stagingDealCreateMany.mock.calls[0]![0] as {
      data: Array<{ sourceRowData: Record<string, unknown> }>;
    };
    const meta = insertArg.data[0]!.sourceRowData._classification as {
      review_recommended?: boolean;
    };
    expect(meta.review_recommended).toBeUndefined();
  });

  it("(24) multi-tenant boundary → NOT_FOUND + no LLM call", async () => {
    const { prisma } = makePrismaMock(null);
    await expect(runRowClassification(prisma, JOB_ID, TENANT_B)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(llmCompleteMock).not.toHaveBeenCalled();
    expect(downloadObjectMock).not.toHaveBeenCalled();
  });

  it("(25) detectedEntityType=null → BAD_REQUEST + no LLM call", async () => {
    const job = makeJob({ detectedEntityType: null });
    const { prisma } = makePrismaMock(job);
    await expect(runRowClassification(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it("(26) detectedEntityType=unknown → BAD_REQUEST + no LLM call", async () => {
    const job = makeJob({ detectedEntityType: "unknown" });
    const { prisma } = makePrismaMock(job);
    await expect(runRowClassification(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it("(27) staging rows have mirror columns NULL (decision D)", async () => {
    const job = makeJob({ detectedEntityType: "contacts" });
    const { prisma, stagingContactCreateMany } = makePrismaMock(job);

    const csv = `email,first_name,last_name,phone
alice@a.com,Alice,Apple,1234567
`;
    downloadObjectMock.mockResolvedValue(Buffer.from(csv, "utf-8"));

    await runRowClassification(prisma, JOB_ID, TENANT_A);

    const insertArg = stagingContactCreateMany.mock.calls[0]![0] as {
      data: Array<Record<string, unknown>>;
    };
    const row = insertArg.data[0]!;
    // Required columns present.
    expect(row.importJobId).toBe(JOB_ID);
    expect(row.tenantId).toBe(TENANT_A);
    expect(row.sourceRowIndex).toBe(0);
    expect(row.sourceRowData).toBeDefined();
    // Mirror columns must NOT be set — they stay null at the DB layer.
    // Decision D: PR 5 (mapping) is the canonical field-population step.
    expect(row.email).toBeUndefined();
    expect(row.firstName).toBeUndefined();
    expect(row.lastName).toBeUndefined();
    expect(row.phone).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// confirmRowClassification
// ─────────────────────────────────────────────

describe("KAN-907 — confirmRowClassification", () => {
  it("(28) happy path — sets rowClassificationConfirmedAt", async () => {
    const job = makeJob({ rowClassificationCompletedAt: new Date() });
    const { prisma, update } = makePrismaMock(job);

    const result = await confirmRowClassification(prisma, JOB_ID, TENANT_A);

    expect(update).toHaveBeenCalledOnce();
    const write = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(write.data.rowClassificationConfirmedAt).toBeInstanceOf(Date);
    expect(result.rowClassificationConfirmedAt).toBeInstanceOf(Date);
  });

  it("(29) idempotent — second call updates the timestamp", async () => {
    const job = makeJob({ rowClassificationCompletedAt: new Date() });
    const { prisma } = makePrismaMock(job);

    const r1 = await confirmRowClassification(prisma, JOB_ID, TENANT_A);
    const r2 = await confirmRowClassification(prisma, JOB_ID, TENANT_A);
    // Both succeed without throwing.
    expect(r1.rowClassificationConfirmedAt).toBeInstanceOf(Date);
    expect(r2.rowClassificationConfirmedAt).toBeInstanceOf(Date);
  });

  it("(30) BAD_REQUEST when classification not yet completed", async () => {
    const job = makeJob({ rowClassificationCompletedAt: null });
    const { prisma } = makePrismaMock(job);

    await expect(confirmRowClassification(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
