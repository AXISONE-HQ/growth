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
  CampaignProposal,
  LeafCondition,
  ProposeResult,
} from '@growth/shared';
import {
  AudienceConditionsSchema,
  CampaignProposalSchema,
  CampaignStrategyEnum,
  isAllOf,
  isAnyOf,
  isLeaf,
} from '@growth/shared';

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
    // KAN-1001 Slice 3a — contact-ID materialization for CampaignMembership
    // snapshot at commit time. Paginated via `take` + `cursor` so large
    // audiences stream in batches (called from the async materialization
    // worker; sync path uses a single fetch with a low `take`).
    findMany: (args: {
      where: Record<string, unknown>;
      select: { id: true };
      take?: number;
      cursor?: { id: string };
      skip?: number;
      orderBy?: { id: 'asc' | 'desc' };
    }) => Promise<Array<{ id: string }>>;
  };
  // KAN-1000 Slice 2 — historical value sum + objective catalog read.
  order: {
    aggregate: (args: {
      where: Record<string, unknown>;
      _sum: { grandTotal: true };
    }) => Promise<{ _sum: { grandTotal: unknown } }>;
  };
  objective: {
    findMany: (args: {
      where: { tenantId: string; isActive?: boolean };
      select: { id: true; name: true; type: true };
      take?: number;
      orderBy?: { createdAt: 'desc' | 'asc' };
    }) => Promise<Array<{ id: string; name: string; type: string }>>;
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
  /** KAN-1000 Slice 2 — SUM(Order.grandTotal) where Order.contact
   *  matches the audience tree AND Order.currency='USD'. Labeled
   *  "Past USD revenue in this audience" on the surface; NOT a
   *  forecast. Mixed-currency aggregation deferred (USD is the
   *  default; non-USD orders excluded from this sum). */
  historicalValueUsd: number;
}

/**
 * KAN-997 — count contacts matching the audience tree, scoped to the
 * caller's tenant. The tenant_id WHERE is added at the OUTER level so
 * no leaf condition can accidentally escape tenant scope.
 * KAN-1000 Slice 2 — also returns historicalValueUsd = SUM of past
 * USD orders from matched contacts. Single round-trip from the
 * surface's perspective (parallel queries below).
 *
 * Returns `{ count, isThin, historicalValueUsd }`. `isThin` lets the
 * surface render "only N contacts match" without re-deriving the
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

  // Historical-value query — Order.contact relation filter applies the
  // same audience tree (no tenant escape: outer tenantId on Order +
  // contact relation also scoped by the audience tree's outer-AND).
  const orderWhere: Record<string, unknown> = {
    AND: [
      { tenantId },
      { currency: 'USD' },
      { contact: { AND: [{ tenantId }, innerWhere] } },
    ],
  };

  // KAN-1000 Slice 2 fix-forward — wrap Prisma calls in a friendly
  // error boundary. If the LLM (or a future programmatic caller) slips
  // an invalid value past Zod (defense-in-depth: shouldn't happen with
  // the PAIRS-tested enums, but the Slice 2 PROD bug taught us not to
  // leak raw Prisma invocation strings to the surface). Wraps as a
  // single Error with a stable user-facing message; the surface
  // renders this in the existing error block.
  let count: number;
  let sumResult: { _sum: { grandTotal: unknown } };
  try {
    [count, sumResult] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.order.aggregate({ where: orderWhere, _sum: { grandTotal: true } }),
    ]);
  } catch (err) {
    throw new Error(
      "Couldn't map part of that description to your data. Try rephrasing — for example, describe dormancy as 'no order in the last 90 days' instead of using a status word like 'churned'.",
      { cause: err },
    );
  }

  // Decimal columns arrive as Prisma's Decimal or as strings depending
  // on serialization. Coerce via Number() with NaN→0 fallback so a
  // missing aggregate (zero orders) renders as 0, not undefined.
  const rawSum = sumResult._sum.grandTotal;
  const historicalValueUsd =
    rawSum == null ? 0 : Number((rawSum as { toString(): string }).toString());

  return {
    count,
    isThin: count > 0 && count <= THIN_THRESHOLD,
    historicalValueUsd: Number.isFinite(historicalValueUsd) ? historicalValueUsd : 0,
  };
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
  | { field: 'lifecycleStage'; op: 'in'; values: ('lead'|'mql'|'sql'|'customer'|'lost')[] }
  | { field: 'segment'; op: 'in'; values: string[] }
  | { field: 'source'; op: 'in'; values: ('email_inbox'|'web_form'|'meta_ad'|'manual'|'csv_import'|'api'|'hubspot'|'stripe'|'shopify'|'other')[] }
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
- **Strict enum discipline (KAN-1000 fix-forward)**: \`lifecycleStage\` MUST be one of exactly \`'lead'|'mql'|'sql'|'customer'|'lost'\`. \`source\` MUST be one of exactly \`'email_inbox'|'web_form'|'meta_ad'|'manual'|'csv_import'|'api'|'hubspot'|'stripe'|'shopify'|'other'\`. **Never invent values like 'churned', 'dormant', 'inactive', 'opportunity'** — they don't exist in the schema.
- **Dormancy / churn semantics**: phrases like "churned", "dormant", "inactive", "win back" do NOT map to a lifecycleStage value. Map them to ORDERS RECENCY instead: \`{ field: 'orders.placedAt', op: 'between', fromUtc: '<old date>', toUtcExclusive: '<recent cutoff>' }\` for "ordered before but not recently", OR \`{ field: 'orders.exists', op: 'eq', value: false }\` for "never bought". If neither maps cleanly, return ambiguous and ask the user to define dormancy (e.g., "no order in 90 days?").
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

// ─────────────────────────────────────────────
// KAN-1001 Slice 3a — contact-ID materialization (read-only)
// ─────────────────────────────────────────────

export interface FindAudienceContactIdsInput {
  conditions: AudienceConditions;
  /** Hard cap on returned IDs. Sync materialization passes the
   *  MEMBERSHIP_SYNC_LIMIT; async worker passes a per-batch size. */
  limit: number;
  /** Pagination cursor (Contact.id of the last row from the previous
   *  page). Omit on first page. */
  cursorContactId?: string;
}

