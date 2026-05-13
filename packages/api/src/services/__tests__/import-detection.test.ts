/**
 * KAN-904 — Ingestion Cohort 2.2 AI entity detection — backend tests.
 *
 * Coverage (per the close-out spec):
 *   1. Happy path                            → all 10 fields populated
 *   2. Low confidence (<50) coerce           → entityType='unknown', confidence unchanged
 *   3. LLM client throws                     → detectionError set, completedAt null, rethrow
 *   4. Unparseable LLM output                → detectionError = "LLM returned unparseable..."
 *   5. Invalid entity_type value             → detectionError set, rethrow
 *   6. Multi-tenant boundary                 → NOT_FOUND
 *   7. Wrong status (not 'inspected')        → BAD_REQUEST
 *   8. Re-run on already-detected job        → clears + writes fresh
 *
 * Pattern: vi.mock the llm-client.complete export + hand-rolled prisma
 * mocks (matches sibling pipeline-router.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ImportJob, PrismaClient } from "@prisma/client";

const llmCompleteMock = vi.fn();
vi.mock("../llm-client.js", () => ({
  complete: (...args: unknown[]) => llmCompleteMock(...args),
}));

import {
  buildDetectionUserPrompt,
  parseAndValidateDetectionResponse,
  runEntityDetection,
} from "../import-detection.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const JOB_ID = "job_kan904_001";

interface JobOverrides {
  status?: ImportJob["status"];
  tenantId?: string;
  detectedHeaders?: unknown;
  sampleRows?: unknown;
  detectedEntityType?: ImportJob["detectedEntityType"];
}

function makeJob(overrides: JobOverrides = {}): ImportJob {
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
    detectedEntityType: overrides.detectedEntityType ?? null,
    detectionConfidence: null,
    detectionReasoning: null,
    detectionStartedAt: null,
    detectionCompletedAt: null,
    detectionError: null,
    detectionErrorAt: null,
    detectionInputTokens: null,
    detectionOutputTokens: null,
    detectionLlmModel: null,
    errorMessage: null,
    errorAt: null,
    createdAt: new Date("2026-05-13T12:00:00Z"),
    updatedAt: new Date("2026-05-13T12:00:00Z"),
    uploadConfirmedAt: new Date("2026-05-13T12:00:30Z"),
    inspectionStartedAt: new Date("2026-05-13T12:00:31Z"),
    inspectionCompletedAt: new Date("2026-05-13T12:00:33Z"),
  } as ImportJob;
}

function makePrismaMock(job: ImportJob | null) {
  const findFirst = vi.fn().mockResolvedValue(job);
  // update returns its `data` merged onto the current job — good enough
  // for our assertions, since we read back the returned row.
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

describe("KAN-904 — runEntityDetection", () => {
  it("(1) happy path — all 10 fields populated; status unchanged", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: '{"entity_type":"contacts","confidence":87,"reasoning":"Headers email/first_name/last_name/phone match a contact list shape with no business-level fields like domain or industry."}',
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 260,
      outputTokens: 90,
      latencyMs: 1200,
      fallbackUsed: false,
    });

    const result = await runEntityDetection(prisma, JOB_ID, TENANT_A);

    expect(result.detectedEntityType).toBe("contacts");
    expect(result.detectionConfidence).toBe(87);
    expect(result.detectionReasoning).toMatch(/Headers email/);
    expect(result.detectionInputTokens).toBe(260);
    expect(result.detectionOutputTokens).toBe(90);
    expect(result.detectionLlmModel).toBe("claude-haiku-4-5-20251001");
    // status unchanged — detection is additive, not a state transition
    expect(result.status).toBe("inspected");

    // Two updates: (a) reset/start, (b) write success.
    expect(update).toHaveBeenCalledTimes(2);
    const successWrite = update.mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(successWrite.data.detectedEntityType).toBe("contacts");
    expect(successWrite.data.detectionCompletedAt).toBeInstanceOf(Date);
    expect(successWrite.data.detectionError).toBeUndefined();
  });

  it("(2) low confidence (<50) coerces entityType to 'unknown'; confidence value unchanged", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: '{"entity_type":"contacts","confidence":30,"reasoning":"Could be contacts but headers are ambiguous."}',
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 200,
      outputTokens: 50,
      latencyMs: 900,
      fallbackUsed: false,
    });

    const result = await runEntityDetection(prisma, JOB_ID, TENANT_A);

    expect(result.detectedEntityType).toBe("unknown");
    expect(result.detectionConfidence).toBe(30); // NOT mutated
    // LLM's original preferred type preserved in reasoning text.
    expect(result.detectionReasoning).toMatch(/preferred classification was 'contacts'/);
    expect(result.detectionReasoning).toMatch(/Coerced to 'unknown'/);

    const successWrite = update.mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(successWrite.data.detectedEntityType).toBe("unknown");
    expect(successWrite.data.detectionConfidence).toBe(30);
  });

  it("(3) LLM client throws — detectionError set, completedAt null, rethrows", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockRejectedValue(new Error("Anthropic 503"));

    await expect(runEntityDetection(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /Anthropic 503/,
    );

    // Two updates: (a) reset/start, (b) failure record.
    expect(update).toHaveBeenCalledTimes(2);
    const failureWrite = update.mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(failureWrite.data.detectionError).toMatch(/Anthropic 503/);
    expect(failureWrite.data.detectionErrorAt).toBeInstanceOf(Date);
    // completedAt should NOT appear in the failure write.
    expect(failureWrite.data.detectionCompletedAt).toBeUndefined();
  });

  it("(4) unparseable LLM output — detectionError = 'LLM returned unparseable output: ...', rethrows", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: "I think this is contacts probably",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 200,
      outputTokens: 10,
      latencyMs: 800,
      fallbackUsed: false,
    });

    await expect(runEntityDetection(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /LLM returned unparseable output/,
    );

    const failureWrite = update.mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(failureWrite.data.detectionError).toMatch(
      /LLM returned unparseable output: I think this is contacts probably/,
    );
  });

  it("(5) invalid entity_type value — detectionError set, rethrows", async () => {
    const job = makeJob();
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: '{"entity_type":"garbage","confidence":50,"reasoning":"x"}',
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 200,
      outputTokens: 20,
      latencyMs: 800,
      fallbackUsed: false,
    });

    await expect(runEntityDetection(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /invalid detection shape.*entity_type/,
    );

    const failureWrite = update.mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(failureWrite.data.detectionError).toMatch(/invalid detection shape/);
  });

  it("(6) multi-tenant boundary — tenant B cannot run detection on tenant A's job (NOT_FOUND)", async () => {
    const { prisma } = makePrismaMock(null); // findFirst({ tenantId: TENANT_B }) → null

    await expect(runEntityDetection(prisma, JOB_ID, TENANT_B)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // LLM should NEVER be called for cross-tenant access.
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it("(7) wrong status (awaiting_upload) — BAD_REQUEST", async () => {
    const job = makeJob({ status: "awaiting_upload" });
    const { prisma } = makePrismaMock(job);

    await expect(runEntityDetection(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it("(8) re-run on already-detected job — clears previous fields, writes fresh ones", async () => {
    const job = makeJob({ detectedEntityType: "companies" }); // a prior detection exists
    const { prisma, update } = makePrismaMock(job);

    llmCompleteMock.mockResolvedValue({
      text: '{"entity_type":"contacts","confidence":75,"reasoning":"on second look, headers match contacts not companies."}',
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 240,
      outputTokens: 70,
      latencyMs: 1100,
      fallbackUsed: false,
    });

    const result = await runEntityDetection(prisma, JOB_ID, TENANT_A);
    expect(result.detectedEntityType).toBe("contacts");

    // First update should explicitly clear all prior detection fields.
    const resetWrite = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(resetWrite.data.detectedEntityType).toBeNull();
    expect(resetWrite.data.detectionCompletedAt).toBeNull();
    expect(resetWrite.data.detectionError).toBeNull();
    expect(resetWrite.data.detectionStartedAt).toBeInstanceOf(Date);
  });
});

describe("KAN-904 — buildDetectionUserPrompt", () => {
  it("renders headers as numbered list + sampleRows as JSON array", () => {
    const job = makeJob({
      detectedHeaders: ["email", "first_name"],
      sampleRows: [
        { email: "a@b.com", first_name: "Alice" },
        { email: "c@d.com", first_name: "Bob" },
      ],
    });
    const prompt = buildDetectionUserPrompt(job);

    expect(prompt).toMatch(/Filename: contacts\.csv/);
    expect(prompt).toMatch(/1\. email/);
    expect(prompt).toMatch(/2\. first_name/);
    expect(prompt).toMatch(/Alice/);
    expect(prompt).toMatch(/JSON only, no markdown/);
    // Contains all 6 entity-type label hints.
    for (const t of ["contacts:", "companies:", "deals:", "orders:", "mixed:", "unknown:"]) {
      expect(prompt).toContain(t);
    }
  });

  it("tolerates null detectedHeaders / sampleRows", () => {
    const job = makeJob({ detectedHeaders: null, sampleRows: null });
    const prompt = buildDetectionUserPrompt(job);
    expect(prompt).toMatch(/Filename: contacts\.csv/);
    expect(prompt).toMatch(/Headers \(in order\):/);
    expect(prompt).toMatch(/Sample rows \(first 5\):/);
  });
});

describe("KAN-904 — parseAndValidateDetectionResponse", () => {
  it("extracts JSON from response wrapped in whitespace", () => {
    const raw =
      '\n\n  {"entity_type":"deals","confidence":92,"reasoning":"Pipeline-shape headers."}\n';
    const parsed = parseAndValidateDetectionResponse(raw);
    expect(parsed.entityType).toBe("deals");
    expect(parsed.confidence).toBe(92);
    expect(parsed.reasoning).toBe("Pipeline-shape headers.");
  });

  it("rounds non-integer confidence values", () => {
    const raw = '{"entity_type":"orders","confidence":87.6,"reasoning":"x"}';
    const parsed = parseAndValidateDetectionResponse(raw);
    expect(parsed.confidence).toBe(88);
  });

  it("rejects out-of-range confidence", () => {
    expect(() =>
      parseAndValidateDetectionResponse(
        '{"entity_type":"contacts","confidence":150,"reasoning":"x"}',
      ),
    ).toThrow(/confidence must be a number 0-100/);
  });

  it("rejects empty reasoning", () => {
    expect(() =>
      parseAndValidateDetectionResponse(
        '{"entity_type":"contacts","confidence":80,"reasoning":""}',
      ),
    ).toThrow(/reasoning must be a non-empty string/);
  });

  it("rejects non-JSON text outright", () => {
    expect(() => parseAndValidateDetectionResponse("plain English")).toThrow(
      /LLM returned unparseable output/,
    );
  });
});
