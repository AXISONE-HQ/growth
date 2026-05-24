/**
 * KAN-997 Campaign Layer Slice 1 — audience-router service.
 *
 * Two pure functions consumed by the apps/api/src/router.ts tRPC layer:
 *
 *   1. `countAudience` — given a tenantId + AudienceConditions, return
 *      `{ count, isThin }` (isThin = count ≤ THIN_THRESHOLD). Walks the
 *      conditions tree → Prisma `where` clause. Tenant scoping is added
 *      at the outer level (cross-tenant isolation pinned by test).
 *
 *   2. `textToSegment` — given a tenantId + NL text + optional `todayUtc`
 *      anchor, call the LLM (tier='reasoning', callerTag='campaign:
 *      text-to-segment') to extract AudienceConditions, then count.
 *      Returns a discriminated union: { kind: 'segment' | 'ambiguous'
 *      | 'thin' }. Honest on ambiguous / thin / zero per the Slice 1 spec.
 *
 * Read-only guarantee — Slice 1 makes ZERO writes. Inspectability =
 * `console.log(JSON.stringify({ type: 'text_to_segment', ... }))` →
 * Cloud Logging filter `jsonPayload.type="text_to_segment"`. No DB row,
 * no migration, schema-free.
 *
 * Variable-specifier dynamic import pattern (per
 * `reference_variable_specifier_dynamic_import.md`): the tRPC layer in
 * apps/api/src/router.ts imports this module via a non-literal `spec`
 * string to bypass TS6059 cross-rootDir errors. Caller injects an LLM
 * function so tests can mock it without the @growth/llm-cost-tracking
 * runtime dependency.
 */
import type {
  AudienceConditions,
  LeafCondition,
} from '@growth/shared';
import { AudienceConditionsSchema, isAllOf, isAnyOf, isLeaf } from '@growth/shared';

/** Below this count, the surface emits an honest "thin" message. */
export const THIN_THRESHOLD = 5;

/**
 * LLM call shape the router consumes. Mirrors the
 * `llm-client.complete()` signature minus implementation. Caller (tRPC
 * layer in apps/api/src/router.ts) wires the real client; tests inject
 * a mock returning canned JSON.
 */
