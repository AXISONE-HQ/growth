/**
 * KAN-1140 Phase 3 PR 9b — Parse rule executor.
 *
 * Runtime enforcement of the security locks codified in PR 9a's validators.
 * Per Phase 1 Q-ADD-EXEC-VS-NORMALIZE lock: executor called inline from
 * `normalizeInboundEmail` (Y) — caller contract unchanged.
 *
 * # Security posture (runtime side of PR 9a's create-time validators)
 *
 *   - Q1 declarative-only — runtime inputs gated to `jsonPath` | `regex`;
 *     no code paths can execute operator-supplied JavaScript
 *   - Q3 no sandbox — pure data operations; no vm2/isolated-vm needed
 *   - Q10 mandatory safety:
 *     - Total pipeline budget (`PIPELINE_BUDGET_MS = 250`) enforced via
 *       elapsed-time check between rules
 *     - Per-rule timeout (`PER_RULE_BUDGET_MS = 50`) wraps each extractor
 *       in `Promise.race` with `setTimeout`
 *     - Tenant assertion: `rule.tenantId === input.tenantId` rejected at
 *       executor entry (defense-in-depth — getApplicableRules also filters)
 *     - Failure isolation: per-rule try/catch; throw → skip + continue
 *     - Output validation: extracted values are strings (regex match) or
 *       JSON-traversal results coerced to string; null on mismatch
 *
 * # Honest limitation — sync regex timeout
 *
 * JavaScript's native `RegExp.match` is synchronous and cannot be aborted
 * mid-execution. `Promise.race([regexPromise, timeoutPromise])` provides
 * structural ceremony but does NOT actually halt a regex stuck in
 * catastrophic backtracking — the timeout resolves AFTER the regex
 * completes (or never, if the regex is stuck and blocks the event loop).
 *
 * The REAL ReDoS defense is `safe-regex2` validation at rule-create time
 * (PR 9a). The runtime timeout protects against:
 *
 *   1. Multi-step extractor chains (transforms run between regex and
 *      result; timeout fires between)
 *   2. Future async transforms (per-rule budget bounds them)
 *   3. Post-execution telemetry (we KNOW we exceeded budget; can decide
 *      not to start more rules)
 *
 * The between-rules pipeline-budget check (`Date.now() - startTime > BUDGET`)
 * is the load-bearing runtime safety mechanism for ReDoS.
 *
 * # Cascade resolution algorithm (Q2 lock)
 *
 * Per-field winning rule selected by:
 *   1. Specificity score (most-specific wins):
 *      - fingerprint-scoped: 4
 *      - format + vendor: 3
 *      - format only: 2
 *      - vendor only: 2
 *      - global (all null): 1
 *   2. Tie-breaker: `createdAt` ascending (older wins) — operators
 *      don't get a manual priority field in PR 9b
 *
 * Same rule can win for multiple fields (its body's extractors map to
 * different `field` values); each field decision is independent.
 *
 * # Memo discipline
 *
 *   - Memo 32 — outer try/catch at `normalizeInboundEmail` call site is
 *     the load-bearing failure-isolation invariant; this module's
 *     `executeRules` must not throw under normal conditions (only
 *     cross-tenant assertion throws as a defense-in-depth signal)
 *   - Memo 37 — safe-path traversal stays here (packages/api) rather
 *     than packages/shared because future transforms may need PrismaClient
 *     access; pure-function helpers (path-syntax + regex safety) already
 *     in packages/shared
 *   - Memo 38 — PR 9b LoC includes per-rule scaffolding (cascade,
 *     transform, timeout, audit) compounding the +100% buffer
 */
import { ParseRuleBodySchema, PARSE_RULE_WRITABLE_FIELDS } from "@growth/shared";

export const PIPELINE_BUDGET_MS = 250;
export const PER_RULE_BUDGET_MS = 50;

/**
 * Subset of `ParseRule` shape the executor needs. Defined here (not
 * imported from Prisma) so unit tests can construct fake rules without
 * a full ParseRule type. Matches the Prisma row shape at the field level
 * — getApplicableRules returns rows that satisfy this.
 */
