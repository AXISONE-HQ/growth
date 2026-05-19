/**
 * KAN-905 — Ingestion Cohort 2.4. AI-suggested column-to-field mapping.
 *
 * Builds on KAN-904 entity detection: once a file's `detectedEntityType`
 * is one of {contacts, companies, deals, orders}, this service uses
 * Haiku to suggest which target schema field each source column should
 * map to. The operator then reviews/overrides the suggestions on
 * /imports/[id]/mapping and clicks Save.
 *
 * Pattern: mirrors KAN-904's `import-detection.ts` 1:1 (same SYSTEM_PROMPT
 * + buildUserPrompt + parseAndValidate + run* + denormalized cost snapshot
 * convention). The KAN-905 audit (csv-import-haiku-mapping.ts) showed
 * that the legacy library cannot be extended: 0.0-1.0 float confidence
 * (vs. our 0-100 int), contact-only field universe, silent fallback.
 * So this is a fresh module.
 *
 * Cost: complete() emits an `llm.call` event with caller tag
 * `import-field-mapping` (KAN-734/745). The 3 denormalized snapshot
 * columns on ImportJob (fieldMappingInputTokens, fieldMappingOutputTokens,
 * fieldMappingLlmModel) come from the same response — they MUST NOT
 * diverge from the canonical cost stream.
 *
 * Lookup-vs-canonical targets: some entity universes include "lookup"
 * targets (e.g., DEAL_FIELDS has `contactEmail`, `pipelineName` —
 * these are raw resolution keys on ImportStagingDeal, NOT canonical
 * Deal columns). The prompt tells the model when to prefer those.
 * PR 8 (commit cohort) does the resolution to canonical IDs.
 */
import { TRPCError } from "@trpc/server";
import type { ImportJob, PrismaClient } from "@prisma/client";
import { complete } from "./llm-client.js";
import { parseJsonFromLlm } from "./lib/llm-json.js";

// ─────────────────────────────────────────────
// Target field universe per entity
// ─────────────────────────────────────────────

export type TargetFieldKind = "canonical" | "lookup";

export interface TargetField {
  /** Schema column name OR the 'skip' sentinel. */
  name: string;
  /** Human-readable label for the dropdown. */
  label: string;
  /** One-line hint surfaced to the LLM in the prompt. */
  description: string;
  /**
   * 'canonical' = direct column on the entity's Prisma model;
   * 'lookup'    = raw resolution key (e.g., contactEmail on a Deal)
   *               that PR 8 commit resolves to an internal ID.
   */
  kind: TargetFieldKind;
}

const SKIP_FIELD: TargetField = {
  name: "skip",
  label: "Skip this column",
  description: "Do not import this column",
  kind: "canonical",
};

export const CONTACT_FIELDS: TargetField[] = [
  { name: "email", label: "Email address", description: "Primary email", kind: "canonical" },
  { name: "phone", label: "Phone number", description: "Primary phone (E.164 or local format)", kind: "canonical" },
  { name: "firstName", label: "First name", description: "Given name", kind: "canonical" },
  { name: "lastName", label: "Last name", description: "Family name / surname", kind: "canonical" },
  { name: "companyName", label: "Company name", description: "Denormalized company name string", kind: "canonical" },
  { name: "lifecycleStage", label: "Lifecycle stage", description: "CRM stage: lead/mql/sql/customer/lost", kind: "canonical" },
  { name: "source", label: "Source", description: "Origin: email_inbox/web_form/meta_ad/manual/csv_import/api/hubspot/stripe/shopify/other", kind: "canonical" },
  { name: "segment", label: "Segment", description: "Tenant-defined segmentation tag", kind: "canonical" },
  { name: "addressLine1", label: "Address line 1", description: "Street address", kind: "canonical" },
  { name: "addressLine2", label: "Address line 2", description: "Apt / suite / unit / floor", kind: "canonical" },
  { name: "city", label: "City", description: "City name", kind: "canonical" },
  { name: "region", label: "State / Region", description: "State, province, or region", kind: "canonical" },
  { name: "postalCode", label: "Postal code", description: "ZIP / postal / postcode", kind: "canonical" },
  { name: "country", label: "Country", description: "ISO 3166-1 alpha-2 preferred (e.g. 'US', 'CA')", kind: "canonical" },
  // KAN-922 — Source-tagged external identifier. Stored in canonical
  // Contact.externalIds JSON keyed by ImportJob.externalSourceTag.
  // Required when ImportJob.dedupMatchField='external_id' or when a
  // Deal/Order import uses customerLinkField='external_id'.
  { name: "external_id", label: "External ID", description: "Source-tagged identifier for matching (e.g. HubSpot vid, Stripe cus_id). Stored in externalIds JSON keyed by externalSourceTag.", kind: "canonical" },
  SKIP_FIELD,
];