export interface LLMCompleteFn {
  (input: {
    tenantId: string;
    tier: 'reasoning' | 'cheap';
    systemPrompt: string;
    userPrompt: string;
    callerTag: string;
    jsonMode?: boolean;
    maxTokens?: number;
  }): Promise<{
    text: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
}

/**
 * Prisma client surface this module consumes. Typed loosely to avoid a
 * hard `@prisma/client` dep in this service file (the tRPC layer
 * already imports the typed client).
 */
export interface AudiencePrisma {
  contact: {
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };
}

// ─────────────────────────────────────────────
// Where-tree builder: AudienceConditions → Prisma where
// ─────────────────────────────────────────────

/**
 * Convert a single leaf condition into a Prisma where fragment.
 *
 * `orders.placedAt` + `orders.exists` are translated into a Prisma
 * `orders: { some: { ... } }` relation filter (Prisma's idiom for
 * EXISTS subquery). Order is indexed by (tenantId, placedAt DESC) so
 * the EXISTS hits an index.
 */
function leafToWhere(leaf: LeafCondition): Record<string, unknown> {
  switch (leaf.field) {
    case 'lifecycleStage':
      return { lifecycleStage: { in: leaf.values } };
    case 'segment':
      return { segment: { in: leaf.values } };
    case 'source':
      return { source: { in: leaf.values } };
    case 'country':
      return { country: { in: leaf.values } };
    case 'createdAt':
      return {
        createdAt: {
          gte: new Date(leaf.fromUtc),
          lt: new Date(leaf.toUtcExclusive),
        },
      };
    case 'orders.placedAt':
      return {
        orders: {
          some: {
            placedAt: {
              gte: new Date(leaf.fromUtc),
              lt: new Date(leaf.toUtcExclusive),
            },
          },
        },
      };
    case 'orders.exists':
      return leaf.value
        ? { orders: { some: {} } }
        : { orders: { none: {} } };
  }
}

/**
 * Recursive: AudienceConditions tree → Prisma where clause (without
 * tenant scoping — that's applied by countAudience at the outer level).
 */
export function conditionsToWhere(
  conditions: AudienceConditions,
): Record<string, unknown> {
  if (isLeaf(conditions)) return leafToWhere(conditions);
  if (isAllOf(conditions)) {
    return { AND: conditions.allOf.map(conditionsToWhere) };
  }
  if (isAnyOf(conditions)) {
    return { OR: conditions.anyOf.map(conditionsToWhere) };
  }
  // Unreachable per the schema discriminator; defensive throw.
  throw new Error('conditionsToWhere: unknown node shape');
}

// ─────────────────────────────────────────────
// Count
// ─────────────────────────────────────────────

export interface CountInput {
  conditions: AudienceConditions;
}

export interface CountResult {
  count: number;
  isThin: boolean;
}

/**
 * KAN-997 — count contacts matching the audience tree, scoped to the
 * caller's tenant. The tenant_id WHERE is added at the OUTER level so
 * no leaf condition can accidentally escape tenant scope.
 *
 * Returns `{ count, isThin }`. `isThin` lets the surface render an
 * honest "only N contacts match" message without re-deriving the
 * threshold on the client.
 */
export async function countAudience(
  prisma: AudiencePrisma,
  tenantId: string,
  input: CountInput,
): Promise<CountResult> {
  // Defensive validation — Slice 1's textToSegment already parses the
  // LLM output through AudienceConditionsSchema, but callers may invoke
  // countAudience directly (Slice 2 manual filter builder, future API
  // consumers). Parse once at the entry point.
  const conditions = AudienceConditionsSchema.parse(input.conditions);

  const innerWhere = conditionsToWhere(conditions);
  // Tenant scoping outside the tree — `AND: [{ tenantId }, { ... }]`
  // ensures the predicate survives any future tree shape (including a
  // top-level `OR` that would otherwise let the LLM emit conditions
  // that bypass tenant boundary).
  const where: Record<string, unknown> = {
    AND: [{ tenantId }, innerWhere],
  };

  const count = await prisma.contact.count({ where });
  return { count, isThin: count > 0 && count <= THIN_THRESHOLD };
}

// ─────────────────────────────────────────────
// Text-to-segment (LLM-driven)
// ─────────────────────────────────────────────

export interface TextToSegmentInput {
  nl: string;
  /** Optional override for relative-date resolution. Defaults to new
   *  Date() at call time. Used by tests for deterministic boundary
   *  resolution. */
  todayUtc?: Date;
}

export type TextToSegmentResult =
  | {
      kind: 'segment';
      conditions: AudienceConditions;
      count: number;
      message: string;
    }
  | {
      kind: 'thin';
      conditions: AudienceConditions;
      count: number;
      message: string;
    }
  | {
      kind: 'ambiguous';
      clarifyingQuestion: string;
    };

/** LLM-side discriminated union — what the model is asked to emit. */
type LLMOutput =
  | { kind: 'segment'; conditions: AudienceConditions }
  | { kind: 'ambiguous'; clarifyingQuestion: string };

/**
 * KAN-997 system prompt for the text-to-segment extractor.
 *
 * Encodes the AudienceConditions schema, the canonical example, the
 * tenant's "today" anchor (for relative-date resolution like "last
 * year"), and the honest-on-ambiguous rule. Kept here so tests can
 * snapshot the prompt shape + future tuning is one-edit.
 */
export function buildSystemPrompt(todayUtc: Date): string {
  const todayIso = todayUtc.toISOString();
  return `You convert a natural-language audience description into a structured JSON \`audience_conditions\` object that targets the AxisOne CRM Contact table.

# Schema (TypeScript)

\`\`\`ts
type AudienceConditions =
  | { allOf: AudienceConditions[] }
  | { anyOf: AudienceConditions[] }
  | LeafCondition;

type LeafCondition =
  | { field: 'lifecycleStage'; op: 'in'; values: ('lead'|'mql'|'sql'|'opportunity'|'customer'|'churned')[] }
  | { field: 'segment'; op: 'in'; values: string[] }
  | { field: 'source'; op: 'in'; values: ('form_submission'|'email_inbox'|'csv_upload'|'manual_entry'|'api'|'integration'|'other')[] }
  | { field: 'country'; op: 'in'; values: string[] }  // ISO-3166-1 alpha-2, uppercase
  | { field: 'createdAt'; op: 'between'; fromUtc: string; toUtcExclusive: string }  // ISO 8601 UTC
  | { field: 'orders.placedAt'; op: 'between'; fromUtc: string; toUtcExclusive: string }
  | { field: 'orders.exists'; op: 'eq'; value: boolean };
\`\`\`

# Rules

- Date ranges are **half-open** \`[fromUtc, toUtcExclusive)\`. "March 2025" → \`fromUtc: '2025-03-01T00:00:00.000Z'\`, \`toUtcExclusive: '2025-04-01T00:00:00.000Z'\`.
- Relative dates anchor to TODAY = \`${todayIso}\` (UTC). "last year" → calendar year ${todayUtc.getUTCFullYear() - 1}.
- "bought" → \`orders.placedAt\` range OR \`orders.exists: true\`. "sent a lead" → \`createdAt\` range (added as a Contact). The two are usually \`anyOf\` (OR), unless the phrasing says "and".
- All countries use ISO-3166-1 alpha-2 uppercase ('US', 'CA', 'GB').
- NEVER guess on ambiguous phrasing. If the description could plausibly mean two different segments, return \`{ kind: 'ambiguous', clarifyingQuestion: '...' }\` instead of fabricating one.

# Output

Respond with ONE JSON object only, no prose, no markdown fences. One of:

\`\`\`json
{ "kind": "segment", "conditions": { ... } }
\`\`\`

OR

\`\`\`json
{ "kind": "ambiguous", "clarifyingQuestion": "Did you mean X or Y?" }
\`\`\`

# Canonical example

User: "contacts that bought or sent a lead in March, April & May of last year"
Output (today = ${todayIso}, last year = ${todayUtc.getUTCFullYear() - 1}):
\`\`\`json
{
  "kind": "segment",
  "conditions": {
    "anyOf": [
      { "field": "orders.placedAt", "op": "between", "fromUtc": "${todayUtc.getUTCFullYear() - 1}-03-01T00:00:00.000Z", "toUtcExclusive": "${todayUtc.getUTCFullYear() - 1}-06-01T00:00:00.000Z" },
      { "field": "createdAt", "op": "between", "fromUtc": "${todayUtc.getUTCFullYear() - 1}-03-01T00:00:00.000Z", "toUtcExclusive": "${todayUtc.getUTCFullYear() - 1}-06-01T00:00:00.000Z" }
    ]
  }
}
\`\`\``;
}

/**
 * Parse the LLM response text into a discriminated `LLMOutput`. The
 * model is asked to emit a JSON object directly (no markdown fence),
 * but some providers wrap it anyway — strip a fence if present.
 */
function parseLLMOutput(text: string): LLMOutput {
  let s = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if the model added them.
  const fenceMatch = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && fenceMatch[1]) s = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(
      `text-to-segment: LLM returned non-JSON output: ${(e as Error).message}`,
    );
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'kind' in parsed &&
    (parsed as { kind: unknown }).kind === 'ambiguous'
  ) {
    const q = (parsed as { clarifyingQuestion?: unknown }).clarifyingQuestion;
    if (typeof q !== 'string' || q.length === 0) {
      throw new Error(
        'text-to-segment: LLM returned kind=ambiguous without clarifyingQuestion',
      );
    }
    return { kind: 'ambiguous', clarifyingQuestion: q };
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'kind' in parsed &&
    (parsed as { kind: unknown }).kind === 'segment'
  ) {
    const conditionsRaw = (parsed as { conditions?: unknown }).conditions;
    // Schema-parse — throws TypeError-equivalent ZodError on bad shape.
    // Caller (textToSegment) maps the throw to a user-facing error.
    const conditions = AudienceConditionsSchema.parse(conditionsRaw);
    return { kind: 'segment', conditions };
  }

  throw new Error(
    `text-to-segment: LLM output missing valid kind discriminator: ${s.slice(0, 200)}`,
  );
}