export interface ExecutableRule {
  id: string;
  tenantId: string;
  fingerprintId: string | null;
  format: string | null;
  vendor: string | null;
  body: unknown; // Validated against ParseRuleBodySchema at execution time
  status: string;
  createdAt: Date;
}

export interface ExecuteRulesInput {
  tenantId: string;
  rules: ExecutableRule[];
  payload: {
    fromAddress: string;
    subject?: string | null;
    bodyPreview?: string | null;
    /**
     * Optional raw structured payload — when present, jsonPath extractors
     * traverse this. Webhooks publishing structured vendor JSON should
     * thread it here. Absent → jsonPath extractors always return null.
     */
    structured?: Record<string, unknown> | null;
  };
}

export interface ExecuteRulesMetrics {
  rulesEvaluated: number;
  fieldsWritten: number;
  rulesThrown: number;
  rulesTimedOut: number;
  pipelineBudgetExceeded: boolean;
  totalDurationMs: number;
}

export interface ExecuteRulesResult {
  /**
   * Field → extracted value. Only fields successfully extracted by at
   * least one rule appear here. Caller merges into the canonical
   * `ExtractedFields` shape (operator > rule > Haiku > null).
   */
  output: Partial<Record<(typeof PARSE_RULE_WRITABLE_FIELDS)[number], string>>;
  metrics: ExecuteRulesMetrics;
}

// ─────────────────────────────────────────────
// JSON path traversal (Q4 + Q-ADD-EXEC-LIB lock — custom, no jsonpath-plus)
// ─────────────────────────────────────────────

/**
 * Whitelist-enforced JSON path traversal. Accepts the same syntax as
 * `isSafeJsonPath` in `@growth/shared`:
 *
 *   $.foo                — root + named segment
 *   $.foo.bar            — nested named segments
 *   $.foo[0]             — indexed array
 *   $.foo["bar-baz"]     — quoted named segment
 *
 * Returns the value at the path coerced to string, OR null if:
 *   - Path doesn't resolve (intermediate undefined/null)
 *   - Path resolves to non-primitive (object/array → null)
 *   - Path resolves to null/undefined
 *
 * NOT exposed for path-syntax validation — that lives at create time
 * via `isSafeJsonPath` in `@growth/shared`. This function trusts that
 * paths reaching it have already passed validation. Defense-in-depth:
 * if a malformed path arrives anyway, the parsing loop returns null
 * rather than throwing.
 */
export function traverseJsonPath(obj: unknown, path: string): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  if (!path.startsWith("$")) return null;

  const segments: Array<{ kind: "name" | "index"; value: string | number }> = [];
  let i = 1; // Skip the `$`
  while (i < path.length) {
    if (path[i] === ".") {
      i++;
      const start = i;
      while (i < path.length && path[i] !== "." && path[i] !== "[") i++;
      const name = path.slice(start, i);
      if (name.length === 0) return null;
      segments.push({ kind: "name", value: name });
    } else if (path[i] === "[") {
      i++;
      if (path[i] === '"') {
        i++;
        const start = i;
        while (i < path.length && path[i] !== '"') i++;
        const name = path.slice(start, i);
        if (i >= path.length) return null;
        i++; // Skip closing quote
        if (path[i] !== "]") return null;
        i++;
        segments.push({ kind: "name", value: name });
      } else {
        const start = i;
        while (i < path.length && path[i] !== "]") i++;
        const idx = Number.parseInt(path.slice(start, i), 10);
        if (!Number.isFinite(idx)) return null;
        i++; // Skip ]
        segments.push({ kind: "index", value: idx });
      }
    } else {
      return null;
    }
  }

  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    if (seg.kind === "name") {
      current = (current as Record<string, unknown>)[seg.value as string];
    } else {
      if (!Array.isArray(current)) return null;
      current = current[seg.value as number];
    }
  }
  if (current === null || current === undefined) return null;
  if (typeof current === "object") return null;
  return String(current);
}

// ─────────────────────────────────────────────
// Transforms (Q4 — named dispatch table; no operator-supplied code)
// ─────────────────────────────────────────────

