/**
 * KAN-907 — Ingestion Cohort 2.3. Row-level classification (mixed files).
 *
 * The trickiest service in Cohort 2. Picks up where KAN-904 (entity
 * detection) and KAN-905 (field mapping) left off:
 *
 *   - For files where `detectedEntityType === 'mixed'`, classifies each
 *     row individually as contacts / companies / deals / orders /
 *     skipped / unknown, then writes them into the matching
 *     ImportStaging{Contact|Company|Deal|Order} table (PR 3 schema).
 *
 *   - For files where `detectedEntityType` is a single supported
 *     entity (contacts/companies/deals/orders), runs a heuristic-only
 *     pass (rule (f) empty-check, all non-empty rows → file's entity
 *     type). Skips the LLM entirely. ~$0 cost.
 *
 *   - Files with `detectedEntityType` in {'unknown'} are out of scope
 *     (BAD_REQUEST). User must re-run detection or upload a cleaner
 *     file.
 *
 * Cost model (mixed files, 10K rows, ~75% heuristic / ~25% LLM):
 *   - 50 LLM batches × ~$0.005 = ~$0.25 per upload
 *   - Linear scale: $2.50 / 100K rows, $25 / 1M rows
 *   - Single-entity: $0
 *
 * Hybrid pipeline (decision A-F from the KAN-907 spec):
 *   1. Re-download + re-parse GCS object (full row set, not the 5
 *      sample rows captured at inspection).
 *   2. For each row: run heuristic prefilter (7 rules, empty-check FIRST).
 *   3. If heuristic returns: stage immediately (`bySource='heuristic'`).
 *   4. If heuristic returns null: queue for LLM batch (50 rows / batch).
 *   5. Stage LLM-classified rows (`bySource='llm'`).
 *   6. Aggregate counts → `rowClassificationCounts` JSON on ImportJob.
 *
 * Boundary-confidence rows (heuristic <85 OR LLM <70) get
 * `metadata.review_recommended = true` in their staging row's
 * sourceRowData — surfaced in Card 5 + PR 7 dedup UI for operator
 * sample-check.
 *
 * Mirror columns on staging rows stay NULL. PR 5 (mapping) is the
 * canonical field-population step. sourceRowData carries the full raw
 * row for downstream projection.
 */
import { TRPCError } from "@trpc/server";
import type { ImportJob, PrismaClient } from "@prisma/client";
import { complete } from "./llm-client.js";
import { downloadObject } from "./import-storage.js";
import {
  parseAllCsvRows,
  parseAllXlsxRows,
  type RawRow,
} from "./lib/file-parsers.js";

// ─────────────────────────────────────────────
// Entity type vocabulary
// ─────────────────────────────────────────────

export type ClassifiedEntity =
  | "contacts"
  | "companies"
  | "deals"
  | "orders"
  | "skipped"
  | "unknown";

const ENTITY_VALUES = new Set<ClassifiedEntity>([
  "contacts",
  "companies",
  "deals",
  "orders",
  "skipped",
  "unknown",
]);

const SUPPORTED_FILE_ENTITY_TYPES = new Set([
  "contacts",
  "companies",
  "deals",
  "orders",
  "mixed",
]);

// ─────────────────────────────────────────────
// Header synonym sets (decision B — inline, no coupling with legacy
// csv-import-haiku-mapping.ts). Each Set holds normalized header names
// — lowercase, with `[-_\s]` stripped. The `headerHas` helper does the
// same normalization on the row's keys before lookup.
// ─────────────────────────────────────────────

