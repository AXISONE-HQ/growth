/**
 * KAN-1018 — error classifier for the decision-run-push retry/DLQ
 * decision point. Replaces the interim catch-all-ack from PR #217 with
 * a typed persistent-vs-transient categorization so:
 *
 *   - PERSISTENT (schema/validation/code/4xx — retry cannot help):
 *     handler acks 200 + explicitly publishes to decision.run.dlq +
 *     does NOT retry. Bounds persistent-error storms to ONE attempt.
 *
 *   - TRANSIENT (network/timeout/5xx/rate-limit — retry might help):
 *     handler returns non-200 so Pub/Sub auto-retries (up to
 *     maxDeliveryAttempts=5, GCP floor — can't go lower). Cap-bounded
 *     by the per-tenant daily counter (A2: increment-in-finally even
 *     on throw — see decision-run-push.ts).
 *
 * Default for UNKNOWN errors: persistent (fail-safe — never auto-storm
 * something we don't recognize).
 *
 * Classification is pattern-based on:
 *   1. Constructor name (ZodError, PrismaClientKnownRequestError, …)
 *   2. Prisma-error `.code` field (P10xx network/connection,
 *      P20xx data/constraint)
 *   3. TRPCError `.code` field (BAD_REQUEST → persistent,
 *      INTERNAL_SERVER_ERROR → transient unless cause is persistent)
 *   4. HTTP status codes inferred from message (4xx persistent,
 *      5xx/429/408 transient)
 *   5. Network error codes (ECONNRESET, ETIMEDOUT, etc.)
 *   6. Message-text patterns for last-resort classification (timeout,
 *      overload, rate.?limit → transient; parse, invalid, schema →
 *      persistent)
 */

export type ErrorCategory = 'persistent' | 'transient';

export interface ClassifiedError {
  category: ErrorCategory;
  /** Stable identifier for the matched rule — for structured logs +
   *  metrics + tests. Examples: 'zod_parse', 'prisma_p2002',
   *  'prisma_p1001', 'trpc_not_found', 'http_503', 'enotfound',
   *  'msg_timeout', 'unknown_fail_safe'. */
  reasonCode: string;
}

// Prisma error code prefixes / specifics
// (https://www.prisma.io/docs/orm/reference/error-reference)
const PRISMA_TRANSIENT_CODES = new Set([
  'P1001', // Can't reach database server
  'P1002', // Database server timed out
  'P1008', // Operations timed out
  'P1011', // TLS error
  'P1017', // Server has closed the connection
]);

// TRPC error codes (https://trpc.io/docs/server/error-handling)
const TRPC_PERSISTENT_CODES = new Set([
  'PARSE_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'METHOD_NOT_SUPPORTED',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_CONTENT',
]);
const TRPC_TRANSIENT_CODES = new Set([
  'TIMEOUT',
  'TOO_MANY_REQUESTS',
  'CLIENT_CLOSED_REQUEST',
  'INTERNAL_SERVER_ERROR', // recoverable retry candidate; specific causes can override
]);

// Network-level error codes (Node.js libuv / dns)
const NETWORK_TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENOTFOUND', // could be persistent (typo) but more often a DNS blip — treat as transient
]);

// Message-text patterns (last-resort, case-insensitive). Order matters:
// transient patterns checked first so an error message containing both
// "timeout" (transient signal) AND "validation" (persistent signal) lands
// in transient — recovery via retry is at least possible. Pure-persistent
// signals like "Zod" / "parse" still classify persistent.
const MSG_TRANSIENT_PATTERNS: RegExp[] = [
  /\btimeout\b/i,
  /\btimed?\s?out\b/i,
  /overload(ed)?/i, // matches "overloaded_error" (Anthropic) — no \b: underscores aren't word breaks
  /\brate.?limit/i,
  /\bservice\s+unavailable\b/i,
  /\bbad\s+gateway\b/i,
  /\b(50[0-9]|429|408)\b/, // 5xx + 429 + 408 status codes in message
  /\bECONN(REFUSED|RESET|ABORTED)\b/i,
  /\bENETUNREACH\b/i,
  /\bEAI_AGAIN\b/i,
];
const MSG_PERSISTENT_PATTERNS: RegExp[] = [
  /\bzod\b/i,
  /\bparse\b/i,
  /\binvalid\s+(type|enum|input|value|field)/i,
  /\bschema\b/i,
  /\bunknown\s+(field|argument|property)/i,
  /\bunique\s+constraint\b/i,
  /\bforeign\s+key/i,
  /\bnot\s+found\b/i,
  /\bcannot\s+read\s+propert/i, // TypeError "cannot read properties of undefined"
];

