/**
 * KAN-862 — Account Page Cohort 5: Sonnet tool-use extractor.
 *
 * Wraps llm-client.ts (cross-rootDir dynamic import per
 * `reference_variable_specifier_dynamic_import` memory) for the
 * detect-from-website extraction call.
 *
 * Inputs: page texts (post HTML-cleaning), tenantId for cost-event
 * partition.
 * Outputs: validated extraction proposals ready for AccountFieldDetection
 * insert + invalid/dropped fields with reasons.
 *
 * Per-field validation against existing Cohort 1 Zod schemas — anything
 * Sonnet returns that fails the schema is dropped (logged, not thrown).
 * The resulting `validProposals` are what gets written to the DB; the
 * tenant only sees Sonnet output that survives the schema check.
 */
import { z } from "zod";
import {
  IdentityUpdateSchema,
  ContactUpdateSchema,
  PaymentsUpdateSchema,
  WeeklyHoursSchema,
  SocialProfileCreateSchema,
} from "@growth/shared";
import {
  ACCOUNT_DETECT_FIELD_NAMES,
  type AccountDetectFieldName,
  getAccountDetectPrompt,
} from "./account-detect-prompt.js";

// Cross-rootDir dynamic import — same pattern as router.ts (KAN-689 hygiene).
interface LLMClientModule {
  complete: (input: {
    tenantId: string;
    tier: "reasoning" | "cheap";
    systemPrompt?: string;
    userPrompt: string;
    maxTokens?: number;
    callerTag?: string;
    anthropicExtras?: {
      messages?: Array<{ role: "user" | "assistant"; content: unknown }>;
      tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
    };
  }) => Promise<{
    text: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    fallbackUsed: boolean;
    anthropicRaw?: {
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >;
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number };
    };
  }>;
}

let _llmModule: LLMClientModule | null = null;
async function loadLLMClient(): Promise<LLMClientModule> {
  if (_llmModule) return _llmModule;
  const spec = "../../../../packages/api/src/services/llm-client.js";
  _llmModule = (await import(spec)) as LLMClientModule;
  return _llmModule;
}

/** Test seam — inject a mocked LLM module. */
export function __setLLMModuleForTest(mod: LLMClientModule | null): void {
  _llmModule = mod;
}

export interface RawExtractedField {
  fieldName: string;
  value: unknown;
  confidence: number;
  sourceUrl: string;
  sourceSnippet: string;
}

export interface ValidProposal {
  fieldName: AccountDetectFieldName;
  /** JSON-stringified for AccountFieldDetection.proposedValue (Text col). */
  proposedValue: string;
  confidence: number;
  sourceUrl: string;
  sourceSnippet: string;
}

export interface InvalidProposal {
  fieldName: string;
  reason: string;
}

export interface ExtractionResult {
  validProposals: ValidProposal[];
  invalidProposals: InvalidProposal[];
  inputTokens: number;
  outputTokens: number;
  model: string;
  latencyMs: number;
}

const FIELD_NAME_SET = new Set<string>(ACCOUNT_DETECT_FIELD_NAMES);

/**
 * Validate a single extracted field against the corresponding Cohort 1
 * Zod schema. Returns the parsed value on success or an error string on
 * failure. The Cohort 1 schemas are object-shaped; we use `.pick` +
 * `.parse` to validate one key at a time.
 */