export const COMPANY_FIELDS: TargetField[] = [
  { name: "name", label: "Company name", description: "Primary display name", kind: "canonical" },
  { name: "legalName", label: "Legal name", description: "Registered / legal entity name", kind: "canonical" },
  { name: "domain", label: "Domain", description: "Primary web domain (e.g. acme.io)", kind: "canonical" },
  { name: "website", label: "Website", description: "Full website URL", kind: "canonical" },
  { name: "industry", label: "Industry", description: "Free-text industry / vertical", kind: "canonical" },
  { name: "sizeRange", label: "Size range", description: "Employee band: range_1_10 / range_11_50 / range_51_200 / range_201_1000 / range_1001_5000 / range_5000_plus", kind: "canonical" },
  { name: "annualRevenue", label: "Annual revenue", description: "Numeric (USD or base currency)", kind: "canonical" },
  { name: "phone", label: "Phone number", description: "Main company phone", kind: "canonical" },
  { name: "email", label: "Email address", description: "Main / contact email for the company", kind: "canonical" },
  { name: "description", label: "Description", description: "Free-text company description", kind: "canonical" },
  { name: "lifecycleStage", label: "Lifecycle stage", description: "prospect / customer / churned / partner / vendor", kind: "canonical" },
  { name: "billingAddressLine1", label: "Billing address line 1", description: "Billing street address", kind: "canonical" },
  { name: "billingAddressLine2", label: "Billing address line 2", description: "Billing apt / suite", kind: "canonical" },
  { name: "billingCity", label: "Billing city", description: "Billing city", kind: "canonical" },
  { name: "billingRegion", label: "Billing state / region", description: "Billing state or region", kind: "canonical" },
  { name: "billingPostalCode", label: "Billing postal code", description: "Billing ZIP / postal", kind: "canonical" },
  { name: "billingCountry", label: "Billing country", description: "Billing ISO 3166-1 alpha-2", kind: "canonical" },
  { name: "mailingAddressLine1", label: "Mailing address line 1", description: "Mailing street address (use only if distinct from billing)", kind: "canonical" },
  { name: "mailingAddressLine2", label: "Mailing address line 2", description: "Mailing apt / suite", kind: "canonical" },
  { name: "mailingCity", label: "Mailing city", description: "Mailing city", kind: "canonical" },
  { name: "mailingRegion", label: "Mailing state / region", description: "Mailing state or region", kind: "canonical" },
  { name: "mailingPostalCode", label: "Mailing postal code", description: "Mailing ZIP / postal", kind: "canonical" },
  { name: "mailingCountry", label: "Mailing country", description: "Mailing ISO 3166-1 alpha-2", kind: "canonical" },
  { name: "taxId", label: "Tax ID", description: "EIN / VAT / GST / etc.", kind: "canonical" },
  { name: "taxIdType", label: "Tax ID type", description: "ein / vat / gst / hst / qst / abn / other", kind: "canonical" },
  { name: "businessRegistrationNumber", label: "Business registration number", description: "Government-issued business registration / corp number", kind: "canonical" },
  { name: "incorporationJurisdiction", label: "Incorporation jurisdiction", description: "State / country of incorporation", kind: "canonical" },
  { name: "isTaxExempt", label: "Tax exempt", description: "Boolean: true/false/yes/no", kind: "canonical" },
  { name: "ownerId", label: "Owner (user ID)", description: "Internal owner user ID (raw — operator maps if known)", kind: "canonical" },
  { name: "linkedinUrl", label: "LinkedIn URL", description: "Company LinkedIn page URL", kind: "canonical" },
  // KAN-922 — see CONTACT_FIELDS.external_id.
  { name: "external_id", label: "External ID", description: "Source-tagged identifier for this company.", kind: "canonical" },
  SKIP_FIELD,
];