/**
 * Slice 1 inspectability log — structured JSON to stdout. Cloud
 * Logging captures via the Cloud Run runtime; queryable via
 * `jsonPayload.type="text_to_segment"`. No DB row, no migration.
 */
function logTextToSegmentEvent(payload: {
  tenantId: string;
  nlInput: string;
  result: TextToSegmentResult;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      type: 'text_to_segment',
      tenantId: payload.tenantId,
      nlInput: payload.nlInput,
      resultKind: payload.result.kind,
      conditionsOut:
        payload.result.kind === 'segment' || payload.result.kind === 'thin'
          ? payload.result.conditions
          : null,
      count:
        payload.result.kind === 'segment' || payload.result.kind === 'thin'
          ? payload.result.count
          : null,
      clarifyingQuestion:
        payload.result.kind === 'ambiguous' ? payload.result.clarifyingQuestion : null,
      model: payload.model,
      latencyMs: payload.latencyMs,
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
      callerTag: 'campaign:text-to-segment',
    }),
  );
}

/**
 * KAN-997 — NL → audience_conditions → count (single round-trip from
 * the surface's perspective).
 *
 * Failure modes:
 *   - LLM returns non-JSON / missing kind → throws (caller surfaces an
 *     error to the user)
 *   - LLM returns conditions that don't parse AudienceConditionsSchema
 *     → throws (same)
 *   - LLM returns kind=ambiguous → returns { kind: 'ambiguous', ... }
 *   - Count ≤ THIN_THRESHOLD → returns { kind: 'thin', ... } with an
 *     honest message
 *   - Otherwise → { kind: 'segment', ... }
 */