function validateField(fieldName: AccountDetectFieldName, value: unknown): {
  ok: true;
  parsed: unknown;
} | {
  ok: false;
  reason: string;
} {
  try {
    switch (fieldName) {
      case "legalName": {
        const parsed = IdentityUpdateSchema.pick({ legalName: true }).parse({
          legalName: value,
        });
        return { ok: true, parsed: parsed.legalName };
      }
      case "displayName": {
        const parsed = IdentityUpdateSchema.pick({ displayName: true }).parse({
          displayName: value,
        });
        return { ok: true, parsed: parsed.displayName };
      }
      case "oneLineDescription": {
        const parsed = IdentityUpdateSchema.pick({ oneLineDescription: true }).parse({
          oneLineDescription: value,
        });
        return { ok: true, parsed: parsed.oneLineDescription };
      }
      case "primaryPhone": {
        const parsed = ContactUpdateSchema.pick({ primaryPhone: true }).parse({
          primaryPhone: value,
        });
        return { ok: true, parsed: parsed.primaryPhone };
      }
      case "primaryEmail": {
        const parsed = ContactUpdateSchema.pick({ primaryEmail: true }).parse({
          primaryEmail: value,
        });
        return { ok: true, parsed: parsed.primaryEmail };
      }
      case "physicalAddress": {
        const parsed = ContactUpdateSchema.pick({ physicalAddress: true }).parse({
          physicalAddress: value,
        });
        return { ok: true, parsed: parsed.physicalAddress };
      }
      case "weeklyHours": {
        const parsed = WeeklyHoursSchema.parse(value);
        return { ok: true, parsed };
      }
      case "acceptedPaymentMethods": {
        const parsed = PaymentsUpdateSchema.innerType()
          .pick({ acceptedPaymentMethods: true })
          .parse({ acceptedPaymentMethods: value });
        return { ok: true, parsed: parsed.acceptedPaymentMethods };
      }
      case "socialProfiles": {
        const parsed = z.array(SocialProfileCreateSchema).parse(value);
        return { ok: true, parsed };
      }
      default: {
        const _exhaustive: never = fieldName;
        return { ok: false, reason: `unknown field: ${String(_exhaustive)}` };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
}

/**
 * Run the full extraction call: build messages from page texts, call
 * Sonnet with the tool, parse + validate the tool_use block.
 */
export async function extractAccountFieldsFromPages(input: {
  tenantId: string;
  combinedPageText: string;
}): Promise<ExtractionResult> {
  const llm = await loadLLMClient();
  const { systemPrompt, tool } = getAccountDetectPrompt();

  const result = await llm.complete({
    tenantId: input.tenantId,
    tier: "reasoning",
    systemPrompt,
    userPrompt: input.combinedPageText,
    maxTokens: 2048,
    callerTag: "account-detect-worker:scan",
    anthropicExtras: {
      tools: [tool],
    },
  });

  const validProposals: ValidProposal[] = [];
  const invalidProposals: InvalidProposal[] = [];

  // Find the tool_use block — Sonnet may return text + tool_use blocks
  // intermixed; we only care about our submit_account_fields call.
  const toolUseBlock = result.anthropicRaw?.content.find(
    (c): c is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
      c.type === "tool_use" && c.name === tool.name,
  );

  if (!toolUseBlock) {
    // Sonnet declined to call the tool (e.g., page content too vague).
    // Return an empty extraction — not an error.
    return {
      validProposals,
      invalidProposals,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
      latencyMs: result.latencyMs,
    };
  }

  const rawFields = (toolUseBlock.input?.fields ?? []) as RawExtractedField[];
  if (!Array.isArray(rawFields)) {
    invalidProposals.push({
      fieldName: "<root>",
      reason: "tool_use.input.fields was not an array",
    });
    return {
      validProposals,
      invalidProposals,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
      latencyMs: result.latencyMs,
    };
  }

  for (const raw of rawFields) {
    if (!FIELD_NAME_SET.has(raw.fieldName)) {
      invalidProposals.push({
        fieldName: raw.fieldName,
        reason: "fieldName not in ACCOUNT_DETECT_FIELD_NAMES",
      });
      continue;
    }
    const fieldName = raw.fieldName as AccountDetectFieldName;
    if (typeof raw.confidence !== "number" || raw.confidence < 0.5 || raw.confidence > 1) {
      invalidProposals.push({
        fieldName,
        reason: `confidence out of acceptable range (0.5-1.0): ${raw.confidence}`,
      });
      continue;
    }
    const validation = validateField(fieldName, raw.value);
    if (!validation.ok) {
      invalidProposals.push({ fieldName, reason: validation.reason });
      continue;
    }
    validProposals.push({
      fieldName,
      proposedValue: JSON.stringify(validation.parsed),
      confidence: raw.confidence,
      sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
      sourceSnippet:
        typeof raw.sourceSnippet === "string"
          ? raw.sourceSnippet.slice(0, 200)
          : "",
    });
  }

  return {
    validProposals,
    invalidProposals,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model: result.model,
    latencyMs: result.latencyMs,
  };
}
