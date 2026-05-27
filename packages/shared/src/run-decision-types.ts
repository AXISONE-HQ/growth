/**
 * KAN-1005 M2-4 follow-up — canonical run-decision input types.
 *
 * Single source of truth for the `runDecisionForContact` input shape.
 * Both the implementation (packages/api/src/services/run-decision-for-
 * contact.ts) and the dynamic-import caller (apps/api/src/subscribers/
 * decision-run-push.ts) import from here, so a field added on one side
 * but missing on the other becomes a TS error — not a silent runtime
 * field-drop at the boundary.
 *
 * Why this file exists (the class):
 *
 *   apps/api can't statically import from packages/api/src/* (KAN-689
 *   TS6059 cohort — `rootDir` boundary). The variable-specifier dynamic
 *   import pattern (`await import(spec)` with non-literal spec) works
 *   around that at runtime, but the type for the dynamically-imported
 *   module has to be hand-declared on the apps/api side. That hand-
 *   declaration has drifted from the real interface THREE times now:
 *
 *     1. cast-loose Prisma access — `(prisma as any).model?.findX`
 *     2. KAN-1005 M2-6b — synthetic `dec_<uuid>` decisionId silently
 *        FK-violated when the engine actually dispatched
 *     3. KAN-1005 M2-4 — `breakerState` declared on apps/api side,
 *        absent from packages/api `RunForContactInput`, silently dropped
 *        → breaker NEVER fired in PROD even though Redis showed tripped
 *
 *   `packages/shared` is the cross-rootDir-clean cohort — both apps/api
 *   AND packages/api can `import type` from here freely. Moving the
 *   contract here makes it the single source of truth; the drift class
 *   is structurally eliminated for these fields.
 */

/**
 * Adapter pattern (KAN-655): when set on RunForContactInput, the engine
 * executes this predetermined step instead of free-form deciding.
 * Skips assembleContext/selectStrategy/determineAction/scoreConfidence/
 * evaluateThreshold. Writes a Decision row with strategy='playbook_driven'
 * and the step's instruction/channel as the action. Free-form mode (this
 * field omitted) is unchanged.
 */
export interface PlaybookStepContext {
  /** Unique step identifier, e.g. "dormant_reactivation_14d:day_0". */
  playbookStep: string;
  /** Exact instruction for the downstream send agent (no LLM planning upstream). */
  instruction: string;
  /** Whitelist of actions the step is allowed to emit (enforced downstream). */
  allowedActions: string[];
  /** Channel to send on. */
  channel: 'email' | 'sms' | 'meta';
  /** Freeform metadata attached to the Decision row (playbook name, dryRun, etc.). */
  additionalContext?: Record<string, unknown>;
}

/**
 * KAN-1005 M2-4 circuit-breaker state shape — caller-reads-Redis-passes-
 * to-engine pattern (same as `dailyAutoActionCount`). Engine threads to
 * `evaluateThresholdWithMatrix` → `evaluateThreshold` step 4 (machine-
 * speed pause). Computed via `evaluateBreakerState(redis, tenantId)`
 * (apps/api/src/lib/circuit-breaker.ts).
 *
 * Mirrors the runtime BreakerState shape in apps/api/src/lib/circuit-
 * breaker.ts:181 — kept in sync via the structural drift test (see
 * packages/shared/src/__tests__/run-decision-types-drift.test.ts).
 */
export interface BreakerStateInput {
  /** True if any trip key (3 scopes × 2 targets = 6 keys) exists. */
  tripped: boolean;
  /** Which scope tripped, when tripped. Reported in audit / reasoning. */
  scope?: string;
  /** Whether the trip is global (true) or per-tenant (false). */
  isGlobal?: boolean;
  /** The stored reason string from the trip-write site, when available. */
  reason?: string;
  /** True if the state read failed (Redis error) — caller treats tripped
   *  with this signal so audit can distinguish "actually tripped" from
   *  "fail-closed because we couldn't tell". */
  failClosed?: boolean;
}

/**
 * Canonical input to `runDecisionForContact`. Single source of truth —
 * both packages/api implementation and apps/api dynamic-import caller
 * import this type. Any field added here is automatically compile-
 * checked on both sides; the M2-4 silent-drop class can't recur on
 * these fields.
 */
export interface RunForContactInput {
  tenantId: string;
  contactId: string;
  /** If true, bypass Redis cache when assembling Brain context (useful for demos). */
  freshContext?: boolean;
  /** Actor identity for the audit log. Defaults to 'SYSTEM' for cron/Pub/Sub triggers. */
  actor?: { type: 'USER' | 'SYSTEM'; id: string };
  /**
   * KAN-1005 M2-1 — autonomous-action count for today (UTC), keyed
   * per-tenant. Caller (decision-run-push) reads from Redis
   * (action_count:tenant:<id>:<UTCYYYYMMDD>) BEFORE invoking the
   * engine; engine threads to evaluateThresholdWithMatrix where the
   * daily-action-limit gate consumes it. Omit (or 0) when not
   * relevant (sync trpc paths, tests). Engine treats undefined as 0
   * (gate skips daily-limit check when dailyActionLimit is also
   * undefined).
   */
  dailyAutoActionCount?: number;
  /**
   * KAN-1005 M2-4 — circuit breaker state from Redis. Caller-reads-
   * Redis-passes-to-engine pattern (sibling to dailyAutoActionCount).
   * Engine threads to evaluateThresholdWithMatrix → evaluateThreshold
   * step 4 (machine-speed pause).
   *
   * Omit (or pass `{ tripped: false }`) for sync trpc paths + tests
   * that don't exercise the breaker — engine treats undefined as
   * not-tripped (back-compat safe direction).
   *
   * Pre-M2-4-fix this field existed in the apps/api hand-written type
   * but NOT in the packages/api `RunForContactInput`, so the engine
   * silently dropped the value. The breaker reported tripped=true in
   * Redis but the gate never saw it. Moving the canonical type to
   * packages/shared eliminates the drift class.
   */
  breakerState?: BreakerStateInput;
  /**
   * Adapter pattern (KAN-655): when set, the engine executes this
   * predetermined step instead of free-form deciding. See
   * PlaybookStepContext docstring above.
   */
  playbookStepContext?: PlaybookStepContext;
}
