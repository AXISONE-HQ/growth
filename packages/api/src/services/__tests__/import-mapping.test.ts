/**
 * KAN-905 — Ingestion Cohort 2.4 AI field mapping — backend tests.
 *
 * Coverage:
 *   runFieldMapping (mocked complete()):
 *     1.  Happy path — contacts entity, valid mapping array
 *     2.  Mixed entity → BAD_REQUEST
 *     3.  Unknown entity → BAD_REQUEST
 *     4.  Null entity → BAD_REQUEST
 *     5.  Wrong status (awaiting_upload) → BAD_REQUEST
 *     6.  Multi-tenant boundary → NOT_FOUND
 *     7.  LLM throws → fieldMappingError set + rethrown
 *     8.  Unparseable LLM output → recorded + rethrown
 *     9.  Source column not in headers → validation rejection
 *     10. Target field not in universe → validation rejection
 *     11. Re-run idempotency — clears AI fields but preserves confirmedAt
 *
 *   saveFieldMappings (no LLM):
 *     12. Happy path — valid mappings persist + set confirmedAt
 *     13. Collision (two non-skip columns → same target) → BAD_REQUEST
 *     14. Unknown source column → BAD_REQUEST
 *     15. Unknown target field → BAD_REQUEST
 *
 *   parseAndValidateMappingResponse (pure):
 *     16. Gap-fills omitted source columns with 'skip'
 *     17. Rejects duplicate source_column entries
 *     18. Rejects unparseable text
 *     19. 'skip' rows tolerate null confidence
 *
 *   buildMappingUserPrompt (pure):
 *     20. Includes entity type + headers + sample rows + lookup tag
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ImportJob, PrismaClient } from "@prisma/client";

const llmCompleteMock = vi.fn();
vi.mock("../llm-client.js", () => ({
  complete: (...args: unknown[]) => llmCompleteMock(...args),
}));

import {
  CONTACT_FIELDS,
  DEAL_FIELDS,
  buildMappingUserPrompt,
  parseAndValidateMappingResponse,
  runFieldMapping,
  saveFieldMappings,
  type FieldMappingEntry,
} from "../import-mapping.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const JOB_ID = "job_kan905_001";

interface JobOverrides {
  status?: ImportJob["status"];
  tenantId?: string;
  detectedEntityType?: ImportJob["detectedEntityType"];
  detectedHeaders?: unknown;
  sampleRows?: unknown;
  fieldMappingConfirmedAt?: Date | null;
}

function makeJob(overrides: JobOverrides = {}): ImportJob {
  // `??` swallows explicit null, so use `in` for fields where null is a
  // valid test fixture value (entity type can legitimately be null on a
  // job that hasn't run detection yet).
  const detectedEntityType: ImportJob["detectedEntityType"] =
    "detectedEntityType" in overrides
      ? (overrides.detectedEntityType as ImportJob["detectedEntityType"])
      : "contacts";

  return {
    id: JOB_ID,
    tenantId: overrides.tenantId ?? TENANT_A,
    createdByUserId: "user-1",
    fileName: "contacts.csv",
    fileSize: 1024,
    fileMimeType: "text/csv",
    gcsObjectPath: `tenants/${overrides.tenantId ?? TENANT_A}/imports/${JOB_ID}/contacts.csv`,
    mode: "update_add",
    status: overrides.status ?? "inspected",
    detectedFileType: "csv",
    detectedRowCount: 10,
    detectedColumnCount: 4,
    detectedHeaders:
      overrides.detectedHeaders ??
      (["email", "first_name", "last_name", "phone"] as unknown),
    sampleRows:
      overrides.sampleRows ??
      ([
        { email: "a@test.com", first_name: "Alice", last_name: "A", phone: "1" },
      ] as unknown),
    detectedEntityType,
    detectionConfidence: 99,
    detectionReasoning: "All contact-shaped headers.",
    detectionStartedAt: new Date(),
    detectionCompletedAt: new Date(),
    detectionError: null,
    detectionErrorAt: null,
    detectionInputTokens: 260,
    detectionOutputTokens: 90,
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
    fieldMappingConfirmedAt: overrides.fieldMappingConfirmedAt ?? null,
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
  const prisma = {
    importJob: { findFirst, update },
  } as unknown as PrismaClient;
  return { prisma, findFirst, update };
}

beforeEach(() => {
  llmCompleteMock.mockReset();
});

describe("KAN-905 — runFieldMapping", () => {
  it("(1) happy path — contacts entity, all 10 AI fields populated", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: JSON.stringify([
        { source_column: "email", target_field: "email", confidence: 99, reasoning: "exact match" },
        { source_column: "first_name", target_field: "firstName", confidence: 95, reasoning: "snake_case → camelCase" },
        { source_column: "last_name", target_field: "lastName", confidence: 95, reasoning: "snake_case → camelCase" },
        { source_column: "phone", target_field: "phone", confidence: 92, reasoning: "exact match" },
      ]),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1200,
      outputTokens: 450,
      latencyMs: 2200,
      fallbackUsed: false,
    });

    const result = await runFieldMapping(prisma, JOB_ID, TENANT_A);

    expect(Array.isArray(result.fieldMappings)).toBe(true);
    expect((result.fieldMappings as unknown[]).length).toBe(4);
    expect(result.fieldMappingConfidence).toBe(95); // avg(99, 95, 95, 92) = 95.25 → 95
    expect(result.fieldMappingInputTokens).toBe(1200);
    expect(result.fieldMappingOutputTokens).toBe(450);
    expect(result.fieldMappingLlmModel).toBe("claude-haiku-4-5-20251001");

    // 2 updates: reset + success-write.
    expect(update).toHaveBeenCalledTimes(2);
    const successWrite = update.mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(successWrite.data.fieldMappingCompletedAt).toBeInstanceOf(Date);
    expect(successWrite.data.fieldMappingError).toBeUndefined();
  });

  it("(2) entity='mixed' → BAD_REQUEST + LLM never called", async () => {
    const job = makeJob({ detectedEntityType: "mixed" });
    const { prisma } = makePrismaMock(job);

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it("(3) entity='unknown' → BAD_REQUEST", async () => {
    const job = makeJob({ detectedEntityType: "unknown" });
    const { prisma } = makePrismaMock(job);

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it("(4) entity=null → BAD_REQUEST (must run detection first)", async () => {
    const job = makeJob({ detectedEntityType: null });
    const { prisma } = makePrismaMock(job);

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it("(5) status != inspected → BAD_REQUEST", async () => {
    const job = makeJob({ status: "awaiting_upload" });
    const { prisma } = makePrismaMock(job);

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("(6) multi-tenant boundary → NOT_FOUND", async () => {
    const { prisma } = makePrismaMock(null);

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_B)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it("(7) LLM client throws — fieldMappingError set + rethrown", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockRejectedValue(new Error("Anthropic 503"));

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_A)).rejects.toThrow(/Anthropic 503/);

    expect(update).toHaveBeenCalledTimes(2);
    const failureWrite = update.mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(failureWrite.data.fieldMappingError).toMatch(/Anthropic 503/);
    expect(failureWrite.data.fieldMappingErrorAt).toBeInstanceOf(Date);
    expect(failureWrite.data.fieldMappingCompletedAt).toBeUndefined();
  });

  it("(8) unparseable LLM output — fieldMappingError records first 200 chars", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: "I think email maps to email and phone maps to phone, obviously",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 800,
      outputTokens: 30,
      latencyMs: 1200,
      fallbackUsed: false,
    });

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /LLM returned unparseable output/,
    );
    const failureWrite = update.mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(failureWrite.data.fieldMappingError).toMatch(/unparseable output/);
  });

  it("(9) source_column not in headers — validation rejection", async () => {
    const job = makeJob();
    const { prisma } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: JSON.stringify([
        { source_column: "i_do_not_exist", target_field: "email", confidence: 50, reasoning: "x" },
      ]),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 800,
      outputTokens: 30,
      latencyMs: 1200,
      fallbackUsed: false,
    });

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /not in detectedHeaders/,
    );
  });

  it("(10) target_field not in universe — validation rejection", async () => {
    const job = makeJob();
    const { prisma } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: JSON.stringify([
        { source_column: "email", target_field: "garbage_field", confidence: 50, reasoning: "x" },
      ]),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 800,
      outputTokens: 30,
      latencyMs: 1200,
      fallbackUsed: false,
    });

    await expect(runFieldMapping(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /not in the entity's field universe/,
    );
  });

  it("(11) re-run preserves fieldMappingConfirmedAt; clears AI fields", async () => {
    const priorConfirm = new Date("2026-05-12T00:00:00Z");
    const job = makeJob({ fieldMappingConfirmedAt: priorConfirm });
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: JSON.stringify([
        { source_column: "email", target_field: "email", confidence: 99, reasoning: "x" },
        { source_column: "first_name", target_field: "firstName", confidence: 95, reasoning: "x" },
        { source_column: "last_name", target_field: "lastName", confidence: 95, reasoning: "x" },
        { source_column: "phone", target_field: "phone", confidence: 92, reasoning: "x" },
      ]),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1000,
      outputTokens: 300,
      latencyMs: 2000,
      fallbackUsed: false,
    });

    await runFieldMapping(prisma, JOB_ID, TENANT_A);

    // First update (reset) should NOT touch fieldMappingConfirmedAt.
    const resetWrite = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect("fieldMappingConfirmedAt" in resetWrite.data).toBe(false);
    expect(resetWrite.data.fieldMappingCompletedAt).toBeNull();
    expect(resetWrite.data.fieldMappingError).toBeNull();
    expect(resetWrite.data.fieldMappings).toBeNull();
  });
});

describe("KAN-905 — saveFieldMappings", () => {
  const validMappings: FieldMappingEntry[] = [
    { sourceColumn: "email", targetField: "email", confidence: 99 },
    { sourceColumn: "first_name", targetField: "firstName", confidence: 95 },
    { sourceColumn: "last_name", targetField: "lastName", confidence: 95 },
    { sourceColumn: "phone", targetField: "phone", confidence: 92 },
  ];

  it("(12) happy path — persists + sets fieldMappingConfirmedAt", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    const result = await saveFieldMappings(prisma, JOB_ID, TENANT_A, validMappings);

    expect(update).toHaveBeenCalledOnce();
    const write = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(write.data.fieldMappingConfirmedAt).toBeInstanceOf(Date);
    expect(write.data.fieldMappings).toEqual(validMappings);
    expect(result.fieldMappingConfirmedAt).toBeInstanceOf(Date);
  });

  it("(13) collision — two non-skip columns → same target → BAD_REQUEST", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    const colliding: FieldMappingEntry[] = [
      { sourceColumn: "email", targetField: "email", confidence: 99 },
      // 'first_name' wrongly maps to email — collision.
      { sourceColumn: "first_name", targetField: "email", confidence: 50 },
      { sourceColumn: "last_name", targetField: "lastName", confidence: 95 },
      { sourceColumn: "phone", targetField: "phone", confidence: 92 },
    ];

    await expect(
      saveFieldMappings(prisma, JOB_ID, TENANT_A, colliding),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(update).not.toHaveBeenCalled();
  });

  it("(14) unknown source column → BAD_REQUEST", async () => {
    const job = makeJob();
    const { prisma } = makePrismaMock(job);

    await expect(
      saveFieldMappings(prisma, JOB_ID, TENANT_A, [
        { sourceColumn: "phantom", targetField: "email", confidence: 99 },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("(15) unknown target field → BAD_REQUEST", async () => {
    const job = makeJob();
    const { prisma } = makePrismaMock(job);

    await expect(
      saveFieldMappings(prisma, JOB_ID, TENANT_A, [
        { sourceColumn: "email", targetField: "wat_is_this", confidence: 99 },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("KAN-905 — parseAndValidateMappingResponse", () => {
  const HEADERS = ["email", "first_name", "last_name", "phone"];

  it("(16) gap-fills omitted source columns with 'skip'", () => {
    const raw = JSON.stringify([
      { source_column: "email", target_field: "email", confidence: 99, reasoning: "x" },
      { source_column: "phone", target_field: "phone", confidence: 92, reasoning: "x" },
    ]);
    const result = parseAndValidateMappingResponse(raw, HEADERS, CONTACT_FIELDS);
    expect(result).toHaveLength(4);
    const firstNameEntry = result.find((m) => m.sourceColumn === "first_name");
    expect(firstNameEntry?.targetField).toBe("skip");
    expect(firstNameEntry?.confidence).toBeNull();
  });

  it("(17) rejects duplicate source_column entries", () => {
    const raw = JSON.stringify([
      { source_column: "email", target_field: "email", confidence: 99, reasoning: "x" },
      { source_column: "email", target_field: "lastName", confidence: 50, reasoning: "x" },
      { source_column: "first_name", target_field: "firstName", confidence: 95, reasoning: "x" },
      { source_column: "last_name", target_field: "lastName", confidence: 95, reasoning: "x" },
      { source_column: "phone", target_field: "phone", confidence: 92, reasoning: "x" },
    ]);
    expect(() => parseAndValidateMappingResponse(raw, HEADERS, CONTACT_FIELDS)).toThrow(
      /appears more than once/,
    );
  });

  it("(18) rejects unparseable text", () => {
    expect(() =>
      parseAndValidateMappingResponse("plain English explanation", HEADERS, CONTACT_FIELDS),
    ).toThrow(/unparseable output/);
  });

  it("(19) 'skip' rows tolerate null/missing confidence", () => {
    const raw = JSON.stringify([
      { source_column: "email", target_field: "email", confidence: 99, reasoning: "x" },
      { source_column: "first_name", target_field: "skip", confidence: null, reasoning: "x" },
      { source_column: "last_name", target_field: "skip", confidence: 0, reasoning: "x" },
      { source_column: "phone", target_field: "phone", confidence: 92, reasoning: "x" },
    ]);
    const result = parseAndValidateMappingResponse(raw, HEADERS, CONTACT_FIELDS);
    expect(result.find((m) => m.sourceColumn === "first_name")?.confidence).toBeNull();
    expect(result.find((m) => m.sourceColumn === "last_name")?.confidence).toBeNull();
  });

  // KAN-917 — Fred's PROD dogfood hit (HubSpot CSV, 2026-05-14). Haiku
  // returned the JSON wrapped in ```json...``` fences despite the
  // "JSON only" system prompt, and the prior regex-extract-then-parse
  // path choked.
  it("(20-KAN-917) parses ```json-fence-wrapped responses", () => {
    const json = JSON.stringify([
      { source_column: "email", target_field: "email", confidence: 99, reasoning: "x" },
      { source_column: "first_name", target_field: "firstName", confidence: 95, reasoning: "x" },
      { source_column: "last_name", target_field: "lastName", confidence: 95, reasoning: "x" },
      { source_column: "phone", target_field: "phone", confidence: 92, reasoning: "x" },
    ]);
    const fenced = "```json\n" + json + "\n```";
    const result = parseAndValidateMappingResponse(fenced, HEADERS, CONTACT_FIELDS);
    expect(result).toHaveLength(4);
    expect(result.find((m) => m.sourceColumn === "email")?.targetField).toBe("email");
  });

  it("(21-KAN-917) parses leading-explanation + fence-wrapped responses (lenient mode)", () => {
    const json = JSON.stringify([
      { source_column: "email", target_field: "email", confidence: 99, reasoning: "x" },
      { source_column: "first_name", target_field: "firstName", confidence: 95, reasoning: "x" },
      { source_column: "last_name", target_field: "lastName", confidence: 95, reasoning: "x" },
      { source_column: "phone", target_field: "phone", confidence: 92, reasoning: "x" },
    ]);
    const messy = "Sure! Here is the mapping for your CSV:\n\n```json\n" + json + "\n```\n\nLet me know if you need adjustments.";
    const result = parseAndValidateMappingResponse(messy, HEADERS, CONTACT_FIELDS);
    expect(result).toHaveLength(4);
    expect(result.find((m) => m.sourceColumn === "phone")?.targetField).toBe("phone");
  });
});

describe("KAN-905 — buildMappingUserPrompt", () => {
  it("(20) includes entity type + headers + sample rows + lookup tag", () => {
    const job = makeJob({
      detectedEntityType: "deals",
      detectedHeaders: ["deal_name", "amount", "stage", "owner_email"],
      sampleRows: [
        { deal_name: "Acme Renewal", amount: 48000, stage: "negotiation", owner_email: "x@y.com" },
      ],
    });

    const prompt = buildMappingUserPrompt(job, "deals", DEAL_FIELDS);

    expect(prompt).toMatch(/Entity type: deals/);
    expect(prompt).toMatch(/1\. deal_name/);
    expect(prompt).toMatch(/Acme Renewal/);
    // The lookup-kind targets must be tagged in the universe render.
    expect(prompt).toMatch(/contactEmail \[lookup — resolved at commit\]/);
    expect(prompt).toMatch(/pipelineName \[lookup — resolved at commit\]/);
    // Skip sentinel is always offered.
    expect(prompt).toMatch(/skip:/);
    // Output shape directive.
    expect(prompt).toMatch(/JSON only, no markdown/);
  });
});
