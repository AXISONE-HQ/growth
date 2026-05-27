/**
 * Threshold Gate — KAN-39
 *
 * Decision Engine — DECIDE phase, Step 5
 * Final gate before action execution. Compares the confidence score
 * against the tenant's configured threshold. Routes low-confidence
 * actions to the human review queue; high-confidence actions proceed
 * to the Agent Dispatcher via action.decided event.
 *
 * Architecture reference:
 *   Confidence Scorer output (ConfidenceScorerResult)
 *       │
 *   Threshold Gate  ← score < threshold → human queue
 *                     score ≥ threshold → action.decided → Pub/Sub
 *
 * Human queue routing:
 *   - Creates a pending_review record with full decision context
 *   - Fires escalation.triggered event for notification
 *   - Supports approve / reject / modify workflows
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// KAN-704: auto-approve matrix (inlined here to avoid TS6059 cascade growth
// on a new file in the apps/api program graph). Re-exported below for any
// future caller that needs the catalog directly.
// ─────────────────────────────────────────────

export type AutoApproveActionType =
  | 'send_warm_up_email'
  | 'send_followup_email'
  | 'send_quote'
  | 'schedule_appointment'
  | 'transition_to_qualified'
  | 'transition_to_closed_won'
  | 'transition_to_closed_lost'
  | 'reply_to_complaint'
  | 'send_marketing_message';

// ─────────────────────────────────────────────
// KAN-1005 M2-3 — System-level high-stakes clamp.
//
// THE central M2 safety property: a hardcoded set of action types that
// ALWAYS resolve to escalate, regardless of:
//   - tenant aiPermissions.actionTypes[type] (even 'auto')
//   - matrix entries (even at threshold=0 with default='auto')
//   - confidence scores (even at 100%)
//
// The clamp is a CEILING, not a floor:
//   - tenant 'auto'     → escalate (clamp overrides)
//   - tenant 'escalate' → escalate (honored — same effect)
//   - tenant 'blocked'  → blocked (honored — MORE restrictive than clamp)
//   - tenant unset      → escalate (M2-1 default-deny preserved)
//
// Unbypassability test pins this hard (kan-1005-m2-3-clamp-unbypassable
// test): no aiPermissions config — including malformed, wildcard, future
// shapes — can route a high-stakes action to auto.
//
// Coverage spans 3 vocabs (Transport / Determiner / Semantic) plus
// defensive Brain entries so a future code-path change can't slip a
// money-moving / irreversible action to auto. Rule of inclusion:
//   - money-bearing artifact (quotes, payments — none yet)
//   - reputational triage (complaint replies)
//   - irreversible state change (closing a deal/objective)
//
// NOT high-stakes (deliberately): conversational sends (send_message /
// send_email / send_warm_up_email etc.), scheduling, internal progression
// (transition_to_qualified, advance_stage), CRM writes (update_crm —
// borderline; follow-up ticket KAN-XXXX will payload-split into
// note vs field-mutation).
//
// To ADD a high-stakes type:
//   1. Add the string to HIGH_STAKES_ACTION_TYPES below
//   2. Add a row to the clamp unit-test matrix
//   3. The clamp's no-bypass property is already guaranteed by ordering;
//      the test confirms.
// ─────────────────────────────────────────────
export const HIGH_STAKES_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  // Semantic vocab (AutoApproveActionType — matrix-keyed)
  'send_quote',                  // money-bearing artifact
  'reply_to_complaint',          // reputational triage
  'transition_to_closed_won',    // irreversible reporting-financial event
  'transition_to_closed_lost',   // irreversible flow termination
  // Determiner vocab (engine emits)
  'close_objective',             // irreversible work closure
  // Brain vocab (Lead-Inbox-only today; defensive coverage so a future
  // change that routes Brain through threshold-gate can't bypass)
  'close_deal_lost',             // Brain analog of transition_to_closed_lost
]);

/**
 * KAN-1005 M2-3 — Unified per-action-type permission tri-value.
 *
 * `aiPermissions.actionTypes` is a Record<string, AiActionPermission>.
 * Tenant config surface; default-deny via undefined.
 *
 *   'auto'     → autonomous execute (subject to high-stakes clamp + downstream gates)
 *   'escalate' → AI proposes; routes to human review (M1 behavior)
 *   'blocked'  → AI never does this action type at all — hard off, not even queued
 *
 * `undefined` (missing entry) → escalate (default-deny, M2-1 preserved)
 */