export interface FindAudienceContactIdsResult {
  contactIds: string[];
  /** True when `contactIds.length === limit` — caller paginates by
   *  passing the last id back as cursorContactId. */
  hasMore: boolean;
}

/**
 * KAN-1001 Slice 3a — return matched contact IDs (paginated).
 *
 * Same where-tree builder as `countAudience`; same tenant-scoping at the
 * outer level (cross-tenant isolation invariant preserved). Returns IDs
 * only (no projection of PII) — Slice 3a is INERT, so the caller writes
 * the IDs to CampaignMembership and that's the entire surface; no
 * decisioning, no sending, no LLM-grounding here.
 */
export async function findAudienceContactIds(
  prisma: AudiencePrisma,
  tenantId: string,
  input: FindAudienceContactIdsInput,
): Promise<FindAudienceContactIdsResult> {
  const conditions = AudienceConditionsSchema.parse(input.conditions);
  const innerWhere = conditionsToWhere(conditions);
  const where: Record<string, unknown> = {
    AND: [{ tenantId }, innerWhere],
  };

  const rows = await prisma.contact.findMany({
    where,
    select: { id: true },
    take: input.limit,
    orderBy: { id: 'asc' },
    ...(input.cursorContactId
      ? { cursor: { id: input.cursorContactId }, skip: 1 }
      : {}),
  });

  return {
    contactIds: rows.map((r) => r.id),
    hasMore: rows.length === input.limit,
  };
}

// ─────────────────────────────────────────────
// KAN-1000 Slice 2 — propose & preview (read-only)
// ─────────────────────────────────────────────

export interface ProposeInput {
  nl: string;
  todayUtc?: Date;
}

/**
 * KAN-1000 — System prompt for the full-proposal extractor. Receives
 * the tenant's actual objective catalog so the LLM picks by id (NEVER
 * invents). Encodes the 4 user-facing strategies (skips
 * escalate+wait control-flow values).
 */
