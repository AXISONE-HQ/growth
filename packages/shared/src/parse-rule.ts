/**
 * KAN-1140 Phase 3 PR 9a — Tenant parser customization rule schema.
 *
 * Hoisted to @growth/shared per Memo 37 — both apps/api (this PR's tRPC
 * validators) AND packages/api (PR 9a's lifecycle service) AND the future
 * PR 9b rule executor (which will run in packages/api lead-normalizer)
 * import from this single source. Algorithm drift across workspaces would
 * silently bypass safety locks; single source eliminates the class.
 *
 * # Security locks (immovable per Senior PO Phase 1 directive)
 *
 *   - Q1: Declarative-only. Rules are JSON path + regex + named transforms.
 *         NO operator-supplied code execution. NO JavaScript / Python / DSL
 *         with arbitrary computation. Pure data operations.
 *   - Q3: NO sandbox execution model. vm2, isolated-vm, pyodide are
 *         out-of-scope. Pure declarative evaluation only.
 *   - Q10: Mandatory limits. ReDoS-safe regex (safe-regex2 validator); path
 *          traversal whitelist (no `..` recursive descent); per-tenant rule
 *          count cap; writable field allow-list.
 *
 * # Defense-in-depth
 *
 * Validators run at create-time (this Zod schema) AND at execution-time
 * (PR 9b will re-validate before applying any rule). Both layers reject the
 * same patterns. A rule body that bypasses one layer still bounces off the
 * other.
 *
 * # Allow-list rationale (PARSE_RULE_WRITABLE_FIELDS)
 *
 * Rules can only write to a tightly-bounded set of canonical Contact/Deal
 * fields. This defends against:
 *
 *   - Schema-breaking writes (rule trying to write `id` / `tenantId` etc.)
 *   - Engine-load-bearing field corruption (rule writing `extractionConfidence`
 *     or similar internal state)
 *   - Audit trail bypass (rule writing through to fields not flagged in the
 *     wire metadata)
 *
 * The list mirrors the canonical `ExtractedFields` shape from
 * `packages/api/src/services/lead-normalizer.ts` — anything Haiku can
 * extract, a rule can extract. Nothing more.
 */
import { z } from "zod";
import safeRegex from "safe-regex2";

/**
 * Fields a parse rule may write to. Subset of the canonical
 * `ExtractedFields` shape in lead-normalizer.ts. Validated on the rule
 * body itself (field selector) AND on the rule output at execution time
 * (PR 9b).
 *
 * `intentSummary` is included but PR 9b execution should mark
 * `metadata.kan_1140_rule_set_intentSummary: true` when set, so the Brain
 * can correlate rule-derived vs LLM-derived intent. KAN-1153 follow-up
 * for the Brain-correlation telemetry.
 */
export const PARSE_RULE_WRITABLE_FIELDS = [
  "firstName",
  "lastName",
  "companyName",
  "phone",
  "intentSummary",
] as const;
export type ParseRuleWritableField = (typeof PARSE_RULE_WRITABLE_FIELDS)[number];

/**
 * Named transforms operators can apply to extracted values. Each transform
 * is pure data — no side effects, no I/O.
 *
 *   - `trim`      — strip leading/trailing whitespace
 *   - `lowercase` — Unicode-aware lowercase
 *   - `uppercase` — Unicode-aware uppercase
 *   - `splitN`    — split on whitespace; take Nth token (N = transform arg
 *                   placeholder; PR 9b executor parses the arg from a
 *                   future shape extension — for 9a substrate, just an
 *                   identifier in the allow-list)
 */
export const PARSE_RULE_TRANSFORMS = ["trim", "lowercase", "uppercase", "splitN"] as const;
export type ParseRuleTransform = (typeof PARSE_RULE_TRANSFORMS)[number];

/**
 * JSON path syntax whitelist. Explicitly excludes `..` recursive descent
 * (path traversal exploit vector) and `*` wildcard (unbounded selectors).
 *
 * Accepts:
 *   - `$.foo`            — root then named segment
 *   - `$.foo.bar`        — nested named segments
 *   - `$.foo[0]`         — indexed array access
 *   - `$.foo["bar-baz"]` — quoted named segment (supports hyphens/quotes)
 *   - `$.foo-bar.baz_qux`— hyphens + underscores in segment names
 *
 * Rejects:
 *   - `$..foo`           — recursive descent (PATH TRAVERSAL VECTOR)
 *   - `$.foo.*`          — wildcard segment
 *   - `$.foo[*]`         — wildcard index
 *   - `$`                — root alone (must have at least one segment)
 *   - `$.foo[?(@.x)]`    — filter expressions
 *   - `$.foo()`          — function calls
 */