export const DEAL_FIELDS: TargetField[] = [
  { name: "name", label: "Deal name", description: "Display name of the deal / opportunity", kind: "canonical" },
  { name: "value", label: "Value (amount)", description: "Monetary value, numeric", kind: "canonical" },
  { name: "currency", label: "Currency", description: "ISO 4217 3-letter code (USD, EUR, ...)", kind: "canonical" },
  { name: "status", label: "Status", description: "open / won / lost", kind: "canonical" },
  { name: "probability", label: "Probability", description: "Integer 0-100", kind: "canonical" },
  { name: "expectedCloseDate", label: "Expected close date", description: "Date in YYYY-MM-DD or any parseable format", kind: "canonical" },
  { name: "closedAt", label: "Closed date", description: "Set when status transitions to won/lost", kind: "canonical" },
  { name: "lostReason", label: "Lost reason", description: "price / timing / competitor / no_response / not_qualified / feature_gap / other", kind: "canonical" },
  { name: "lostReasonDetail", label: "Lost reason detail", description: "Free-text elaboration on lostReason", kind: "canonical" },
  { name: "wonProductSummary", label: "Won product summary", description: "Free-text summary of what was sold", kind: "canonical" },
  { name: "ownerId", label: "Owner (user ID)", description: "Internal owner user ID (raw)", kind: "canonical" },
  // Lookup-kind targets — staging-table raw resolution keys; PR 8 commit resolves to canonical IDs.
  { name: "contactEmail", label: "Contact email (resolved at commit)", description: "Raw email; resolved to Contact at commit time. Use when the source has an email rather than an internal contact ID.", kind: "lookup" },
  { name: "companyName", label: "Company name (resolved at commit)", description: "Raw company name; resolved to Company at commit time.", kind: "lookup" },
  { name: "pipelineName", label: "Pipeline name (resolved at commit)", description: "Raw pipeline name; resolved to Pipeline at commit time.", kind: "lookup" },
  { name: "stageName", label: "Stage name (resolved at commit)", description: "Raw stage name; resolved to Stage at commit time.", kind: "lookup" },
  // KAN-922 — Source-tagged external identifier for the Deal itself.
  { name: "external_id", label: "External ID", description: "Source-tagged identifier for this deal.", kind: "canonical" },
  // KAN-922 — Source-tagged external id of the LINKED customer. Used at
  // commit time when ImportJob.customerLinkField='external_id'; the
  // resolver looks up Contact via externalIds[externalSourceTag]=value.
  { name: "customer_external_id", label: "Customer external ID (resolved at commit)", description: "Source-tagged identifier of the linked customer. Resolves via customerLinkField=external_id at commit time.", kind: "lookup" },
  SKIP_FIELD,
];