function normalizeHeader(h: string): string {
  // "#" is shorthand for "number" in CRM exports ("Order #" → "ordernumber",
  // "Customer #" → "customernumber"). Expand before the non-alphanumeric
  // strip so the heuristic catches it.
  return h
    .toLowerCase()
    .replace(/#/g, "number")
    .replace(/[\s\-_]+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const EMAIL_HEADERS = new Set([
  "email", "emailaddress", "mail", "mailaddress", "useremail", "customeremail",
  "contactemail", "primaryemail", "workemail",
]);
const PHONE_HEADERS = new Set([
  "phone", "phonenumber", "telephone", "tel", "mobile", "mobilenumber",
  "cell", "cellphone", "contactnumber",
]);
const FIRST_NAME_HEADERS = new Set([
  "firstname", "fname", "givenname", "first", "forename",
]);
const LAST_NAME_HEADERS = new Set([
  "lastname", "lname", "surname", "familyname", "last",
]);
const NAME_HEADERS = new Set([
  "name", "fullname", "displayname", "title",
]);
const DOMAIN_HEADERS = new Set([
  "domain", "website", "url", "webaddress", "homepage", "site",
]);
const INDUSTRY_HEADERS = new Set([
  "industry", "sector", "vertical", "category",
]);
const EMPLOYEE_COUNT_HEADERS = new Set([
  "employeecount", "employees", "numemployees", "headcount", "staffsize", "size",
]);
const ANNUAL_REVENUE_HEADERS = new Set([
  "annualrevenue", "revenue", "yearlyrevenue", "arr", "ttmrevenue",
]);

const DEAL_NAME_HEADERS = new Set([
  "dealname", "opportunityname", "opportunity", "deal", "opportunitytitle",
  "salestage", "pipelinename",
]);
const AMOUNT_HEADERS = new Set([
  "amount", "value", "dealvalue", "dealamount", "dealsize", "opportunityvalue",
  "contractvalue", "price",
]);
const STAGE_HEADERS = new Set([
  "stage", "dealstage", "pipelinestage", "salesstage", "opportunitystage",
]);
const CLOSE_DATE_HEADERS = new Set([
  "closedate", "expectedclosedate", "estimatedclose", "targetclose",
  "projectedclose",
]);

const ORDER_NUMBER_HEADERS = new Set([
  "ordernumber", "orderid", "orderno", "ordernum", "invoicenumber",
  "invoiceid", "invoiceno", "transactionid", "transactionnumber", "chargeid",
  "receiptnumber", "purchaseorder", "po", "ponumber",
]);
const PROVIDER_ORDER_ID_HEADERS = new Set([
  "providerorderid", "stripeorderid", "shopifyorderid", "externalorderid",
  "platformorderid",
]);
const TOTAL_HEADERS = new Set([
  "total", "ordertotal", "amounttotal", "grandtotal", "totalamount",
  "totalprice", "subtotal",
]);
const PAYMENT_METHOD_HEADERS = new Set([
  "paymentmethod", "paytype", "paymenttype", "paymentmode", "tender",
]);
const PLACED_AT_HEADERS = new Set([
  "placedat", "ordereddate", "orderdate", "purchasedate", "transactiondate",
  "saledate",
]);

const DISCRIMINATOR_HEADERS = new Set([
  "recordtype", "type", "entitytype", "rowtype", "kind", "category",
]);

/** Map discriminator-column raw values to a ClassifiedEntity (case-
 *  insensitive, ignoring punctuation/whitespace). Returns null for
 *  unrecognized values — caller falls through to keyword rules. */
function mapDiscriminatorValue(raw: string): ClassifiedEntity | null {
  const n = normalizeHeader(raw);
  if (["contact", "contacts", "person", "people", "lead", "leads"].includes(n)) return "contacts";
  if (["company", "companies", "account", "accounts", "organization", "organisations", "organisation", "organizations", "org", "orgs"].includes(n)) return "companies";
  if (["deal", "deals", "opportunity", "opportunities", "pipeline"].includes(n)) return "deals";
  if (["order", "orders", "sale", "sales", "transaction", "transactions", "invoice", "invoices"].includes(n)) return "orders";
  return null;
}

// ─────────────────────────────────────────────
// Row-shape inspection helpers
// ─────────────────────────────────────────────

/** Index a row by normalized header name for set-based lookup. */
function indexRowByNormalizedHeader(row: RawRow): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    const norm = normalizeHeader(k);
    if (norm && !idx.has(norm)) {
      idx.set(norm, String(v));
    }
  }
  return idx;
}

/** Returns the first non-empty value among headers in the given set. */
function getValueIn(
  rowIdx: Map<string, string>,
  headers: Set<string>,
): string | null {
  for (const h of headers) {
    const v = rowIdx.get(h);
    if (v != null && v.trim() !== "") return v;
  }
  return null;
}

/** True if at least one header in the set has a non-empty value. */
function hasAny(rowIdx: Map<string, string>, headers: Set<string>): boolean {
  return getValueIn(rowIdx, headers) != null;
}

/** True if >80% of the row's column values are null/empty. */
function isMostlyEmpty(row: RawRow): boolean {
  const values = Object.values(row);
  if (values.length === 0) return true;
  const empty = values.filter(
    (v) => v == null || (typeof v === "string" && v.trim() === ""),
  ).length;
  return empty / values.length > 0.8;
}

// ─────────────────────────────────────────────
// Heuristic prefilter (7 rules)
//
// Priority order (decision E — rule f FIRST):
//   1. (f) Empty / mostly-empty row             → 'skipped' @ 100
//   2. (a) Discriminator column trusted value   → mapped entity @ 100
//   3. (b) Order signal                         → 'orders' @ 90
//   4. (c) Deal signal                          → 'deals' @ 85
//   5. (d) Company signal                       → 'companies' @ 85
//   6. (e) Contact signal                       → 'contacts' @ 80
//   7. (no match)                               → null (caller queues for LLM)
//
// Boundary confidences (<85) flag `metadata.review_recommended=true`
// at the staging-write step.
// ─────────────────────────────────────────────

export interface HeuristicResult {
  entityType: ClassifiedEntity;
  confidence: number;
  reasoning: string;
}

export function heuristicClassifyRow(row: RawRow): HeuristicResult | null {
  // Rule (f) — empty / mostly-empty row → skipped. Runs FIRST so an
  // empty row with only a discriminator column set doesn't get staged
  // as a vacuous entity.
  if (isMostlyEmpty(row)) {
    return {
      entityType: "skipped",
      confidence: 100,
      reasoning: "Row is empty or >80% null columns.",
    };
  }

  const rowIdx = indexRowByNormalizedHeader(row);

  // Rule (a) — discriminator column. Look up by normalized header name.
  for (const dh of DISCRIMINATOR_HEADERS) {
    const v = rowIdx.get(dh);
    if (v != null && v.trim() !== "") {
      const mapped = mapDiscriminatorValue(v);
      if (mapped) {
        return {
          entityType: mapped,
          confidence: 100,
          reasoning: `Discriminator column matched: ${v} → ${mapped}`,
        };
      }
      // Discriminator present but value unrecognized — fall through to
      // keyword rules rather than ignoring the row entirely.
    }
  }

  const hasOrderNumber = hasAny(rowIdx, ORDER_NUMBER_HEADERS);
  const hasProviderOrderId = hasAny(rowIdx, PROVIDER_ORDER_ID_HEADERS);
  const hasTotal = hasAny(rowIdx, TOTAL_HEADERS);
  const hasPaymentMethod = hasAny(rowIdx, PAYMENT_METHOD_HEADERS);
  const hasPlacedAt = hasAny(rowIdx, PLACED_AT_HEADERS);

  const hasDealName = hasAny(rowIdx, DEAL_NAME_HEADERS);
  const hasAmount = hasAny(rowIdx, AMOUNT_HEADERS);
  const hasStage = hasAny(rowIdx, STAGE_HEADERS);
  const hasCloseDate = hasAny(rowIdx, CLOSE_DATE_HEADERS);

  const hasDomain = hasAny(rowIdx, DOMAIN_HEADERS);
  const hasIndustry = hasAny(rowIdx, INDUSTRY_HEADERS);
  const hasEmployeeCount = hasAny(rowIdx, EMPLOYEE_COUNT_HEADERS);
  const hasAnnualRevenue = hasAny(rowIdx, ANNUAL_REVENUE_HEADERS);
  const hasName = hasAny(rowIdx, NAME_HEADERS);

  const hasEmail = hasAny(rowIdx, EMAIL_HEADERS);
  const hasFirstName = hasAny(rowIdx, FIRST_NAME_HEADERS);
  const hasLastName = hasAny(rowIdx, LAST_NAME_HEADERS);

  // Rule (b) — Order signal.
  if (
    hasOrderNumber ||
    hasProviderOrderId ||
    (hasTotal && hasPaymentMethod) ||
    (hasTotal && hasPlacedAt)
  ) {
    return {
      entityType: "orders",
      confidence: 90,
      reasoning: "Order signal: order_number / provider_order_id / (total + payment_method).",
    };
  }

  // Rule (c) — Deal signal.
  if (
    hasDealName ||
    (hasAmount && hasStage) ||
    (hasCloseDate && hasAmount)
  ) {
    return {
      entityType: "deals",
      confidence: 85,
      reasoning: "Deal signal: deal_name / (amount + stage) / (close_date + amount).",
    };
  }

  // Rule (d) — Company signal. Excludes when email is present (likely
  // a contact with company columns).
  if (
    (hasDomain && hasIndustry) ||
    (hasName && hasDomain && !hasEmail) ||
    (hasAnnualRevenue && hasEmployeeCount)
  ) {
    return {
      entityType: "companies",
      confidence: 85,
      reasoning: "Company signal: (domain + industry) / (name + domain w/o email) / (annual_revenue + employee_count).",
    };
  }

  // Rule (e) — Contact signal. Excludes when order_number OR deal_name
  // is present (those higher-specificity rules should have already
  // fired; this is defense-in-depth).
  if (
    hasEmail &&
    (hasFirstName || hasLastName) &&
    !hasOrderNumber &&
    !hasDealName
  ) {
    return {
      entityType: "contacts",
      confidence: 80,
      reasoning: "Contact signal: email + (first_name OR last_name).",
    };
  }

  // No rule fired — caller queues for LLM.
  return null;
}

// ─────────────────────────────────────────────
// LLM batch classifier
// ─────────────────────────────────────────────

const ROW_CLASSIFICATION_BATCH_SIZE = 50;

export const ROW_CLASSIFICATION_SYSTEM_PROMPT = `You are a CRM data classification specialist. You analyze CSV/XLSX rows where the file mixes multiple entity types. For each row, classify it as one of the entity types based on the row's data. Return strict JSON only. Do not include any text outside the JSON response.`;

interface LlmBatchInput {
  rowIndex: number;
  row: RawRow;
}

export function buildRowClassificationUserPrompt(
  headers: string[],
  batch: LlmBatchInput[],
): string {
  const renderedRows = batch
    .map((b) => `  { "row_index": ${b.rowIndex}, "data": ${JSON.stringify(b.row)} }`)
    .join(",\n");

  return `Classify each row as exactly one of: 'contacts' | 'companies' | 'deals' | 'orders' | 'skipped' | 'unknown'.

Entity hints:
- contacts: People/individuals (email + name + phone shape).
- companies: Organizations/businesses (name + domain + industry shape).
- deals: Sales opportunities (deal_name + amount + stage shape).
- orders: Completed transactions (order_number + total + placed_at shape).
- skipped: Empty or mostly-null rows.
- unknown: Cannot confidently classify.

Headers (in order):
${headers.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Rows to classify (one entry per row, keyed by row_index):
[
${renderedRows}
]

Respond with JSON only, no markdown, no commentary. One entry per input row, in the same order:
[
  { "row_index": <integer matching input>, "entity_type": "<one of the 6 types>", "confidence": <integer 0-100>, "reasoning": "<short sentence>" },
  ... ${batch.length} entries
]`;
}

export interface LlmClassifiedEntry {
  rowIndex: number;
  entityType: ClassifiedEntity;
  confidence: number;
  reasoning: string;
}

class UnparseableBatchError extends Error {
  constructor(rawText: string) {
    super(`LLM batch returned unparseable output: ${rawText.slice(0, 200)}`);
    this.name = "UnparseableBatchError";
  }
}

class InvalidBatchShapeError extends Error {
  constructor(reason: string) {
    super(`LLM batch returned invalid shape: ${reason}`);
    this.name = "InvalidBatchShapeError";
  }
}

export function parseAndValidateBatchResponse(
  rawText: string,
  expectedIndices: Set<number>,
): LlmClassifiedEntry[] {
  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new UnparseableBatchError(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new UnparseableBatchError(rawText);
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidBatchShapeError("response is not a JSON array");
  }

  const entries: LlmClassifiedEntry[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < parsed.length; i++) {
    const raw = parsed[i];
    if (typeof raw !== "object" || raw === null) {
      throw new InvalidBatchShapeError(`entry ${i} is not an object`);
    }
    const obj = raw as Record<string, unknown>;
    const rowIndex = obj.row_index;
    const entityType = obj.entity_type;
    const confidence = obj.confidence;
    const reasoning = obj.reasoning;

    if (typeof rowIndex !== "number" || !Number.isInteger(rowIndex)) {
      throw new InvalidBatchShapeError(`entry ${i}: row_index must be an integer`);
    }
    if (!expectedIndices.has(rowIndex)) {
      throw new InvalidBatchShapeError(
        `entry ${i}: row_index ${rowIndex} not in this batch`,
      );
    }
    if (seen.has(rowIndex)) {
      throw new InvalidBatchShapeError(
        `entry ${i}: row_index ${rowIndex} returned twice`,
      );
    }
    seen.add(rowIndex);

    if (typeof entityType !== "string" || !ENTITY_VALUES.has(entityType as ClassifiedEntity)) {
      throw new InvalidBatchShapeError(
        `entry ${i}: entity_type '${String(entityType)}' is not valid`,
      );
    }
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 100
    ) {
      throw new InvalidBatchShapeError(
        `entry ${i}: confidence must be a number 0-100`,
      );
    }
    if (typeof reasoning !== "string") {
      throw new InvalidBatchShapeError(`entry ${i}: reasoning must be a string`);
    }

    entries.push({
      rowIndex,
      entityType: entityType as ClassifiedEntity,
      confidence: Math.round(confidence),
      reasoning,
    });
  }

  // Gap-fill: any expected row not in the response gets 'unknown' @ 0.
  // Defensive — the prompt asks for one entry per row.
  for (const idx of expectedIndices) {
    if (!seen.has(idx)) {
      entries.push({
        rowIndex: idx,
        entityType: "unknown",
        confidence: 0,
        reasoning: "LLM omitted this row from the batch response.",
      });
    }
  }

  return entries;
}

