/**
 * KAN-862 — Account Page Cohort 5: hardcoded LLM extraction prompt + tool
 * input_schema for the detect-from-website pipeline.
 *
 * **HOT-SWAP TODO (KAN-863+):** the "prompts are data" doctrine from
 * Cohort 1 was aspirational — no `Prompt` table exists in
 * `packages/db/prisma/schema.prisma` (verified pre-flight). This module
 * hardcodes ACCOUNT_DETECT_PROMPT_V1 as a TS constant per Fred's
 * Decision 2; once a `Prompt` table lands in a future cohort, swap
 * `getAccountDetectPrompt()` to read by `key='account_detect_v1'` from
 * the table. Surface kept narrow precisely so the swap is mechanical.
 *
 * Field-name pin test in suite (per KAN-817 Group 4 pattern) so a typo
 * in any field name can't ship silently — extraction would silently
 * drop the field on the worker side AND the field-validation Zod
 * schemas wouldn't recognize it.
 */

/**
 * Inlined to avoid the cross-rootDir TS6059 trap (per
 * `reference_variable_specifier_dynamic_import` memory). The shape
 * matches `AnthropicToolParam` in
 * `packages/api/src/services/llm-client.ts:112` exactly — Anthropic
 * SDK's tool-input subset.
 */
export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Field paths the extractor tool can return. Each one maps to a column
 * (or nested path for `weeklyHours.*`) on AccountProfile. Validation
 * against existing Cohort 1 Zod schemas happens in the worker before
 * writing to AccountFieldDetection.
 */
export const ACCOUNT_DETECT_FIELD_NAMES = [
  "legalName",
  "displayName",
  "oneLineDescription",
  "primaryPhone",
  "primaryEmail",
  "physicalAddress",
  "weeklyHours",
  "acceptedPaymentMethods",
  "socialProfiles",
] as const;

export type AccountDetectFieldName = (typeof ACCOUNT_DETECT_FIELD_NAMES)[number];

/**
 * Anthropic tool input schema. Sonnet calls this tool with a
 * structured payload — each field is optional (extraction may fail or
 * the website may not surface every field). Confidence is self-reported
 * by Sonnet; downstream consumers (Cohort 6 review side-sheet) surface
 * it to the user.
 */
export const ACCOUNT_DETECT_TOOL: AnthropicToolParam = {
  name: "submit_account_fields",
  description:
    "Submit extracted account fields from the customer's website pages. Provide only fields you are confident about based on the page content. Each field carries a confidence score 0.0-1.0 and a sourceSnippet citing the relevant text.",
  input_schema: {
    type: "object",
    properties: {
      fields: {
        type: "array",
        description: "Extracted account fields. One entry per field detected.",
        items: {
          type: "object",
          required: ["fieldName", "value", "confidence", "sourceUrl", "sourceSnippet"],
          properties: {
            fieldName: {
              type: "string",
              enum: [...ACCOUNT_DETECT_FIELD_NAMES],
              description: "Which AccountProfile field this entry populates.",
            },
            value: {
              description:
                "Extracted value. Type depends on fieldName — string for text fields, structured for weeklyHours/socialProfiles, array for acceptedPaymentMethods.",
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description:
                "Self-assessed confidence 0.0-1.0. Use 0.9+ only for verbatim quotes or unambiguous structured data; use 0.5-0.7 for inferred-but-clear; below 0.5 = don't submit.",
            },
            sourceUrl: {
              type: "string",
              description: "Which page URL this field was extracted from.",
            },
            sourceSnippet: {
              type: "string",
              maxLength: 200,
              description:
                "≤200 char excerpt from the source page that justifies the extracted value.",
            },
          },
        },
      },
    },
    required: ["fields"],
  },
};

/**
 * The system prompt Sonnet sees. Pinned to this constant so changes
 * are tracked in git rather than buried in a database row that bypasses
 * code review. Safe-extraction posture: drop low-confidence fields
 * rather than guessing.
 */
export const ACCOUNT_DETECT_PROMPT_V1 = `You are an information-extraction assistant for a small-business CRM. The user has provided HTML content from up to 3 pages of their company website. Your job is to extract structured account fields the business owner can later confirm or reject.

You will see the cleaned text content of each page (scripts/styles/nav already stripped). For each page, the URL is shown above the content.

Use the submit_account_fields tool to return the extracted data. Rules:

1. Only submit a field if the page content makes its value clear. If a field is ambiguous, missing, or you have to guess, omit it entirely — the user will retry the scan with a different URL.
2. confidence reflects YOUR certainty, not the value's truthiness. 0.9+ = verbatim from the page; 0.6-0.8 = clearly stated but reformatted; do not submit anything below 0.5.
3. sourceSnippet must be a literal excerpt from the page (≤200 chars) — not a paraphrase. Used by the user to verify your extraction.
4. sourceUrl identifies which of the 3 pages each field came from.

Field formats:
- legalName, displayName, oneLineDescription, primaryPhone, primaryEmail, physicalAddress: single string
- weeklyHours: object keyed by day name (monday/tuesday/.../sunday). Each day is either {open: "HH:mm", close: "HH:mm"} or {closed: true}
- acceptedPaymentMethods: array, values from ["card", "ach", "wire", "check", "stripe", "paypal"]
- socialProfiles: array of {platform: "linkedin"|"twitter"|"instagram"|"facebook"|"tiktok"|"youtube"|"other", url: "https://..."}

Phone numbers: normalize to E.164 format (e.g., "+15551234567"). If you can't tell what country code applies, omit.
Email addresses: lowercase.
Time format: 24-hour HH:mm.

If the website content is too vague (homepage with no useful info, "Coming soon" pages, etc.), call submit_account_fields with an empty fields array. Don't fabricate.`;

/**
 * Single accessor — when the Prompt table eventually lands (KAN-863+),
 * swap this to a DB read by key='account_detect_v1' without touching
 * any caller. Returns the system prompt + tool definition together so
 * callers don't get one without the other.
 */
export function getAccountDetectPrompt(): {
  systemPrompt: string;
  tool: AnthropicToolParam;
} {
  return {
    systemPrompt: ACCOUNT_DETECT_PROMPT_V1,
    tool: ACCOUNT_DETECT_TOOL,
  };
}