export const ORDER_FIELDS: TargetField[] = [
  { name: "orderNumber", label: "Order number", description: "Tenant-unique order identifier", kind: "canonical" },
  { name: "providerOrderId", label: "Provider order ID", description: "Stripe / Shopify / etc. external ID", kind: "canonical" },
  { name: "status", label: "Status", description: "pending / paid / refunded / partially_refunded / cancelled / failed", kind: "canonical" },
  { name: "totalAmount", label: "Total amount", description: "Subtotal pre-tax, numeric", kind: "canonical" },
  { name: "taxAmount", label: "Tax amount", description: "Tax portion, numeric", kind: "canonical" },
  { name: "discountAmount", label: "Discount amount", description: "Discount applied, numeric", kind: "canonical" },
  { name: "grandTotal", label: "Grand total", description: "Final amount after tax & discount", kind: "canonical" },
  { name: "currency", label: "Currency", description: "ISO 4217 3-letter code", kind: "canonical" },
  { name: "placedAt", label: "Placed at", description: "Datetime the order was placed", kind: "canonical" },
  { name: "paidAt", label: "Paid at", description: "Datetime payment cleared", kind: "canonical" },
  { name: "refundedAt", label: "Refunded at", description: "Datetime refund issued", kind: "canonical" },
  { name: "paymentMethod", label: "Payment method", description: "card / ach / invoice / manual / other", kind: "canonical" },
  { name: "paymentProvider", label: "Payment provider", description: "stripe / square / shopify / manual / other", kind: "canonical" },
  { name: "customerNotes", label: "Customer notes", description: "Customer-facing free-text notes", kind: "canonical" },
  { name: "contactEmail", label: "Contact email (resolved at commit)", description: "Raw customer email; resolved to Contact at commit time.", kind: "lookup" },
  { name: "companyName", label: "Company name (resolved at commit)", description: "Raw customer company name; resolved to Company at commit time.", kind: "lookup" },
  // KAN-922 — Source-tagged external identifier for the Order itself.
  { name: "external_id", label: "External ID", description: "Source-tagged identifier for this order.", kind: "canonical" },
  // KAN-922 — Source-tagged external id of the LINKED customer.
  { name: "customer_external_id", label: "Customer external ID (resolved at commit)", description: "Source-tagged identifier of the linked customer.", kind: "lookup" },
  // KAN-922 — Source-tagged external id of the LINKED deal. Used at
  // commit time when ImportJob.dealLinkField='external_id'; populates
  // Order.dealId (which previously stayed NULL).
  { name: "deal_external_id", label: "Deal external ID (resolved at commit)", description: "Source-tagged identifier of the linked deal. Resolves via dealLinkField=external_id at commit time.", kind: "lookup" },
  SKIP_FIELD,
];

/**
 * Centralized lookup of the field universe by entity type. Used by the
 * service to validate mappings + by the tRPC `getFieldUniverse` query
 * to feed the UI dropdowns.
 *
 * `mixed` + `unknown` return empty arrays — both are rejected upfront
 * by runFieldMapping with BAD_REQUEST. V1 doesn't support mapping for
 * those (mixed needs PR 6 row-level classification first; unknown
 * means manual entity-type pick which is also out of scope for V1).
 */
export const FIELD_UNIVERSE_BY_ENTITY: Record<string, TargetField[]> = {
  contacts: CONTACT_FIELDS,
  companies: COMPANY_FIELDS,
  deals: DEAL_FIELDS,
  orders: ORDER_FIELDS,
  mixed: [],
  unknown: [],
};

/** Entity types that V1 supports for field mapping. */
const SUPPORTED_ENTITY_TYPES = new Set(["contacts", "companies", "deals", "orders"]);

// ─────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────

export const MAPPING_SYSTEM_PROMPT = `You are a CRM data mapping specialist. You analyze CSV/XLSX file headers + sample data and suggest which target schema field each source column should map to. You return strict JSON only. Do not include any text outside the JSON response.

Some target fields are marked as "(resolved at commit)" — these are raw lookup keys (e.g., a deal references a contact by email rather than by internal ID). Map source columns to these lookup fields when the source contains identifier text rather than internal IDs.

// KAN-922 — external_id examples (START — atomic-revertible block)
//
// External ID columns: source-system identifiers used for matching across imports.
// Common column names to recognize:
//   - "vid", "hubspot_id", "hs_object_id" → external_id (for HubSpot data)
//   - "stripe_customer_id", "cus_id" → external_id (for Stripe data)
//   - "salesforce_id", "sf_id" → external_id (for Salesforce data)
//   - "user_id", "customer_id", "client_id" → external_id (generic identifiers)
//   - "record_id", "external_id" → external_id (literal)
//
// Cross-entity references (Deal/Order CSVs only):
//   - Columns like "associated_contact_id", "customer_vid", "customer_user_id"
//     → customer_external_id (links this row to a Customer via that customer's external_id)
//   - Columns like "associated_deal_id", "opportunity_vid", "deal_id"
//     → deal_external_id (Order rows linking to a Deal)
//
// When you see a column that's clearly a system-generated identifier (alphanumeric
// codes, UUIDs, sequential numerics with no human meaning), prefer external_id /
// customer_external_id / deal_external_id over "skip". The user can configure
// externalSourceTag in the Match settings panel to tag which source it came from.
//
// KAN-922 — external_id examples (END)`;