export type AiActionPermission = 'auto' | 'escalate' | 'blocked';

export type AutoApproveMode = 'auto' | 'human_review';

export interface AutoApproveEntry {
  /** Confidence score (0..1) at or above which `default` applies. 1.0 = unreachable = always human_review. */
  threshold: number;
  /** Routing when the threshold is met. `auto` = approve, `human_review` = queue for human. */
  default: AutoApproveMode;
  /** Why this calibration. Don't drop this field — it's the institutional memory. */
  rationale?: string;
}

export type AutoApproveMatrix = Partial<Record<AutoApproveActionType, AutoApproveEntry>>;

/**
 * Platform-default catalog. Used as the bottom of the resolution order:
 *   1. Tenant.autoApproveEnabled === false    → human_review (kill-switch)
 *   2. Stage.autoApproveMatrix[actionType]    → most specific tier
 *   3. Pipeline.defaultAutoApproveMatrix[…]   → second tier
 *   4. PLATFORM_AUTO_APPROVE_DEFAULTS[…]      → fallback
 *
 * Conservative bias: anything money-related (`send_quote`) or
 * relationship-fragile (`reply_to_complaint`) is `threshold: 1.0,
 * default: 'human_review'` — sentinel meaning "never auto." Confidence
 * scores never exceed 100, so the gate is unreachable for auto on those.
 */
export const PLATFORM_AUTO_APPROVE_DEFAULTS: Record<AutoApproveActionType, AutoApproveEntry> = {
  send_warm_up_email: {
    threshold: 0.6,
    default: 'auto',
    rationale: 'Low-stakes opener. Worst case is a noisy first touch — recoverable; the alternative (block until human) kills outbound velocity for cold-start tenants.',
  },
  send_followup_email: {
    threshold: 0.7,
    default: 'auto',
    rationale: 'Slightly higher bar than warm-up because follow-ups land on already-engaged contacts where tone-misfire damages an active conversation.',
  },
  send_quote: {
    threshold: 1.0,
    default: 'human_review',
    rationale: 'Money-bearing artifact. A wrong quote is contractually messy + customer-trust-eroding. 1.0 sentinel = always human review until per-tenant calibration earns lower.',
  },
  schedule_appointment: {
    threshold: 0.7,
    default: 'auto',
    rationale: 'Bookings have soft revenue impact (calendar real estate) but are easily rescheduled — auto-approve at moderate confidence.',
  },
  transition_to_qualified: {
    threshold: 0.6,
    default: 'auto',
    rationale: 'Internal pipeline state change with no external side effect. Wrong transitions self-correct on the next signal — auto-approve liberally.',
  },
  transition_to_closed_won: {
    threshold: 0.9,
    default: 'auto',
    rationale: 'Internal but reporting-impactful — wrong closed-won inflates dashboards. Higher bar but still auto for high confidence; UI can flag for review on outliers.',
  },
  transition_to_closed_lost: {
    threshold: 0.8,
    default: 'auto',
    rationale: 'Closing a lead off the funnel terminates outreach. Higher bar than internal stages but lower than closed-won (no reporting inflation, just churn).',
  },
  reply_to_complaint: {
    threshold: 1.0,
    default: 'human_review',
    rationale: 'Complaint replies are reputational triage. AI tone-mismatch on an angry customer is a step-function escalation. 1.0 sentinel = always human review.',
  },
  send_marketing_message: {
    threshold: 0.7,
    default: 'auto',
    rationale: 'Broadcast / nurture content. Same threshold as follow-up — moderate stakes, recoverable misfire.',
  },
};