// ─────────────────────────────────────────────
// Staging row construction
// ─────────────────────────────────────────────

interface ClassifiedRow {
  rowIndex: number;
  row: RawRow;
  entityType: ClassifiedEntity;
  confidence: number;
  reasoning: string;
  source: "heuristic" | "llm";
}

interface StagingMetadata {
  source: "heuristic" | "llm";
  confidence: number;
  reasoning: string;
  /** Boundary-confidence flag — operator should sample-check this row. */
  review_recommended?: boolean;
}

function buildStagingMetadata(c: ClassifiedRow): StagingMetadata {
  const meta: StagingMetadata = {
    source: c.source,
    confidence: c.confidence,
    reasoning: c.reasoning,
  };
  // Decision C — boundary confidences flag review_recommended.
  // Heuristic <85 (rules c/d/e) or LLM <70 = "low".
  const isBoundary =
    (c.source === "heuristic" && c.confidence < 85) ||
    (c.source === "llm" && c.confidence < 70);
  if (isBoundary) meta.review_recommended = true;
  return meta;
}

// ─────────────────────────────────────────────
// Aggregate counts
// ─────────────────────────────────────────────

export interface RowClassificationCounts {
  total: number;
  byEntity: {
    contacts: number;
    companies: number;
    deals: number;
    orders: number;
    skipped: number;
    unknown: number;
  };
  bySource: {
    heuristic: number;
    llm: number;
  };
  lowConfidenceFlags: number;
}