export function buildProposeSystemPrompt(
  todayUtc: Date,
  objectiveCatalog: Array<{ id: string; name: string; type: string }>,
  audience: { count: number; historicalValueUsd: number; conditions: AudienceConditions },
): string {
  const todayIso = todayUtc.toISOString();
  const catalogJson = JSON.stringify(
    objectiveCatalog.map((o) => ({ id: o.id, name: o.name, type: o.type })),
    null,
    2,
  );
  return `You produce a complete campaign proposal in JSON, given:
  - a resolved audience (already counted)
  - the tenant's objective catalog
  - today's date

# Today
TODAY = ${todayIso}

# Resolved audience (from text-to-segment, already counted)
\`\`\`json
{
  "count": ${audience.count},
  "historicalValueUsd": ${audience.historicalValueUsd},
  "conditions": ${JSON.stringify(audience.conditions, null, 2)}
}
\`\`\`

# Tenant objective catalog (pick ONE by id; do not invent)
\`\`\`json
${catalogJson}
\`\`\`

# Strategy values (pick ONE)
- "direct"      — Direct Conversion (high-intent, push toward conversion)
- "re_engage"   — Re-engagement (win-back dormant/churned)
- "trust_build" — Trust Building (early-stage, at-risk)
- "guided"      — Guided Assistance (evaluating, educational)

# Output JSON schema

\`\`\`ts
type Output =
  | {
      kind: 'proposal';
      proposal: {
        name: string;                   // suggested campaign name (3-120 chars)
        windowStartUtc: string | null;  // ISO 8601 UTC; null = open-ended
        windowEndUtc: string | null;    // ISO 8601 UTC; null = open-ended
        objective: { id: string; name: string; type: string };  // copied from catalog
        strategy: 'direct' | 're_engage' | 'trust_build' | 'guided';
        proposedStages: Array<{ name: string; order: number; description: string }>;  // 1-8 stages
        firstActions: Array<{ day: number; channel: 'email'|'sms'|'whatsapp'; intent: string; description: string }>;  // 1-10 actions
      };
    }
  | { kind: 'ambiguous'; clarifyingQuestion: string };
\`\`\`

# Rules

- Objective MUST be one of the catalog rows above. Copy its \`id\`, \`name\`, \`type\` verbatim. Match the NL goal to the closest catalog \`type\` (e.g., "win-back dormant" → 'reactivate'; "book demo" → 'book_appointment'; "upsell premium" → 'upsell').
- Strategy MUST be one of the 4 values. "win-back" / "reactivate" / "dormant" → 're_engage'. "high-intent" / "convert now" → 'direct'. "trust" / "warm-up" → 'trust_build'. "educate" / "evaluate" → 'guided'.
- Propose 2-5 stages that suit the objective+strategy combo. Each stage: short name + 1-sentence description.
- Propose 1-5 first-actions (Day 0, Day 3, Day 7 style). Channels: email / sms / whatsapp.
- Window: extract from NL if specified ("over the next 30 days" → today to today+30); else null.
- Name: derive from NL — short, descriptive.
- If the NL is too ambiguous to map to a catalog objective, return \`{ kind: 'ambiguous', clarifyingQuestion: '...' }\` instead.

# Output

Respond with ONE JSON object, no prose, no markdown fences.`;
}

/**
 * Parse the LLM's propose response into the discriminated ProposeResult
 * (without count/historicalValueUsd — those are folded in by caller).
 */
function parseProposeOutput(
  text: string,
):
  | { kind: 'proposal'; raw: Omit<CampaignProposal, 'audience'> }
  | { kind: 'ambiguous'; clarifyingQuestion: string } {
  let s = text.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && fenceMatch[1]) s = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(
      `propose: LLM returned non-JSON output: ${(e as Error).message}`,
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
      throw new Error('propose: ambiguous output missing clarifyingQuestion');
    }
    return { kind: 'ambiguous', clarifyingQuestion: q };
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'kind' in parsed &&
    (parsed as { kind: unknown }).kind === 'proposal'
  ) {
    const proposalRaw = (parsed as { proposal?: unknown }).proposal;
    // Schema-validate everything except `audience` (filled in by caller).
    // We hand-roll the partial parse because CampaignProposalSchema
    // requires audience — wrap with a VALID leaf-condition stub we'll
    // immediately overwrite. Using { allOf: [] } would fail Zod's
    // min(1) on logical arrays.
    const stubbed: unknown = {
      ...(proposalRaw as Record<string, unknown>),
      audience: {
        conditions: { field: 'lifecycleStage', op: 'in', values: ['lead'] },
        count: 0,
        historicalValueUsd: 0,
      },
    };
    // Validate the strategy + structure via the full schema; we'll
    // strip the stubbed audience before returning.
    const validated = CampaignProposalSchema.parse(stubbed);
    // Defense-in-depth: confirm strategy is one of the 4 user-facing
    // values (CampaignStrategyEnum already enforces, double-check at
    // runtime in case Zod's discriminated union doesn't catch a
    // typo'd value the LLM emits).
    CampaignStrategyEnum.parse(validated.strategy);
    const { audience: _drop, ...withoutAudience } = validated;
    return { kind: 'proposal', raw: withoutAudience };
  }

  throw new Error(
    `propose: LLM output missing valid kind discriminator: ${s.slice(0, 200)}`,
  );
}

/**
 * Structured Cloud Logging line for the propose call. Mirrors the
 * text_to_segment log so accuracy review can query both via the
 * jsonPayload.type filter.
 */