/**
 * Resolve the auto-approve entry for a given action type using the documented
 * resolution order. Returns null only when the action type is unknown to the
 * platform; in that case the caller should route to human_review by default.
 */
export function resolveAutoApproveEntry(
  actionType: string,
  stageMatrix: AutoApproveMatrix | null | undefined,
  pipelineMatrix: AutoApproveMatrix | null | undefined,
): AutoApproveEntry | null {
  const stageEntry = stageMatrix?.[actionType as AutoApproveActionType];
  if (stageEntry) return stageEntry;
  const pipelineEntry = pipelineMatrix?.[actionType as AutoApproveActionType];
  if (pipelineEntry) return pipelineEntry;
  return PLATFORM_AUTO_APPROVE_DEFAULTS[actionType as AutoApproveActionType] ?? null;
}

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const GateDecision = z.enum([
  'approved',
  'human_review',
  'auto_escalated',
  'blocked',
]);

// KAN-704: per-stage / per-pipeline auto-approve matrix shape. Both tiers are
// optional — when neither is set, threshold-gate falls through to the
// PLATFORM_AUTO_APPROVE_DEFAULTS catalog. Tenant.autoApproveEnabled = false
// is the kill-switch and runs BEFORE the matrix resolution (hard cut-off).
const AutoApproveEntrySchema = z.object({
  threshold: z.number().min(0).max(1),
  default: z.enum(['auto', 'human_review']),
  rationale: z.string().optional(),
});
const AutoApproveMatrixSchema = z.record(AutoApproveEntrySchema).nullable().optional();

export const ThresholdGateInputSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string(),
  overallConfidence: z.number().min(0).max(100),
  riskFlags: z.array(z.string()),
  actionType: z.string(),
  channel: z.string().nullable(),
  actionPayload: z.record(z.unknown()),
  actionReasoning: z.string(),
  selectedStrategy: z.string(),
  strategyReasoning: z.string(),
  tenantConfig: z.object({
    /**
     * Legacy flat threshold (KAN-450). Stays as the fallback when neither the
     * stage matrix, pipeline matrix, nor platform default catalog has an entry
     * for this action type. On a deprecation track — the matrix path is the
     * canonical resolution.
     */
    confidenceThreshold: z.number().min(0).max(100).default(70),
    autoEscalateFlags: z.array(z.string()).default([]),
    // KAN-1005 M2-3 — `blockedActionTypes` removed. The dead stub
    // (Tenant column never existed) collapsed into the unified
    // aiPermissions.actionTypes tri-value model: 'blocked' is the
    // third value, semantically stronger than 'escalate' (hard off,
    // not even queued for review).
    requireHumanApproval: z.boolean().default(false),
    maxDailyAutoActions: z.number().optional(),
    /**
     * KAN-1005 M2-1 (Gap C) — per-action-type AI permissions, loaded
     * verbatim from Tenant.aiPermissions Json. Defensive parsing happens
     * inside `checkAiPermissions` (default-deny on missing/malformed).
     * M2-1 enforces the mechanism; M2-3 will populate the actionTypes
     * defaults (safe-auto vs high-stakes-escalate).
     *
     * Expected shape (parsed by AiPermissionsSchema below):
     *   { actionTypes: { send_message: 'auto', send_quote: 'escalate', … } }
     *
     * Default {} → with default-deny semantics, every action type
     * escalates → autonomy is locked until M2-3 ships defaults. Means
     * autoApproveEnabled=true alone doesn't auto-execute anything.
     */
    aiPermissions: z.record(z.unknown()).default({}),
    /**
     * KAN-704: tenant-level kill-switch. When false, EVERY action routes to
     * human_review regardless of stage/pipeline matrix configuration. Hard
     * cut-off — runs before matrix resolution. (`requireHumanApproval` above
     * is the older flag with the same effect; keeping both for back-compat
     * because `requireHumanApproval` was the original KAN-39 surface.)
     */
    autoApproveEnabled: z.boolean().default(true),
  }),
  /** KAN-704: Stage.autoApproveMatrix — most specific tier. Loaded by caller from Contact.currentStageId. */
  stageMatrix: AutoApproveMatrixSchema,
  /** KAN-704: Pipeline.defaultAutoApproveMatrix — second tier. Loaded by caller from Contact.currentPipelineId. */
  pipelineMatrix: AutoApproveMatrixSchema,
  dailyAutoActionCount: z.number().default(0),
  /**
   * KAN-1005 M2-4 — Circuit breaker state. Caller reads from Redis via
   * `evaluateBreakerState(redis, tenantId)` BEFORE invoking the gate,
   * passes the result here. The gate is sync (mirrors the M2-1
   * dailyAutoActionCount pattern — async Redis at caller, sync gate
   * logic for testability).
   *
   * When `tripped: true`, the gate routes to human_review at step 3 of
   * the ladder (after kill-switch, before per-action-type gates) so
   * a tripped breaker pauses EVERY autonomous action regardless of
   * which action type is being attempted. Distinct from the deliberate-
   * human kill-switch (autoApproveEnabled=false) — observably separate.
   *
   * Tripped breaker routes to `human_review` (NOT `blocked`): the
   * queue keeps filling so humans see the runaway and can drain;
   * blocked would make the AI go silent during an incident.
   *
   * Optional for back-compat — callers that don't pass it get
   * { tripped: false } (gate skips the breaker check). Production
   * caller (evaluateThresholdWithMatrix) always reads + passes.
   */
  breakerState: z
    .object({
      tripped: z.boolean(),
      scope: z.string().optional(),
      isGlobal: z.boolean().optional(),
      reason: z.string().optional(),
      failClosed: z.boolean().optional(),
    })
    .default({ tripped: false }),
});