export async function textToSegment(
  prisma: AudiencePrisma,
  tenantId: string,
  input: TextToSegmentInput,
  llm: LLMCompleteFn,
): Promise<TextToSegmentResult> {
  const today = input.todayUtc ?? new Date();
  const systemPrompt = buildSystemPrompt(today);

  const llmResponse = await llm({
    tenantId,
    tier: 'reasoning',
    systemPrompt,
    userPrompt: input.nl,
    callerTag: 'campaign:text-to-segment',
    jsonMode: true,
    maxTokens: 2048,
  });

  const llmOut = parseLLMOutput(llmResponse.text);

  let result: TextToSegmentResult;
  if (llmOut.kind === 'ambiguous') {
    result = { kind: 'ambiguous', clarifyingQuestion: llmOut.clarifyingQuestion };
  } else {
    const { count, isThin } = await countAudience(prisma, tenantId, {
      conditions: llmOut.conditions,
    });
    if (count === 0) {
      result = {
        kind: 'thin',
        conditions: llmOut.conditions,
        count: 0,
        message: 'No contacts match this segment.',
      };
    } else if (isThin) {
      result = {
        kind: 'thin',
        conditions: llmOut.conditions,
        count,
        message: `Only ${count} ${count === 1 ? 'contact matches' : 'contacts match'} this segment.`,
      };
    } else {
      result = {
        kind: 'segment',
        conditions: llmOut.conditions,
        count,
        message: `${count.toLocaleString('en-US')} contacts match.`,
      };
    }
  }

  logTextToSegmentEvent({
    tenantId,
    nlInput: input.nl,
    result,
    model: llmResponse.model,
    latencyMs: llmResponse.latencyMs,
    inputTokens: llmResponse.inputTokens,
    outputTokens: llmResponse.outputTokens,
  });

  return result;
}
