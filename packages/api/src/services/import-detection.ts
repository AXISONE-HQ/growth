/**
 * KAN-904 — Ingestion Cohort 2.2. AI-powered file-level entity detection.
 *
 * First AI-powered cohort in the ingestion pipeline. Takes an inspected
 * ImportJob (status='inspected', detectedHeaders + sampleRows populated)
 * and asks Haiku to classify the file as one of 6 entity types:
 * contacts / companies / deals / orders / mixed / unknown.
 *
 * LLM client: the canonical `llm-client.complete()` (NOT Vertex AI —
 * the codebase uses @anthropic-ai/sdk directly via tier-aware provider
 * selection, see packages/api/src/services/llm-client.ts). Tier 'cheap'
 * resolves to claude-haiku-4-5-* on Anthropic with gpt-4o-mini fallback.
 * Matches the pattern set by csv-import-haiku-mapping.ts (sibling
 * Haiku-via-llm-client service).
 *
 * Cost: complete() emits an `llm.call` Pub/Sub event with full token +
 * cost + tenant partition (KAN-734/745). The 3 denormalized snapshot
 * columns on ImportJob (detectionInputTokens / detectionOutputTokens /
 * detectionLlmModel) are for fast UI display only — they MUST come from
 * the same complete() response so they never diverge from the canonical
 * cost stream.
 *
 * Confidence coercion: if the LLM returns confidence < 50, we coerce
 * detectedEntityType to 'unknown' but PRESERVE the LLM's intended
 * classification verbatim in detectionReasoning so the operator can
 * sanity-check before re-running.
 *
 * Re-run: idempotent — calling on a job that already has detection
 * results clears the previous fields and writes fresh ones in a single
 * Prisma update (no race window).
 */
import { TRPCError } from "@trpc/server";
import type { ImportJob, PrismaClient } from "@prisma/client";
import { complete } from "./llm-client.js";

// ─────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────

const DETECTION_SYSTEM_PROMPT = `You are a CRM data classification specialist. You analyze file headers + sample rows to determine what type of business data is in a CSV or XLSX upload. You return strict JSON only. Do not include any text outside the JSON response.`;

/**
 * Build the user prompt for an ImportJob. Exported for test snapshotting
 * + the product-review gate (we want to be able to render the exact
 * prompt Haiku will see, against the fixture CSVs).
 */
export function buildDetectionUserPrompt(job: ImportJob): string {
  const headers = (job.detectedHeaders ?? []) as string[];
  const sample = (job.sampleRows ?? []) as Record<string, unknown>[];

  return `Analyze this file structure and classify what type of data it contains.

Filename: ${job.fileName}

Headers (in order):
${headers.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Sample rows (first 5):
${JSON.stringify(sample, null, 2)}

Classify as exactly one of:
- contacts: People/individuals (leads, customers, prospects, donors, members). Headers like email, phone, first_name, last_name, lifecycle_stage, lead_source.
- companies: Organizations/businesses (B2B clients, accounts). Headers like name, domain, website, industry, employee_count, annual_revenue, billing_address.
- deals: Sales opportunities (pipeline records). Headers like deal_name, amount, stage, close_date, owner, probability.
- orders: Completed transactions (purchases, charges, invoices). Headers like order_number, total, items, payment_method, placed_at, charge_id.
- mixed: Multiple entity types present in a single file (e.g., both contacts AND companies as separate columns/rows).
- unknown: Cannot confidently classify (data shape doesn't match any category, or too ambiguous).

Respond with JSON only, no markdown, no commentary:
{
  "entity_type": "contacts" | "companies" | "deals" | "orders" | "mixed" | "unknown",
  "confidence": <integer 0-100>,
  "reasoning": "<2-3 sentences explaining the classification>"
}`;
}

// ─────────────────────────────────────────────
// Parse + validate
// ─────────────────────────────────────────────

const VALID_ENTITY_TYPES = new Set([
  "contacts",
  "companies",
  "deals",
  "orders",
  "mixed",
  "unknown",
]);

interface ParsedDetection {
  entityType: string;
  confidence: number;
  reasoning: string;
}

class UnparseableLLMOutputError extends Error {
  constructor(rawText: string) {
    super(`LLM returned unparseable output: ${rawText.slice(0, 200)}`);
    this.name = "UnparseableLLMOutputError";
  }
}

class InvalidDetectionShapeError extends Error {
  constructor(reason: string) {
    super(`LLM returned invalid detection shape: ${reason}`);
    this.name = "InvalidDetectionShapeError";
  }
}