function applyTransforms(value: string, transforms: readonly string[] | undefined): string {
  if (!transforms) return value;
  let result = value;
  for (const t of transforms) {
    if (t === "trim") result = result.trim();
    else if (t === "lowercase") result = result.toLowerCase();
    else if (t === "uppercase") result = result.toUpperCase();
    else if (t === "splitN") {
      // splitN: split on whitespace, take first token. PR 9b minimal
      // semantics; future arg-bearing form deferred to KAN follow-up.
      const tokens = result.split(/\s+/).filter((s) => s.length > 0);
      result = tokens[0] ?? "";
    }
    // Unknown transforms ignored (defense-in-depth — PR 9a validator
    // already rejects non-allow-list transforms at create time).
  }
  return result;
}

// ─────────────────────────────────────────────
// Extractor application (regex / jsonPath)
// ─────────────────────────────────────────────

/**
 * Apply a single extractor to the payload with per-rule timeout. Returns
 * the extracted string OR null on no-match. Throws on timeout (caller
 * wraps in try/catch).
 *
 * # Sync-regex timeout caveat (re-stated)
 *
 * The Promise.race ceremony does not abort a sync RegExp.match stuck in
 * catastrophic backtracking. The static analyzer (safe-regex2 in PR 9a)
 * is the actual ReDoS defense. The runtime structure here protects
 * against post-completion late timeouts + bounds the "we know we are
 * past budget" decision.
 */
