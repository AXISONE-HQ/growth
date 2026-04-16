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
// Schemas
// ─────────────────────────────────────────────

export const GateDecision = z.enum([
  'approved',
  'human_review',
  'auto_escalated',
  'blocked',
]);

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
    confidenceThreshold: z.number().min(0).max(100).default(70),
    autoEscalateFlags: z.array(z.string()).default([]),
    blockedActionTypes: z.array(z.string()).default([]),
    requireHumanApproval: z.boolean().default(false),
    maxDailyAutoActions: z.number().optional(),
  }),
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
  const threshold = parsed.tenantConfig.confidenceThreshold;

  let decision: GateDecisionValue;
  let reasoning: string;

  if (checkBlockedActions(parsed.actionType, parsed.tenantConfig.blockedActionTypes)) {
    decision = 'blocked';
    reasoning = `Action type "${parsed.actionType}" is blocked by tenant configuration.`;
  } else if (parsed.tenantConfig.requireHumanApproval) {
    decision = 'human_review';
    reasoning = 'Tenant requires human approval for all AI actions.';
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
      reasoning = `Confidence ${parsed.overallConfidence} is below threshold ${threshold}. Routing to human review.`;
    } else {
      decision = 'approved';
      reasoning = `Confidence ${parsed.overallConfidence} meets threshold ${threshold}. Action approved for execution.`;
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
