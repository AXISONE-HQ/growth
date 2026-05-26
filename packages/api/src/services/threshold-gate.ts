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
    blockedActionTypes: z.array(z.string()).default([]),
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

function checkBlockedActions(
  actionType: string,
  blockedActionTypes: string[],
): boolean {
  return blockedActionTypes.includes(actionType);
}

/**
 * KAN-1005 M2-1 (Gap C) — Per-action-type AI-permissions enforcement.
 *
 * Default-deny posture (founder-confirmed 2026-05-26): an action type
 * auto-executes ONLY when explicitly marked 'auto' in
 * Tenant.aiPermissions.actionTypes. Missing entry, non-'auto' value,
 * malformed blob shape, or empty {} → permitted=false (escalate).
 *
 * Triple-gate consequence: with default-deny + autoApproveEnabled=true
 * (M2-6b flip), nothing actually auto-executes until M2-3 populates
 * actionTypes. So M2-1 ships safe even if M2-3 slips — the flip alone
 * can't accidentally enable autonomy.
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

function checkAiPermissions(
  actionType: string,
  aiPermissions: Record<string, unknown>,
): { permitted: boolean; reason: string } {
  const parsed = AiPermissionsSchema.safeParse(aiPermissions ?? {});
  if (!parsed.success) {
    // Malformed blob → fail toward escalate (KAN-1029 lesson:
    // contract-mismatch surfaces don't crash, they default safe).
    return {
      permitted: false,
      reason: 'aiPermissions blob malformed — defaulting to escalate (default-deny)',
    };
  }
  const map = parsed.data.actionTypes;
  // Specific entry wins over wildcard. Allows admin to set
  // `'*': 'auto', 'send_quote': 'escalate'` (broad autonomy with
  // specific carve-outs).
  const specific = map?.[actionType];
  if (specific === 'auto') return { permitted: true, reason: 'permitted by tenant aiPermissions' };
  if (specific !== undefined) {
    // Specific entry exists and is not 'auto' (e.g. 'escalate', 'blocked').
    // Escalate — specific override beats any wildcard.
    return {
      permitted: false,
      reason: `aiPermissions.actionTypes.${actionType} = "${specific}" (not 'auto')`,
    };
  }
  // No specific entry — check wildcard. `'*': 'auto'` is the admin's
  // explicit "permit all autonomy" opt-in (one entry replaces an
  // enumeration of every possible action type). This is still a
  // deliberate admin choice; default-deny without any entries holds.
  const wildcard = map?.['*'];
  if (wildcard === 'auto') {
    return { permitted: true, reason: 'permitted by aiPermissions wildcard "*"' };
  }
  // No specific entry + no wildcard (or wildcard is not 'auto') →
  // default-deny.
  return {
    permitted: false,
    reason: `aiPermissions.actionTypes has no entry for "${actionType}" — default-deny`,
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

  if (checkBlockedActions(parsed.actionType, parsed.tenantConfig.blockedActionTypes)) {
    decision = 'blocked';
    reasoning = `Action type "${parsed.actionType}" is blocked by tenant configuration.`;
  } else if (parsed.tenantConfig.requireHumanApproval) {
    decision = 'human_review';
    reasoning = 'Tenant requires human approval for all AI actions.';
  } else if (parsed.tenantConfig.autoApproveEnabled === false) {
    // KAN-704 kill-switch: tenant-level disable runs BEFORE matrix resolution.
    decision = 'human_review';
    reasoning = 'Tenant auto-approve is disabled (kill-switch). Routing all actions to human review.';
  } else if (matrixDefault === 'human_review') {
    // Matrix entry is sentinel-level (e.g., send_quote / reply_to_complaint
    // at threshold 1.0 + default human_review). Skip the confidence check —
    // the calibration explicitly says "never auto."
    decision = 'human_review';
    reasoning = `Action type "${parsed.actionType}" is configured for human review by the auto-approve matrix${matrixEntry?.rationale ? ` (rationale: ${matrixEntry.rationale})` : ''}.`;
  } else if (!checkAiPermissions(parsed.actionType, parsed.tenantConfig.aiPermissions).permitted) {
    // KAN-1005 M2-1 (Gap C) — default-deny on Tenant.aiPermissions.
    // With autoApproveEnabled=true (M2-6b flip), this is the gate that
    // keeps autonomy locked until M2-3 explicitly populates actionTypes.
    const check = checkAiPermissions(parsed.actionType, parsed.tenantConfig.aiPermissions);
    decision = 'human_review';
    reasoning = `Action type "${parsed.actionType}" is not permitted for autonomous execution (${check.reason}). Routing to human review.`;
  } else {
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
  checkBlockedActions,
  checkDailyLimit,
  buildReviewRequest,
  DEFAULT_AUTO_ESCALATE_FLAGS,
};