export const ThresholdGateResultSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string(),
  decision: GateDecision,
  confidenceScore: z.number(),
  threshold: z.number(),
  reasoning: z.string(),
  gatedAt: z.string().datetime(),
  approvedAction: z
    .object({
      actionType: z.string(),
      channel: z.string().nullable(),
      actionPayload: z.record(z.unknown()),
      selectedStrategy: z.string(),
      confidenceScore: z.number(),
    })
    .nullable(),
  reviewRequest: z
    .object({
      reason: z.string(),
      riskFlags: z.array(z.string()),
      proposedAction: z.object({
        actionType: z.string(),
        channel: z.string().nullable(),
        actionPayload: z.record(z.unknown()),
      }),
      decisionContext: z.object({
        strategy: z.string(),
        strategyReasoning: z.string(),
        actionReasoning: z.string(),
        confidenceScore: z.number(),
        factors: z.string(),
      }),
      expiresAt: z.string().datetime(),
    })
    .nullable(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ThresholdGateInput = z.infer<typeof ThresholdGateInputSchema>;
export type ThresholdGateResult = z.infer<typeof ThresholdGateResultSchema>;
type GateDecisionValue = z.infer<typeof GateDecision>;

// ─────────────────────────────────────────────
// Auto-Escalation Flags
// ─────────────────────────────────────────────

const DEFAULT_AUTO_ESCALATE_FLAGS = [
  'CRITICAL_GAP',
  'CONTACT_UNRESPONSIVE',
  'VERY_LOW_DATA_QUALITY',
];

// ─────────────────────────────────────────────
// Gate Logic
// ─────────────────────────────────────────────

function checkAutoEscalation(
  riskFlags: string[],
  tenantAutoEscalateFlags: string[],
): { shouldEscalate: boolean; triggeringFlags: string[] } {
  const allEscalateFlags = [
    ...DEFAULT_AUTO_ESCALATE_FLAGS,
    ...tenantAutoEscalateFlags,
  ];
  const triggeringFlags = riskFlags.filter((f) =>
    allEscalateFlags.includes(f),
  );
  return {
    shouldEscalate: triggeringFlags.length > 0,
    triggeringFlags,
  };
}

/**
 * KAN-1005 M2-1 (Gap C) + M2-3 — Per-action-type AI-permissions enforcement.
 *
 * Default-deny posture (founder-confirmed 2026-05-26): an action type
 * auto-executes ONLY when explicitly marked 'auto' in
 * Tenant.aiPermissions.actionTypes. Missing entry, non-'auto' value,
 * malformed blob shape, or empty {} → escalate (M2-1).
 *
 * M2-3 extends the model to a unified tri-value:
 *   'auto'     → permit (subject to high-stakes clamp — see resolveAiPermission)
 *   'escalate' → escalate (AI proposes; human review)
 *   'blocked'  → blocked (AI never even queues this type — hard off)
 *   undefined  → escalate (default-deny, M2-1)
 *
 * The high-stakes clamp is applied in `resolveAiPermission` (the public
 * tri-value function) AFTER reading the tenant value: a high-stakes action
 * with tenant='auto' is overridden to 'escalate'; tenant='blocked' is
 * MORE restrictive and honored (clamp is a ceiling, not a floor).
 *
 * Expected shape inside Tenant.aiPermissions Json:
 *   { actionTypes: { send_message: 'auto', send_quote: 'escalate', … } }
 *
 * Other keys inside aiPermissions are passthrough (e.g.
 * `dataQualityThreshold`, `truthInferenceThreshold` — pre-existing
 * non-M2 consumers; .passthrough() preserves them).
 */
const AiPermissionsSchema = z
  .object({
    actionTypes: z.record(z.string()).optional(),
  })
  .passthrough();

/**
 * KAN-1005 M2-3 — Resolve effective AI permission for an action type.
 *
 * Returns the unified tri-value outcome after applying the high-stakes
 * clamp. Caller (`evaluateThreshold`) dispatches:
 *   'permit'   → continue to matrix/confidence path
 *   'escalate' → decision = 'human_review'
 *   'blocked'  → decision = 'blocked'
 *
 * Clamp ordering (the safety property M2-3 ships):
 *   1. Read tenant value from aiPermissions.actionTypes[actionType] (or undefined)
 *   2. If actionType ∈ HIGH_STAKES_ACTION_TYPES:
 *      - tenant 'blocked' → blocked (HONOR — stricter than clamp)
 *      - otherwise → escalate (CLAMP — overrides 'auto', preserves 'escalate'/undefined)
 *   3. Else (non-high-stakes):
 *      - 'auto'     → permit
 *      - 'blocked'  → blocked
 *      - 'escalate' → escalate
 *      - undefined  → escalate (default-deny, M2-1)
 *
 * Malformed blob → escalate with a flagged reason. Same fail-safe posture
 * as M2-1 (KAN-1029 lesson: contract-mismatch defaults safe, no crash).
 */
export function resolveAiPermission(
  actionType: string,
  aiPermissions: Record<string, unknown>,
): { outcome: 'permit' | 'escalate' | 'blocked'; reason: string } {
  const parsed = AiPermissionsSchema.safeParse(aiPermissions ?? {});
  if (!parsed.success) {
    return {
      outcome: 'escalate',
      reason: 'aiPermissions blob malformed — defaulting to escalate (default-deny)',
    };
  }
  const tenantValue = parsed.data.actionTypes?.[actionType];
  const isHighStakes = HIGH_STAKES_ACTION_TYPES.has(actionType);

  if (isHighStakes) {
    // 'blocked' is MORE restrictive than the clamp — honor it.
    if (tenantValue === 'blocked') {
      return {
        outcome: 'blocked',
        reason: `aiPermissions.actionTypes.${actionType} = "blocked" (tenant override, stricter than high-stakes clamp)`,
      };
    }
    // Clamp authoritative: 'auto' / 'escalate' / undefined all → escalate.
    if (tenantValue === 'auto') {
      return {
        outcome: 'escalate',
        reason: `"${actionType}" is a high-stakes action — system clamp overrides tenant aiPermissions="auto" to escalate (KAN-1005 M2-3 safety invariant)`,
      };
    }
    // 'escalate' or undefined — same outcome as the clamp would've produced.
    return {
      outcome: 'escalate',
      reason: `"${actionType}" is a high-stakes action — system clamp routes to human review (tenant aiPermissions=${tenantValue === undefined ? 'unset (default-deny)' : `"${tenantValue}"`}; clamp does not lower restriction)`,
    };
  }

  // Non-high-stakes: tri-value passthrough.
  if (tenantValue === 'auto') {
    return { outcome: 'permit', reason: 'permitted by tenant aiPermissions' };
  }
  if (tenantValue === 'blocked') {
    return {
      outcome: 'blocked',
      reason: `aiPermissions.actionTypes.${actionType} = "blocked"`,
    };
  }
  if (tenantValue === 'escalate') {
    return {
      outcome: 'escalate',
      reason: `aiPermissions.actionTypes.${actionType} = "escalate"`,
    };
  }
  if (tenantValue === undefined) {
    return {
      outcome: 'escalate',
      reason: `aiPermissions.actionTypes has no entry for "${actionType}" — default-deny`,
    };
  }
  // Unknown value (typo, future shape) → escalate (fail-safe).
  return {
    outcome: 'escalate',
    reason: `aiPermissions.actionTypes.${actionType} = "${tenantValue}" (unknown value, not in tri-value 'auto'|'escalate'|'blocked') — default-deny`,
  };
}

function checkDailyLimit(
  dailyCount: number,
  maxDaily: number | undefined,
): boolean {
  if (maxDaily === undefined) return false;
  return dailyCount >= maxDaily;
}

function buildReviewRequest(
  input: ThresholdGateInput,
  reason: string,
): ThresholdGateResult['reviewRequest'] {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    reason,
    riskFlags: input.riskFlags,
    proposedAction: {
      actionType: input.actionType,
      channel: input.channel,
      actionPayload: input.actionPayload,
    },
    decisionContext: {
      strategy: input.selectedStrategy,
      strategyReasoning: input.strategyReasoning,
      actionReasoning: input.actionReasoning,
      confidenceScore: input.overallConfidence,
      factors: `Confidence: ${input.overallConfidence}/100. Risk flags: ${input.riskFlags.length > 0 ? input.riskFlags.join(', ') : 'none'}`,
    },
    expiresAt,
  };
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

export function evaluateThreshold(
  input: ThresholdGateInput,
): ThresholdGateResult {
  const parsed = ThresholdGateInputSchema.parse(input);

  // KAN-704: matrix-resolved per-action-type threshold (stage → pipeline →
  // platform default). Falls back to the legacy flat
  // `tenantConfig.confidenceThreshold` (0-100 scale) only if no entry is found
  // for this action type at any tier. Matrix thresholds are 0..1; convert to
  // the 0..100 scale used by the rest of the gate.
  const matrixEntry = resolveAutoApproveEntry(
    parsed.actionType,
    (parsed.stageMatrix ?? null) as AutoApproveMatrix | null,
    (parsed.pipelineMatrix ?? null) as AutoApproveMatrix | null,
  );
  const matrixThresholdNorm = matrixEntry?.threshold; // 0..1 if present
  const threshold = matrixThresholdNorm !== undefined
    ? matrixThresholdNorm * 100
    : parsed.tenantConfig.confidenceThreshold;
  const matrixDefault = matrixEntry?.default; // 'auto' | 'human_review' | undefined

  let decision: GateDecisionValue;
  let reasoning: string;

  // KAN-1005 M2-3 — Unified tri-value permission + high-stakes clamp.
  // resolveAiPermission encapsulates BOTH the tenant aiPermissions read
  // AND the high-stakes clamp. By dispatching on the tri-value here, we
  // guarantee the clamp is authoritative over EVERY auto-routing path
  // below (matrix, legacy confidence, daily-limit, risk-flag) — there
  // is no flow that reaches `decision = 'approved'` without first
  // confirming the action is permit-eligible.
  const aiPerm = resolveAiPermission(parsed.actionType, parsed.tenantConfig.aiPermissions);

  if (parsed.tenantConfig.requireHumanApproval) {
    decision = 'human_review';
    reasoning = 'Tenant requires human approval for all AI actions.';
  } else if (parsed.tenantConfig.autoApproveEnabled === false) {
    // KAN-704 kill-switch: tenant-level disable runs BEFORE matrix resolution.
    decision = 'human_review';
    reasoning = 'Tenant auto-approve is disabled (kill-switch). Routing all actions to human review.';
  } else if (aiPerm.outcome === 'blocked') {
    // KAN-1005 M2-3 — 'blocked' is the third tri-value: hard off, not
    // even queued for review. Stricter than 'escalate' AND stricter
    // than the M2-4 breaker's human_review (founder precedence call
    // 2026-05-27): "AI never does this action type at all, not even
    // escalated" — a blocked action has no autonomy to pause, so the
    // breaker can't usefully convert it. Evaluated BEFORE the breaker
    // so blocked stays blocked through a trip; the queue stays clean
    // of tenant-configured never-touch types even during an incident.
    //
    // Precedence ladder: blocked is MORE-restrictive than human_review,
    // and the gate moves toward more-restrictive, never away. (The
    // kill-switch and requireHumanApproval above are deliberate
    // human/emergency overrides where "eyes-on everything" is a
    // defensible intent; their precedence over blocked is a separable
    // consistency question, tracked as a follow-up rather than folded
    // into M2-4.)
    decision = 'blocked';
    reasoning = `Action type "${parsed.actionType}" is blocked (${aiPerm.reason}).`;
  } else if (parsed.breakerState.tripped) {
    // KAN-1005 M2-4 — machine-speed circuit breaker. Distinct from the
    // deliberate-human kill-switch above (resetting the breaker doesn't
    // un-pause an autoApproveEnabled=false tenant; and vice versa).
    //
    // Routes to human_review (NOT blocked) — the queue keeps filling so
    // humans see the runaway and can drain; blocked would make the AI go
    // silent during an incident. Reasoning carries "circuit_breaker_tripped"
    // marker so audit/grep can distinguish from kill-switch + clamp +
    // default-deny.
    //
    // Catches everything that's actually autonomy-eligible: permit and
    // escalate actions reach here and get paused to human_review. Blocked
    // actions (step above) stay blocked — they were never going to
    // execute, so there's no autonomy to pause.
    decision = 'human_review';
    const scopeLabel = parsed.breakerState.scope ?? 'unknown';
    const globalLabel = parsed.breakerState.isGlobal ? ' [GLOBAL]' : '';
    const reasonSuffix = parsed.breakerState.reason ? `: ${parsed.breakerState.reason}` : '';
    const failClosedSuffix = parsed.breakerState.failClosed
      ? ' (fail-closed: Redis state unavailable)'
      : '';
    reasoning = `circuit_breaker_tripped${globalLabel} scope=${scopeLabel}${reasonSuffix}${failClosedSuffix}. Routing to human review.`;
  } else if (aiPerm.outcome === 'escalate') {
    // KAN-1005 M2-3 clamp / M2-1 default-deny — both produce 'escalate'
    // here. The clamp's reasoning string carries "high-stakes" + "system
    // clamp" markers so audit/grep can distinguish clamp-fires from
    // generic default-deny without needing two parallel signals.
    //
    // Ordering: this gate fires BEFORE the matrix-sentinel branch below,
    // so even when a high-stakes action ALSO has matrix-sentinel-1.0
    // (send_quote, reply_to_complaint), the clamp's reasoning is the
    // single canonical attribution. The matrix-sentinel branch below
    // remains as defense-in-depth for non-clamp action types that a
    // tenant or pipeline matrix explicitly pins to human_review.
    decision = 'human_review';
    reasoning = `Action type "${parsed.actionType}" is not permitted for autonomous execution (${aiPerm.reason}). Routing to human review.`;
  } else if (matrixDefault === 'human_review') {
    // Matrix entry is sentinel-level. Today the platform-default 1.0
    // sentinels (send_quote, reply_to_complaint) are also high-stakes-
    // clamped above, so this branch is reached only for tenant-supplied
    // stage/pipeline matrices that pin a SAFE action type to human_review
    // (e.g., a tenant during a sensitive product launch). Preserved as
    // defense-in-depth and tenant-config respect.
    decision = 'human_review';
    reasoning = `Action type "${parsed.actionType}" is configured for human review by the auto-approve matrix${matrixEntry?.rationale ? ` (rationale: ${matrixEntry.rationale})` : ''}.`;
  } else {
    // aiPerm.outcome === 'permit' — continue to matrix/confidence path.
    const escalation = checkAutoEscalation(
      parsed.riskFlags,
      parsed.tenantConfig.autoEscalateFlags,
    );

    if (escalation.shouldEscalate) {
      decision = 'auto_escalated';
      reasoning = `Auto-escalated due to risk flags: ${escalation.triggeringFlags.join(', ')}.`;
    } else if (
      checkDailyLimit(
        parsed.dailyAutoActionCount,
        parsed.tenantConfig.maxDailyAutoActions,
      )
    ) {
      decision = 'human_review';
      reasoning = `Daily auto-action limit reached (${parsed.tenantConfig.maxDailyAutoActions}). Routing to human review.`;
    } else if (parsed.overallConfidence < threshold) {
      decision = 'human_review';
      const tierLabel = matrixThresholdNorm !== undefined
        ? `auto-approve matrix threshold ${threshold} for "${parsed.actionType}"`
        : `legacy threshold ${threshold}`;
      reasoning = `Confidence ${parsed.overallConfidence} is below ${tierLabel}. Routing to human review.`;
    } else {
      decision = 'approved';
      const tierLabel = matrixThresholdNorm !== undefined
        ? `auto-approve matrix threshold ${threshold} for "${parsed.actionType}"`
        : `legacy threshold ${threshold}`;
      reasoning = `Confidence ${parsed.overallConfidence} meets ${tierLabel}. Action approved for execution.`;
    }
  }

  const isApproved = decision === 'approved';
  const needsReview =
    decision === 'human_review' || decision === 'auto_escalated';

  const result: ThresholdGateResult = {
    contactId: parsed.contactId,
    tenantId: parsed.tenantId,
    objectiveId: parsed.objectiveId,
    decision,
    confidenceScore: parsed.overallConfidence,
    threshold,
    reasoning,
    gatedAt: new Date().toISOString(),
    approvedAction: isApproved
      ? {
          actionType: parsed.actionType,
          channel: parsed.channel,
          actionPayload: parsed.actionPayload,
          selectedStrategy: parsed.selectedStrategy,
          confidenceScore: parsed.overallConfidence,
        }
      : null,
    reviewRequest: needsReview
      ? buildReviewRequest(parsed, reasoning)
      : null,
  };

  return ThresholdGateResultSchema.parse(result);
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createThresholdGateRouter(): Router {
  const router = Router();

  router.post('/evaluate-threshold', async (req: Request, res: Response) => {
    try {
      const input = ThresholdGateInputSchema.parse(req.body);
      const result = evaluateThreshold(input);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[ThresholdGate] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Threshold evaluation failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  checkAutoEscalation,
  checkDailyLimit,
  buildReviewRequest,
  DEFAULT_AUTO_ESCALATE_FLAGS,
};