async function applyExtractor(
  extractor: unknown,
  payload: ExecuteRulesInput["payload"],
): Promise<string | null> {
  const work = (): string | null => {
    if (typeof extractor !== "object" || extractor === null) return null;
    const ext = extractor as Record<string, unknown>;
    if (ext.type === "jsonPath") {
      const path = ext.path as string;
      const raw = traverseJsonPath(payload.structured ?? {}, path);
      if (raw === null) return null;
      return applyTransforms(raw, ext.transforms as readonly string[] | undefined);
    }
    if (ext.type === "regex") {
      const pattern = ext.pattern as string;
      const captureGroup = (ext.captureGroup as number) ?? 0;
      // Build a text corpus from the payload (subject + bodyPreview).
      // Operators reference the corpus implicitly via their regex.
      const corpus = [payload.subject ?? "", payload.bodyPreview ?? ""]
        .filter((s) => s.length > 0)
        .join("\n");
      if (corpus.length === 0) return null;
      const re = new RegExp(pattern);
      const m = corpus.match(re);
      if (!m) return null;
      const captured = m[captureGroup];
      if (captured === undefined) return null;
      return applyTransforms(captured, ext.transforms as readonly string[] | undefined);
    }
    return null;
  };

  // Promise.race ceremony — see file-level comment for sync-regex caveat.
  const workPromise = new Promise<string | null>((resolve, reject) => {
    try {
      resolve(work());
    } catch (err) {
      reject(err);
    }
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<string | null>((_, reject) => {
    timer = setTimeout(() => reject(new Error("rule timeout")), PER_RULE_BUDGET_MS);
  });
  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────
// Cascade resolution (Q2 lock — specificity score + createdAt tie-breaker)
// ─────────────────────────────────────────────

function specificity(rule: ExecutableRule): number {
  if (rule.fingerprintId !== null) return 4;
  if (rule.format !== null && rule.vendor !== null) return 3;
  if (rule.format !== null) return 2;
  if (rule.vendor !== null) return 2;
  return 1;
}

/**
 * Select winning rule for a given field. Walks all rules, filters to
 * those with an extractor for the field, sorts by specificity DESC then
 * createdAt ASC, returns the head OR null.
 *
 * Exported for unit tests.
 */
export function selectRuleForField(
  rules: ExecutableRule[],
  field: string,
): ExecutableRule | null {
  const applicable = rules.filter((r) => {
    const body = r.body as { extractors?: Array<{ field: string }> } | null;
    if (!body || !Array.isArray(body.extractors)) return false;
    return body.extractors.some((e) => e.field === field);
  });
  if (applicable.length === 0) return null;
  applicable.sort((a, b) => {
    const sa = specificity(a);
    const sb = specificity(b);
    if (sa !== sb) return sb - sa;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return applicable[0];
}

// ─────────────────────────────────────────────
// Main entry: executeRules
// ─────────────────────────────────────────────

/**
 * Execute applicable rules against the inbound payload. Returns extracted
 * field values + execution metrics. Never throws under normal conditions
 * (only cross-tenant assertion throws as defense-in-depth).
 *
 * Caller (normalizeInboundEmail) wraps the call in outer try/catch per
 * Memo 32 family discipline. Outer catch handles catastrophic executor
 * bugs (e.g., an uncaught throw from cascade selection); falls back to
 * Haiku-only path.
 */
export async function executeRules(input: ExecuteRulesInput): Promise<ExecuteRulesResult> {
  // Cross-tenant defense-in-depth assertion (Q10 threat coverage).
  // getApplicableRules already filters by tenantId; this is the belt-and-
  // suspenders layer. Throws so caller's outer try/catch logs the breach.
  for (const rule of input.rules) {
    if (rule.tenantId !== input.tenantId) {
      throw new Error(
        `parse-rule-executor: cross-tenant rule leakage detected — rule.tenantId=${rule.tenantId} input.tenantId=${input.tenantId} ruleId=${rule.id}`,
      );
    }
  }

  const startTime = Date.now();
  const output: Partial<Record<(typeof PARSE_RULE_WRITABLE_FIELDS)[number], string>> = {};
  const metrics: ExecuteRulesMetrics = {
    rulesEvaluated: 0,
    fieldsWritten: 0,
    rulesThrown: 0,
    rulesTimedOut: 0,
    pipelineBudgetExceeded: false,
    totalDurationMs: 0,
  };

  for (const field of PARSE_RULE_WRITABLE_FIELDS) {
    // Total pipeline budget check (the load-bearing runtime safety per
    // file-level comment — sync-regex timeout is ceremonial).
    if (Date.now() - startTime > PIPELINE_BUDGET_MS) {
      metrics.pipelineBudgetExceeded = true;
      break;
    }

    const winningRule = selectRuleForField(input.rules, field);
    if (!winningRule) continue;

    metrics.rulesEvaluated++;
    try {
      // Defense-in-depth: re-validate the rule body at execution time.
      // PR 9a validates at create-time; this guards against schema drift
      // OR direct-SQL rule insertions that bypassed the service layer.
      const parsed = ParseRuleBodySchema.parse(winningRule.body);
      const extractor = parsed.extractors.find((e) => e.field === field)?.extractor;
      if (!extractor) continue;

      const value = await applyExtractor(extractor, input.payload);
      if (value !== null && value.length > 0) {
        output[field] = value;
        metrics.fieldsWritten++;
      }
    } catch (err) {
      // Skip-on-throw per Q5 lock. Distinguish timeout from other throws
      // for telemetry. Lead-first invariant: rule failure never stops
      // the pipeline (outer normalizer falls back to Haiku).
      if (err instanceof Error && err.message === "rule timeout") {
        metrics.rulesTimedOut++;
      } else {
        metrics.rulesThrown++;
      }
    }
  }

  metrics.totalDurationMs = Date.now() - startTime;
  return { output, metrics };
}

/**
 * Check whether the rule output covers all 5 rule-writable fields.
 * Per Addendum B: `qualificationSignals` is NOT in the allow-list, so
 * "all covered" means firstName + lastName + companyName + phone +
 * intentSummary all have non-empty string values.
 *
 * Used by `normalizeInboundEmail` to decide the Haiku short-circuit
 * (per Q7 + Q-ADD-3: short-circuit only when allCovered AND fingerprint
 * supportStatus === 'supported').
 */
export function isAllFieldsCovered(
  output: Partial<Record<(typeof PARSE_RULE_WRITABLE_FIELDS)[number], string>>,
): boolean {
  return PARSE_RULE_WRITABLE_FIELDS.every((f) => {
    const v = output[f];
    return typeof v === "string" && v.length > 0;
  });
}