function getErrorName(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const ctor = (err as { constructor?: { name?: string } }).constructor;
  if (ctor?.name) return ctor.name;
  const name = (err as { name?: string }).name;
  if (typeof name === 'string') return name;
  return undefined;
}

function getErrorMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

function getErrorCode(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  if (typeof code === 'number') return String(code);
  return undefined;
}

export function classifyError(err: unknown): ClassifiedError {
  const name = getErrorName(err);
  const message = getErrorMessage(err);
  const code = getErrorCode(err);

  // ── 1. Constructor-name dispatch ────────────────────────────────────
  if (name === 'ZodError') {
    return { category: 'persistent', reasonCode: 'zod_parse' };
  }
  if (name === 'TypeError') {
    // Programming error — retry can't help. The "cannot read properties of
    // undefined" classic that surfaced as bugs #4-#7 in M1 smoke.
    return { category: 'persistent', reasonCode: 'type_error' };
  }
  if (name === 'SyntaxError') {
    return { category: 'persistent', reasonCode: 'syntax_error' };
  }
  if (name === 'PrismaClientValidationError') {
    return { category: 'persistent', reasonCode: 'prisma_validation' };
  }
  if (name === 'PrismaClientKnownRequestError') {
    if (code && PRISMA_TRANSIENT_CODES.has(code)) {
      return { category: 'transient', reasonCode: `prisma_${code.toLowerCase()}` };
    }
    // All other P-codes (P20xx data/constraint, P30xx migration) are
    // persistent — retrying a unique-constraint violation always fails.
    return { category: 'persistent', reasonCode: `prisma_${(code ?? 'unknown').toLowerCase()}` };
  }
  if (name === 'PrismaClientRustPanicError' || name === 'PrismaClientInitializationError') {
    // Init-fail = environment problem (could be transient at boot, e.g.
    // DB not ready). Rust-panic = bug in Prisma engine, often recovers.
    return { category: 'transient', reasonCode: 'prisma_init_panic' };
  }
  if (name === 'TRPCError') {
    if (code && TRPC_PERSISTENT_CODES.has(code)) {
      return { category: 'persistent', reasonCode: `trpc_${code.toLowerCase()}` };
    }
    if (code && TRPC_TRANSIENT_CODES.has(code)) {
      return { category: 'transient', reasonCode: `trpc_${code.toLowerCase()}` };
    }
    // Unknown TRPC code → fail-safe persistent
    return { category: 'persistent', reasonCode: `trpc_${(code ?? 'unknown').toLowerCase()}` };
  }

  // ── 2. Node.js libuv / network codes ────────────────────────────────
  if (code && NETWORK_TRANSIENT_CODES.has(code)) {
    return { category: 'transient', reasonCode: code.toLowerCase() };
  }

  // ── 3. HTTP status (from .status, .statusCode, or .response.status) ─
  const httpStatus = (() => {
    if (err == null || typeof err !== 'object') return undefined;
    const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    const s = e.status ?? e.statusCode ?? e.response?.status;
    if (typeof s === 'number') return s;
    if (typeof s === 'string' && /^\d+$/.test(s)) return parseInt(s, 10);
    return undefined;
  })();
  if (httpStatus !== undefined) {
    if (httpStatus >= 500 || httpStatus === 429 || httpStatus === 408) {
      return { category: 'transient', reasonCode: `http_${httpStatus}` };
    }
    if (httpStatus >= 400) {
      return { category: 'persistent', reasonCode: `http_${httpStatus}` };
    }
    // 2xx/3xx as an "error" — odd shape, treat as persistent fail-safe
    return { category: 'persistent', reasonCode: `http_${httpStatus}` };
  }

  // ── 4. Message-text patterns (last-resort, transient checked first) ─
  for (const pattern of MSG_TRANSIENT_PATTERNS) {
    if (pattern.test(message)) {
      return { category: 'transient', reasonCode: 'msg_transient_pattern' };
    }
  }
  for (const pattern of MSG_PERSISTENT_PATTERNS) {
    if (pattern.test(message)) {
      return { category: 'persistent', reasonCode: 'msg_persistent_pattern' };
    }
  }

  // ── 5. Fail-safe default: persistent ────────────────────────────────
  // Unknown error class → don't auto-storm. The DLQ consumer surfaces it
  // for human triage. If a recurring unknown error is actually transient,
  // adding a pattern to MSG_TRANSIENT_PATTERNS or NETWORK_TRANSIENT_CODES
  // flips it; the test matrix at __tests__/error-classifier.test.ts is
  // table-driven so adding the case is one line.
  return { category: 'persistent', reasonCode: 'unknown_fail_safe' };
}