const SAFE_JSON_PATH_REGEX = /^\$(\.[\w-]+|\[\d+\]|\["[\w-]+"\])+$/;

export function isSafeJsonPath(path: string): boolean {
  return SAFE_JSON_PATH_REGEX.test(path);
}

/**
 * ReDoS-safe regex validator. Wraps `safe-regex2` (npm) — a known-good
 * implementation that rejects patterns with catastrophic-backtracking risk
 * via star-height analysis.
 *
 * Rejects:
 *   - Nested quantifiers: `(a+)+`, `(a*)*`, `(a+)*`, `(.*)*`
 *   - Alternation with overlap inside repetition: `(a|aa)+`, `(a|a)*`
 *
 * Accepts simple linear patterns, character classes with quantifiers,
 * anchored patterns, etc.
 *
 * Defense-in-depth: PR 9b executor SHOULD ALSO wrap execution in an
 * AbortController with 50ms per-rule CPU budget. This validator catches
 * known unsafe shapes at create time; the runtime budget catches anything
 * the static analyzer misses.
 */
export function isSafeRegex(pattern: string): boolean {
  return safeRegex(pattern);
}

// ─────────────────────────────────────────────
// Rule body schema (Zod)
// ─────────────────────────────────────────────

const TransformSchema = z.enum(PARSE_RULE_TRANSFORMS);

/**
 * Extractor — produces a value from the inbound payload.
 *
 * Two variants:
 *   - jsonPath: dereferences a path into the structured payload
 *   - regex:    matches the configured regex against the text body and
 *               returns the Nth capture group (0 = full match)
 */
const ExtractorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("jsonPath"),
    path: z
      .string()
      .min(1)
      .max(200)
      .refine(isSafeJsonPath, { message: "unsafe JSON path syntax" }),
    transforms: z.array(TransformSchema).max(5).optional(),
  }),
  z.object({
    type: z.literal("regex"),
    pattern: z
      .string()
      .min(1)
      .max(500)
      .refine(isSafeRegex, {
        message: "regex has catastrophic-backtracking risk (ReDoS)",
      }),
    captureGroup: z.number().int().min(0).max(20).default(0),
    transforms: z.array(TransformSchema).max(5).optional(),
  }),
]);

/**
 * Per-field extractor — binds an Extractor to a writable field name.
 */
const FieldExtractorSchema = z.object({
  field: z.enum(PARSE_RULE_WRITABLE_FIELDS),
  extractor: ExtractorSchema,
});

/**
 * Full rule body — array of field extractors. Bounded count: 1..20.
 *
 * Multiple extractors writing to the same field is allowed; PR 9b's
 * executor enforces first-non-null wins per field (defines determinism).
 */
export const ParseRuleBodySchema = z.object({
  extractors: z.array(FieldExtractorSchema).min(1).max(20),
});

export type ParseRuleBody = z.infer<typeof ParseRuleBodySchema>;

// ─────────────────────────────────────────────
// Safety locks (Q10)
// ─────────────────────────────────────────────

/**
 * Maximum rules per tenant. Hard cap; enforced at create time in
 * `createParseRule`. Performance-DoS mitigation.
 *
 * 100 is empirical-comfortable: at 20 extractors per rule × 100 rules =
 * 2000 extractors per tenant. Even with all running per inbound, the
 * total-pipeline 250ms budget (PR 9b) bounds the worst case at ~125us
 * per extractor — generous for declarative evaluation.
 *
 * Raise via KAN follow-up if a tenant credibly needs more.
 */
export const MAX_RULES_PER_TENANT = 100;

/**
 * Rule lifecycle vocabulary (mirrors ParseFingerprint.supportStatus +
 * Action.status convention — text column, documented vocabulary, NOT a
 * Prisma enum type).
 */
export const PARSE_RULE_STATUSES = ["pending", "active", "disabled"] as const;
export type ParseRuleStatus = (typeof PARSE_RULE_STATUSES)[number];