/**
 * Render the user prompt for an ImportJob + entity type. Exported for
 * test snapshotting + the product-review gate (renderable against
 * fixtures so we can eyeball the exact prompt Haiku receives).
 */
export function buildMappingUserPrompt(
  job: ImportJob,
  entityType: string,
  targetFields: TargetField[],
): string {
  const headers = (job.detectedHeaders ?? []) as string[];
  const sample = (job.sampleRows ?? []) as Record<string, unknown>[];

  const universeRender = targetFields
    .map((f) => {
      const kindTag = f.kind === "lookup" ? " [lookup — resolved at commit]" : "";
      return `- ${f.name}${kindTag}: ${f.label}. ${f.description}`;
    })
    .join("\n");

  return `Analyze the source columns + sample data and suggest a target field for each source column.

Filename: ${job.fileName}
Entity type: ${entityType}

Target fields for this entity (one of these — or "skip" — per source column):
${universeRender}

Source columns (in order):
${headers.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Sample rows (first 5):
${JSON.stringify(sample, null, 2)}

Rules:
- Return ONE mapping entry per source column. Do not omit any column.
- Use "skip" as the target_field for columns that should not be imported.
- Map to a "lookup" field (marked above) when the source column contains identifier text (like an email or a name) rather than an internal ID.
- confidence is an integer 0-100. For "skip" rows you may return 0.
- reasoning is a single short sentence (max ~20 words) explaining the choice.

Respond with JSON only, no markdown, no commentary:
[
  {
    "source_column": "<one of the source columns above>",
    "target_field": "<one of the target field names above, or \\"skip\\">",
    "confidence": <integer 0-100>,
    "reasoning": "<short sentence>"
  },
  ... one entry per source column
]`;
}

// ─────────────────────────────────────────────
// Parse + validate
// ─────────────────────────────────────────────

export interface FieldMappingEntry {
  sourceColumn: string;
  targetField: string;
  confidence: number | null;
}

class UnparseableMappingResponseError extends Error {
  constructor(rawText: string) {
    super(`LLM returned unparseable output: ${rawText.slice(0, 200)}`);
    this.name = "UnparseableMappingResponseError";
  }
}

class InvalidMappingShapeError extends Error {
  constructor(reason: string) {
    super(`LLM returned invalid mapping shape: ${reason}`);
    this.name = "InvalidMappingShapeError";
  }
}

/**
 * Parse + validate the LLM's JSON-array response against the source
 * headers + target field universe. Returns one entry per source header
 * (gap-fills missing columns with target='skip' and confidence=0).
 * Throws on any structural problem (caller records detectionError +
 * rethrows).
 */
export function parseAndValidateMappingResponse(
  rawText: string,
  sourceHeaders: string[],
  targetFields: TargetField[],
): FieldMappingEntry[] {
  // KAN-917 — strip markdown fences + tolerate leading explanation text.
  let parsed: unknown;
  try {
    parsed = parseJsonFromLlm<unknown>(rawText, {
      tolerateLeadingText: true,
      expectedShape: "array",
    });
  } catch {
    throw new UnparseableMappingResponseError(rawText);
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidMappingShapeError("response is not a JSON array");
  }

  const allowedNames = new Set(targetFields.map((f) => f.name));
  // 'skip' is always allowed even if not in the universe array (defensive
  // — every entity universe includes SKIP_FIELD).
  allowedNames.add("skip");

  const sourceSet = new Set(sourceHeaders);
  const seenSources = new Set<string>();
  const entries: FieldMappingEntry[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const raw = parsed[i];
    if (typeof raw !== "object" || raw === null) {
      throw new InvalidMappingShapeError(`entry ${i} is not an object`);
    }
    const obj = raw as Record<string, unknown>;
    const sourceColumn = obj.source_column;
    const targetField = obj.target_field;
    const confidence = obj.confidence;

    if (typeof sourceColumn !== "string") {
      throw new InvalidMappingShapeError(
        `entry ${i}: source_column must be a string`,
      );
    }
    if (!sourceSet.has(sourceColumn)) {
      throw new InvalidMappingShapeError(
        `entry ${i}: source_column "${sourceColumn}" is not in detectedHeaders`,
      );
    }
    if (seenSources.has(sourceColumn)) {
      throw new InvalidMappingShapeError(
        `entry ${i}: source_column "${sourceColumn}" appears more than once`,
      );
    }
    seenSources.add(sourceColumn);

    if (typeof targetField !== "string") {
      throw new InvalidMappingShapeError(
        `entry ${i}: target_field must be a string`,
      );
    }
    if (!allowedNames.has(targetField)) {
      throw new InvalidMappingShapeError(
        `entry ${i}: target_field "${targetField}" is not in the entity's field universe (or 'skip')`,
      );
    }

    let conf: number | null = null;
    if (targetField !== "skip") {
      if (
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 100
      ) {
        throw new InvalidMappingShapeError(
          `entry ${i}: confidence must be a number 0-100 for non-skip entries`,
        );
      }
      conf = Math.round(confidence);
    }

    entries.push({ sourceColumn, targetField, confidence: conf });
  }

  // Gap-fill any source column the LLM omitted with 'skip' (defensive
  // — the prompt asks for one entry per column, but we don't want to
  // hard-fail on a single missing row).
  for (const header of sourceHeaders) {
    if (!seenSources.has(header)) {
      entries.push({ sourceColumn: header, targetField: "skip", confidence: null });
    }
  }

  return entries;
}