/**
 * Extract the JSON object from the LLM's response text (which may
 * contain surrounding whitespace despite the strict system prompt) and
 * validate its shape. Matches the regex-extract-then-JSON.parse pattern
 * used by csv-import-haiku-mapping.ts.
 */
export function parseAndValidateDetectionResponse(rawText: string): ParsedDetection {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new UnparseableLLMOutputError(rawText);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new UnparseableLLMOutputError(rawText);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidDetectionShapeError("response is not an object");
  }

  const obj = parsed as Record<string, unknown>;

  const entityType = obj.entity_type;
  const confidence = obj.confidence;
  const reasoning = obj.reasoning;

  if (typeof entityType !== "string" || !VALID_ENTITY_TYPES.has(entityType)) {
    throw new InvalidDetectionShapeError(
      `entity_type must be one of contacts|companies|deals|orders|mixed|unknown (got: ${String(entityType)})`,
    );
  }

  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 100
  ) {
    throw new InvalidDetectionShapeError(
      `confidence must be a number 0-100 (got: ${String(confidence)})`,
    );
  }

  if (typeof reasoning !== "string" || reasoning.trim() === "") {
    throw new InvalidDetectionShapeError("reasoning must be a non-empty string");
  }

  return {
    entityType,
    confidence: Math.round(confidence),
    reasoning: reasoning.trim(),
  };
}

// ─────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────

/**
 * Run AI entity detection on an inspected ImportJob.
 *
 * Throws:
 *  - TRPCError('NOT_FOUND') — job doesn't exist OR is cross-tenant
 *  - TRPCError('BAD_REQUEST') — job status is not 'inspected'
 *  - Original LLM/parse error — when detection fails after writing the
 *    failure record (detectionError + detectionErrorAt populated)
 *
 * On any failure during the LLM call or parse step, the job's
 * detectionError + detectionErrorAt are set + detectionCompletedAt
 * stays null. The original error is re-thrown so callers can surface
 * it (the tRPC layer translates to an HTTP 500).
 */
export async function runEntityDetection(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
): Promise<ImportJob> {
  // 1-3: Verify job exists, tenant-scoped, in the right state.
  const job = await prisma.importJob.findFirst({
    where: { id: importJobId, tenantId },
  });
  if (!job) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Import job not found: ${importJobId}`,
    });
  }
  if (job.status !== "inspected") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Detection can only run on inspected files (current status: ${job.status})`,
    });
  }

  // 4. Mark detection in flight. Re-run path: clear previous fields so
  // a stale success doesn't sit alongside a fresh failure or vice versa.
  const startedAt = new Date();
  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      detectionStartedAt: startedAt,
      detectionCompletedAt: null,
      detectionError: null,
      detectionErrorAt: null,
      detectedEntityType: null,
      detectionConfidence: null,
      detectionReasoning: null,
      detectionInputTokens: null,
      detectionOutputTokens: null,
      detectionLlmModel: null,
    },
  });

  // 5-7: Call LLM + parse + validate. Any failure path records the
  // error and rethrows; success path falls through to step 8.
  try {
    const userPrompt = buildDetectionUserPrompt(job);
    const response = await complete({
      tenantId,
      tier: "cheap",
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 500,
      callerTag: "import-detection",
    });

    const parsed = parseAndValidateDetectionResponse(response.text);

    // 8. Confidence coercion: < 50 → 'unknown'. Preserve LLM's
    // intended type in the reasoning text so the operator sees what
    // Haiku "really thought" before the coercion kicked in.
    const finalEntityType =
      parsed.confidence < 50 ? "unknown" : parsed.entityType;
    const finalReasoning =
      parsed.confidence < 50 && parsed.entityType !== "unknown"
        ? `${parsed.reasoning}\n\n(Coerced to 'unknown' because confidence ${parsed.confidence}% < 50% threshold. LLM's preferred classification was '${parsed.entityType}'.)`
        : parsed.reasoning;

    // 9-10: Write success record.
    return await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        detectedEntityType: finalEntityType as ImportJob["detectedEntityType"],
        detectionConfidence: parsed.confidence,
        detectionReasoning: finalReasoning,
        detectionCompletedAt: new Date(),
        detectionInputTokens: response.inputTokens,
        detectionOutputTokens: response.outputTokens,
        detectionLlmModel: response.model,
      },
    });
  } catch (err) {
    // 11. Failure: write detectionError + detectionErrorAt, leave
    // detectionCompletedAt null, rethrow original error.
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        detectionError: message,
        detectionErrorAt: new Date(),
      },
    });
    throw err;
  }
}