function logProposeEvent(payload: {
  tenantId: string;
  nlInput: string;
  result: ProposeResult;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      type: 'campaign_propose',
      tenantId: payload.tenantId,
      nlInput: payload.nlInput,
      resultKind: payload.result.kind,
      proposal:
        payload.result.kind === 'proposal' || payload.result.kind === 'thin'
          ? payload.result.proposal
          : null,
      clarifyingQuestion:
        payload.result.kind === 'ambiguous' ? payload.result.clarifyingQuestion : null,
      model: payload.model,
      latencyMs: payload.latencyMs,
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
      callerTag: 'campaign:propose',
    }),
  );
}

/**
 * KAN-1000 — NL → full campaign proposal (read-only).
 *
 * Pipeline:
 *   1. Call textToSegment internally — resolves NL → conditions +
 *      count + historicalValueUsd
 *   2. If ambiguous → propagate honestly (no propose call attempted)
 *   3. Load tenant's active objective catalog
 *   4. Call LLM (tier=reasoning, callerTag='campaign:propose') with
 *      catalog + resolved audience in the system prompt
 *   5. Schema-validate + return discriminated ProposeResult
 *   6. Honest thin/zero handling propagates from audience count
 */
export async function proposeCampaign(
  prisma: AudiencePrisma,
  tenantId: string,
  input: ProposeInput,
  llm: LLMCompleteFn,
): Promise<ProposeResult> {
  const today = input.todayUtc ?? new Date();

  // Step 1: resolve audience via the Slice 1 pipeline.
  const segmentResult = await textToSegment(prisma, tenantId, input, llm);

  // Step 2: propagate ambiguous verbatim.
  if (segmentResult.kind === 'ambiguous') {
    return { kind: 'ambiguous', clarifyingQuestion: segmentResult.clarifyingQuestion };
  }

  // Step 3: load tenant's objective catalog (filtered to active).
  const catalog = await prisma.objective.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true, type: true },
    take: 50,
    orderBy: { createdAt: 'desc' },
  });

  if (catalog.length === 0) {
    // Tenant has no objectives — can't propose anything that maps to
    // a real catalog row. Honest signal: ask the user to declare an
    // objective first (Settings → Objectives sub-tab).
    return {
      kind: 'ambiguous',
      clarifyingQuestion:
        'No objectives defined for this tenant yet. Open Settings → Objectives and declare at least one before proposing a campaign.',
    };
  }

  // Step 4: propose call with audience + catalog context.
  const audience = {
    conditions: segmentResult.conditions,
    count: segmentResult.count,
    historicalValueUsd: 0, // refined below — textToSegment doesn't compute this
  };

  // Re-run countAudience to get historicalValueUsd (textToSegment only
  // returns count). Cheap re-query — same tenant-scoped WHERE; both
  // queries hit indexes.
  const countWithValue = await countAudience(prisma, tenantId, {
    conditions: segmentResult.conditions,
  });
  audience.historicalValueUsd = countWithValue.historicalValueUsd;

  const systemPrompt = buildProposeSystemPrompt(today, catalog, audience);

  const llmResponse = await llm({
    tenantId,
    tier: 'reasoning',
    systemPrompt,
    userPrompt: input.nl,
    callerTag: 'campaign:propose',
    jsonMode: true,
    maxTokens: 3000,
  });

  const parsed = parseProposeOutput(llmResponse.text);

  let result: ProposeResult;
  if (parsed.kind === 'ambiguous') {
    result = { kind: 'ambiguous', clarifyingQuestion: parsed.clarifyingQuestion };
  } else {
    const fullProposal: CampaignProposal = {
      ...parsed.raw,
      audience: {
        conditions: segmentResult.conditions,
        count: countWithValue.count,
        historicalValueUsd: countWithValue.historicalValueUsd,
      },
    };

    // Honesty: if the resolved audience is thin/zero, mark the proposal
    // result as thin — surface uses the same amber treatment as the
    // textToSegment thin path.
    if (countWithValue.count === 0) {
      result = {
        kind: 'thin',
        proposal: fullProposal,
        message: 'No contacts match this segment. The proposal is for reference only.',
      };
    } else if (countWithValue.isThin) {
      result = {
        kind: 'thin',
        proposal: fullProposal,
        message: `Only ${countWithValue.count} ${countWithValue.count === 1 ? 'contact matches' : 'contacts match'}. The proposal will reach a small segment.`,
      };
    } else {
      result = {
        kind: 'proposal',
        proposal: fullProposal,
        message: `${countWithValue.count.toLocaleString('en-US')} contacts match.`,
      };
    }
  }

  logProposeEvent({
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