// ─────────────────────────────────────────────
// runFieldMapping — AI suggestion entrypoint
// ─────────────────────────────────────────────

/**
 * Run AI field mapping on an inspected + detected ImportJob.
 *
 * Throws:
 *  - TRPCError('NOT_FOUND') — job doesn't exist OR is cross-tenant
 *  - TRPCError('BAD_REQUEST') — status != 'inspected', or
 *    detectedEntityType is null/mixed/unknown
 *  - Original LLM/parse error — when mapping fails after writing the
 *    failure record (fieldMappingError + fieldMappingErrorAt populated)
 *
 * Re-run idempotent: clears previous AI fields. Does NOT clear
 * fieldMappingConfirmedAt (operator may have already confirmed a
 * prior round); the UI gates re-run on a confirmation dialog.
 */
export async function runFieldMapping(
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
      message: `Field mapping can only run on inspected files (current status: ${job.status})`,
    });
  }
  if (job.detectedEntityType == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Run AI entity detection first (detectedEntityType is null)",
    });
  }
  if (!SUPPORTED_ENTITY_TYPES.has(job.detectedEntityType)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Field mapping is not supported for entity type '${job.detectedEntityType}' (V1 supports contacts/companies/deals/orders only)`,
    });
  }

  const headers = (job.detectedHeaders ?? []) as string[];
  const universe = FIELD_UNIVERSE_BY_ENTITY[job.detectedEntityType] ?? [];

  // Mark in flight + clear previous AI fields. Do NOT clear
  // fieldMappingConfirmedAt — the UI gates re-run on a confirmation
  // dialog, and we want to preserve the prior confirmation timestamp
  // in case the operator decides to keep their saved mappings.
  const startedAt = new Date();
  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      fieldMappingStartedAt: startedAt,
      fieldMappingCompletedAt: null,
      fieldMappingError: null,
      fieldMappingErrorAt: null,
      fieldMappings: null as never, // Prisma JSON null
      fieldMappingConfidence: null,
      fieldMappingReasoning: null,
      fieldMappingInputTokens: null,
      fieldMappingOutputTokens: null,
      fieldMappingLlmModel: null,
    },
  });

  try {
    const userPrompt = buildMappingUserPrompt(job, job.detectedEntityType, universe);
    const response = await complete({
      tenantId,
      tier: "cheap",
      systemPrompt: MAPPING_SYSTEM_PROMPT,
      userPrompt,
      // KAN-917 — bumped from 1500 (HubSpot-shape import bit Fred 2026-05-14:
      // 30 columns × ~150 chars/entry with reasoning ≈ 4500 chars ≈ ~1500
      // tokens for JSON alone; with Haiku's prose reasoning easily 2-3K).
      // Haiku 4.5 max output is 8192 — safe ceiling fits ~50-column CSVs
      // with reasoning. Re-evaluate if Haiku output cap changes.
      maxTokens: 8192,
      callerTag: "import-field-mapping",
    });

    const entries = parseAndValidateMappingResponse(response.text, headers, universe);

    // Overall confidence = average of non-skip rows. Null if all skipped.
    const nonSkipConfidences = entries
      .filter((e) => e.targetField !== "skip" && e.confidence != null)
      .map((e) => e.confidence as number);
    const overallConfidence =
      nonSkipConfidences.length > 0
        ? Math.round(
            nonSkipConfidences.reduce((a, b) => a + b, 0) / nonSkipConfidences.length,
          )
        : null;

    return await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        fieldMappings: entries as never,
        fieldMappingConfidence: overallConfidence,
        fieldMappingReasoning: null, // V1: per-row reasoning lives in fieldMappings via separate slot if needed; overall reasoning deferred
        fieldMappingCompletedAt: new Date(),
        fieldMappingInputTokens: response.inputTokens,
        fieldMappingOutputTokens: response.outputTokens,
        fieldMappingLlmModel: response.model,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        fieldMappingError: message,
        fieldMappingErrorAt: new Date(),
      },
    });
    throw err;
  }
}

// ─────────────────────────────────────────────
// saveFieldMappings — operator-confirmed write
// ─────────────────────────────────────────────

/**
 * KAN-922 — per-import match configuration payload. All fields nullable;
 * undefined → leave the ImportJob column unchanged (so the UI can save
 * partial configs across separate calls without nulling-out earlier
 * choices). Caller passes `null` explicitly to clear a value.
 */
export interface MatchConfigInput {
  dedupMatchField?: string | null;
  externalSourceTag?: string | null;
  customerLinkField?: string | null;
  dealLinkField?: string | null;
}

// KAN-922 — Per-entity allow-lists for the dedupMatchField column. Mirror
// the matcher's per-entity MatchKey types (import-dedup.ts).
const DEDUP_MATCH_KEY_ALLOW_LIST: Record<string, readonly string[]> = {
  contacts: ["email", "phone", "external_id"],
  companies: ["domain", "external_id"],
  deals: ["external_id"],
  orders: ["orderNumber", "providerOrderId", "external_id"],
};

const CUSTOMER_LINK_FIELD_ALLOW_LIST = ["email", "phone", "external_id"];
const DEAL_LINK_FIELD_ALLOW_LIST = ["external_id"];

/**
 * Persist operator-reviewed mappings. Stricter than runFieldMapping's
 * validation: rejects collisions (two non-skip columns sharing the
 * same target_field), which the LLM is allowed to suggest but the
 * operator must resolve before commit.
 */
export async function saveFieldMappings(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
  mappings: FieldMappingEntry[],
  matchConfig?: MatchConfigInput,
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
  // KAN-923 — State-machine gate. Match config (and field mappings) cannot
  // be modified once commit has started. The pre-gate behavior allowed
  // post-commit edits that silently desynced canonical writes from the
  // configured tags (importJob cmp65ai4m1hr3bea6v7umawas evidence:
  // external_source_tag set 6 min post-commit_completed_at, 6592 rows
  // already written with external_ids={}). Reframed 2026-05-19.
  if (job.commitStartedAt != null || job.commitStatus !== "pending") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `Match settings cannot be modified after commit has started ` +
        `(commit_status='${job.commitStatus}'). ` +
        `Cancel this import and re-upload to change match configuration.`,
    });
  }
  if (job.detectedEntityType == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot save mappings without a detected entity type",
    });
  }
  if (!SUPPORTED_ENTITY_TYPES.has(job.detectedEntityType)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Field mapping is not supported for entity type '${job.detectedEntityType}'`,
    });
  }

  const headers = (job.detectedHeaders ?? []) as string[];
  const headerSet = new Set(headers);
  const universe = FIELD_UNIVERSE_BY_ENTITY[job.detectedEntityType] ?? [];
  const allowedTargets = new Set<string>(universe.map((f) => f.name));
  allowedTargets.add("skip");

  // Validate each entry.
  const seenSources = new Set<string>();
  const seenNonSkipTargets = new Map<string, string>(); // target → sourceColumn (for collision message)
  for (const entry of mappings) {
    if (!headerSet.has(entry.sourceColumn)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Mapping references unknown source column '${entry.sourceColumn}' (not in detectedHeaders)`,
      });
    }
    if (seenSources.has(entry.sourceColumn)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Mapping has duplicate source column '${entry.sourceColumn}'`,
      });
    }
    seenSources.add(entry.sourceColumn);

    if (!allowedTargets.has(entry.targetField)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Target field '${entry.targetField}' is not in the entity's universe for '${job.detectedEntityType}'`,
      });
    }

    if (entry.targetField !== "skip") {
      const existing = seenNonSkipTargets.get(entry.targetField);
      if (existing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Two source columns ('${existing}' and '${entry.sourceColumn}') both map to '${entry.targetField}'. Each target field can only be used once.`,
        });
      }
      seenNonSkipTargets.set(entry.targetField, entry.sourceColumn);
    }
  }

  // KAN-922 — validate match configuration (locked decision G3 allow-lists).
  if (matchConfig) {
    const entityAllowList = DEDUP_MATCH_KEY_ALLOW_LIST[job.detectedEntityType];
    if (
      matchConfig.dedupMatchField != null &&
      entityAllowList &&
      !entityAllowList.includes(matchConfig.dedupMatchField)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `dedupMatchField '${matchConfig.dedupMatchField}' is not valid for entity type '${job.detectedEntityType}'. Allowed: ${entityAllowList.join(", ")}.`,
      });
    }
    if (
      matchConfig.customerLinkField != null &&
      !CUSTOMER_LINK_FIELD_ALLOW_LIST.includes(matchConfig.customerLinkField)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `customerLinkField '${matchConfig.customerLinkField}' is not valid. Allowed: ${CUSTOMER_LINK_FIELD_ALLOW_LIST.join(", ")}.`,
      });
    }
    if (
      matchConfig.dealLinkField != null &&
      !DEAL_LINK_FIELD_ALLOW_LIST.includes(matchConfig.dealLinkField)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `dealLinkField '${matchConfig.dealLinkField}' is not valid. Allowed: ${DEAL_LINK_FIELD_ALLOW_LIST.join(", ")}.`,
      });
    }
    // customerLinkField + dealLinkField only relevant on Deal/Order imports
    if (
      job.detectedEntityType !== "deals" &&
      job.detectedEntityType !== "orders" &&
      matchConfig.customerLinkField != null
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `customerLinkField only applies to deal/order imports (this is '${job.detectedEntityType}').`,
      });
    }
    if (
      job.detectedEntityType !== "orders" &&
      matchConfig.dealLinkField != null
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `dealLinkField only applies to order imports (this is '${job.detectedEntityType}').`,
      });
    }
    // Cross-field constraint: any field using external_id requires
    // externalSourceTag. Locked validation per Phase 2 review.
    const anyFieldUsesExternalId =
      matchConfig.dedupMatchField === "external_id" ||
      matchConfig.customerLinkField === "external_id" ||
      matchConfig.dealLinkField === "external_id";
    if (anyFieldUsesExternalId && !matchConfig.externalSourceTag) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "externalSourceTag is required when any match field is set to external_id.",
      });
    }
  }

  // Build the update data. `undefined` keys preserve the existing column
  // value; explicit `null` clears it (so the UI can null-out a previously-
  // saved choice if the user changes their mind).
  const updateData: Record<string, unknown> = {
    fieldMappings: mappings as never,
    fieldMappingConfirmedAt: new Date(),
  };
  if (matchConfig?.dedupMatchField !== undefined) {
    updateData.dedupMatchField = matchConfig.dedupMatchField;
  }
  if (matchConfig?.externalSourceTag !== undefined) {
    updateData.externalSourceTag = matchConfig.externalSourceTag;
  }
  if (matchConfig?.customerLinkField !== undefined) {
    updateData.customerLinkField = matchConfig.customerLinkField;
  }
  if (matchConfig?.dealLinkField !== undefined) {
    updateData.dealLinkField = matchConfig.dealLinkField;
  }

  return prisma.importJob.update({
    where: { id: importJobId },
    data: updateData,
  });
}