function emptyCounts(): RowClassificationCounts {
  return {
    total: 0,
    byEntity: { contacts: 0, companies: 0, deals: 0, orders: 0, skipped: 0, unknown: 0 },
    bySource: { heuristic: 0, llm: 0 },
    lowConfidenceFlags: 0,
  };
}

// ─────────────────────────────────────────────
// Main entrypoint — runRowClassification
// ─────────────────────────────────────────────

export async function runRowClassification(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
): Promise<ImportJob> {
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
      message: `Row classification can only run on inspected files (current status: ${job.status})`,
    });
  }
  if (job.detectedEntityType == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Run AI entity detection first (detectedEntityType is null)",
    });
  }
  if (!SUPPORTED_FILE_ENTITY_TYPES.has(job.detectedEntityType)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Row classification is not supported for entity type '${job.detectedEntityType}'`,
    });
  }

  const startedAt = new Date();
  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      rowClassificationStartedAt: startedAt,
      rowClassificationCompletedAt: null,
      rowClassificationError: null,
      rowClassificationErrorAt: null,
      rowClassificationCounts: null as never,
      rowClassificationInputTokens: null,
      rowClassificationOutputTokens: null,
      rowClassificationLlmModel: null,
    },
  });

  try {
    // 1. Re-download + re-parse.
    const buffer = await downloadObject(job.gcsObjectPath);
    const parsed =
      job.detectedFileType === "xlsx"
        ? parseAllXlsxRows(buffer)
        : parseAllCsvRows(buffer);
    const { headers, rows } = parsed;

    if (rows.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Parsed file has zero data rows; cannot classify",
      });
    }

    // 2. Heuristic pass — single iteration.
    const classified: ClassifiedRow[] = [];
    const llmQueue: LlmBatchInput[] = [];
    const singleEntity =
      job.detectedEntityType !== "mixed" ? job.detectedEntityType : null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Single-entity path (decision F): heuristic only checks rule (f)
      // empty. All non-empty rows get the file's entity type.
      if (singleEntity) {
        if (isMostlyEmpty(row)) {
          classified.push({
            rowIndex: i,
            row,
            entityType: "skipped",
            confidence: 100,
            reasoning: "Row is empty or >80% null columns.",
            source: "heuristic",
          });
        } else {
          classified.push({
            rowIndex: i,
            row,
            entityType: singleEntity as ClassifiedEntity,
            confidence: 100,
            reasoning: `Single-entity file (detected as '${singleEntity}'); row staged as that entity.`,
            source: "heuristic",
          });
        }
        continue;
      }

      // Mixed-file path: full 7-rule heuristic.
      const h = heuristicClassifyRow(row);
      if (h) {
        classified.push({
          rowIndex: i,
          row,
          entityType: h.entityType,
          confidence: h.confidence,
          reasoning: h.reasoning,
          source: "heuristic",
        });
      } else {
        llmQueue.push({ rowIndex: i, row });
      }
    }

    // 3. LLM batches (mixed-file only — singleEntity short-circuits above
    //    so llmQueue is empty).
    let inputTokens = 0;
    let outputTokens = 0;
    let llmModel: string | null = null;
    for (let i = 0; i < llmQueue.length; i += ROW_CLASSIFICATION_BATCH_SIZE) {
      const batch = llmQueue.slice(i, i + ROW_CLASSIFICATION_BATCH_SIZE);
      const expectedIndices = new Set(batch.map((b) => b.rowIndex));
      const userPrompt = buildRowClassificationUserPrompt(headers, batch);
      const response = await complete({
        tenantId,
        tier: "cheap",
        systemPrompt: ROW_CLASSIFICATION_SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 2000,
        callerTag: "import-row-classification",
      });
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;
      llmModel = response.model;

      const entries = parseAndValidateBatchResponse(response.text, expectedIndices);
      const byIndex = new Map(entries.map((e) => [e.rowIndex, e]));
      for (const item of batch) {
        const e = byIndex.get(item.rowIndex);
        // parseAndValidateBatchResponse gap-fills missing rows with
        // unknown@0, so e is always defined.
        classified.push({
          rowIndex: item.rowIndex,
          row: item.row,
          entityType: e!.entityType,
          confidence: e!.confidence,
          reasoning: e!.reasoning,
          source: "llm",
        });
      }
    }

    // 4. Stage rows. Group by target staging table for bulk insert.
    const counts = emptyCounts();
    counts.total = classified.length;

    const stagingContactsData: Array<Record<string, unknown>> = [];
    const stagingCompaniesData: Array<Record<string, unknown>> = [];
    const stagingDealsData: Array<Record<string, unknown>> = [];
    const stagingOrdersData: Array<Record<string, unknown>> = [];

    for (const c of classified) {
      counts.byEntity[c.entityType] += 1;
      counts.bySource[c.source] += 1;

      const meta = buildStagingMetadata(c);
      if (meta.review_recommended) counts.lowConfidenceFlags += 1;

      // 'skipped' rows do NOT write to any staging table — they're
      // counted but not persisted.
      if (c.entityType === "skipped") continue;

      // Mirror columns NULL at write time (decision D). sourceRowData
      // carries the full raw row + classification metadata.
      const stagingRow = {
        importJobId,
        tenantId,
        sourceRowIndex: c.rowIndex,
        sourceRowData: { ...c.row, _classification: meta } as unknown,
        // Mirror columns stay null (default).
      };

      if (c.entityType === "contacts") {
        stagingContactsData.push(stagingRow);
      } else if (c.entityType === "companies") {
        stagingCompaniesData.push(stagingRow);
      } else if (c.entityType === "deals") {
        stagingDealsData.push(stagingRow);
      } else if (c.entityType === "orders") {
        stagingOrdersData.push(stagingRow);
      }
      // 'unknown' rows are counted but not staged (no target table).
    }

    // 5. Atomic bulk insert across the 4 staging tables. Clears any
    // pre-existing staging rows for this importJob first (re-run path).
    await prisma.$transaction([
      prisma.importStagingContact.deleteMany({ where: { importJobId } }),
      prisma.importStagingCompany.deleteMany({ where: { importJobId } }),
      prisma.importStagingDeal.deleteMany({ where: { importJobId } }),
      prisma.importStagingOrder.deleteMany({ where: { importJobId } }),
      ...(stagingContactsData.length > 0
        ? [prisma.importStagingContact.createMany({ data: stagingContactsData as never })]
        : []),
      ...(stagingCompaniesData.length > 0
        ? [prisma.importStagingCompany.createMany({ data: stagingCompaniesData as never })]
        : []),
      ...(stagingDealsData.length > 0
        ? [prisma.importStagingDeal.createMany({ data: stagingDealsData as never })]
        : []),
      ...(stagingOrdersData.length > 0
        ? [prisma.importStagingOrder.createMany({ data: stagingOrdersData as never })]
        : []),
    ]);

    // 6. Persist ImportJob.
    return await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        rowClassificationCounts: counts as never,
        rowClassificationCompletedAt: new Date(),
        rowClassificationInputTokens: inputTokens || null,
        rowClassificationOutputTokens: outputTokens || null,
        rowClassificationLlmModel: llmModel,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        rowClassificationError: message,
        rowClassificationErrorAt: new Date(),
      },
    });
    throw err;
  }
}

// ─────────────────────────────────────────────
// confirmRowClassification — operator confirmation
// ─────────────────────────────────────────────

export async function confirmRowClassification(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
): Promise<ImportJob> {
  const job = await prisma.importJob.findFirst({
    where: { id: importJobId, tenantId },
  });
  if (!job) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Import job not found: ${importJobId}`,
    });
  }
  if (!job.rowClassificationCompletedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot confirm row classification before it has completed",
    });
  }
  // Idempotent re-confirm just updates the timestamp.
  return prisma.importJob.update({
    where: { id: importJobId },
    data: { rowClassificationConfirmedAt: new Date() },
  });
}
