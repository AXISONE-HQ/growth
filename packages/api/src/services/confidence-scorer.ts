/**
 * Confidence Scorer — KAN-38
 *
 * Decision Engine — DECIDE phase, Step 4
 * Calculates a 0-100 confidence score for the proposed action.
 * MVP uses a weighted multi-factor formula. Phase 2 adds Claude Haiku
 * for nuanced confidence assessment on edge cases.
 *
 * Architecture reference:
 *   Action Determiner output (ActionDeterminerResult)
 *       │
 *   Confidence Scorer  ← Score 0-100
 *       │
 *   Threshold Gate     ← score < threshold → human queue
 *                        score ≥ threshold → action.decided
 *
 * Confidence factors:
 *   - Strategy selection confidence (from Strategy Selector)
 *   - Data quality score (from contact record)
 *   - Action alignment score (does action match gap?)
 *   - Historical success rate (from Learning Service)
 *   - Contact engagement score (response rate, recency)
 *   - Brain completeness (how much do we know about this tenant?)
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const ConfidenceScorerInputSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string(),

  // From Strategy Selector
  strategyConfidence: z.number().min(0).max(100),
  selectedStrategy: z.string(),

  // From Action Determiner
  actionType: z.string(),
  actionReasoning: z.string(),

  // Contact signals
  contactSignals: z.object({
    dataQualityScore: z.number().min(0).max(100).optional(),
    responseRate: z.number().min(0).max(1).optional(),
    lastInteractionDaysAgo: z.number().optional(),
    totalInteractions: z.number().optional(),
    lifecycleStage: z.string().optional(),
  }),

  // Gap context
  gapContext: z
    .object({
      gapSeverity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      gapReason: z.string().optional(),
      suggestedActionsCount: z.number().optional(),
    })
    .optional(),

  // Brain completeness
  brainSignals: z
    .object({
      hasBlueprintStrategies: z.boolean().optional(),
      hasCompanyTruth: z.boolean().optional(),
      hasHistoricalOutcomes: z.boolean().optional(),
      strategyWinRate: z.number().min(0).max(1).optional(),
      sampleSize: z.number().optional(),
    })
    .optional(),
});

export const ConfidenceScorerResultSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string(),
  overallConfidence: z.number().min(0).max(100),
  factors: z.array(
    z.object({
      name: z.string(),
      score: z.number().min(0).max(100),
      weight: z.number().min(0).max(1),
      weightedScore: z.number(),
      reasoning: z.string(),
    }),
  ),
  riskFlags: z.array(z.string()),
  scoredAt: z.string().datetime(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ConfidenceScorerInput = z.infer<typeof ConfidenceScorerInputSchema>;
export type ConfidenceScorerResult = z.infer<typeof ConfidenceScorerResultSchema>;

interface ConfidenceFactor {
  name: string;
  score: number;
  weight: number;
  reasoning: string;
}

// ─────────────────────────────────────────────
// Factor Weights — tunable per deployment
// ─────────────────────────────────────────────

const FACTOR_WEIGHTS = {
  strategyConfidence: 0.25,
  dataQuality: 0.15,
  contactEngagement: 0.20,
  actionAlignment: 0.15,
  brainCompleteness: 0.10,
  historicalSuccess: 0.15,
} as const;

// ─────────────────────────────────────────────
// Individual Factor Scorers
// ─────────────────────────────────────────────

function scoreStrategyConfidence(input: ConfidenceScorerInput): ConfidenceFactor {
  // Pass through the strategy selector's confidence directly
  const score = input.strategyConfidence;
  return {
    name: 'Strategy Confidence',
    score,
    weight: FACTOR_WEIGHTS.strategyConfidence,
    reasoning:
      score >= 80
        ? 'High confidence in strategy selection'
        : score >= 60
          ? 'Moderate confidence — strategy selection had close alternatives'
          : 'Low confidence — strategy selection was ambiguous',
  };
}

function scoreDataQuality(input: ConfidenceScorerInput): ConfidenceFactor {
  const dqs = input.contactSignals.dataQualityScore ?? 50;
  // Map 0-100 DQS to 0-100 confidence factor
  const score = dqs;
  return {
    name: 'Data Quality',
    score,
    weight: FACTOR_WEIGHTS.dataQuality,
    reasoning:
      dqs >= 80
        ? 'Rich contact data — high confidence in personalization'
        : dqs >= 50
          ? 'Moderate data quality — some fields missing'
          : 'Low data quality — limited context for decision-making',
  };
}

function scoreContactEngagement(input: ConfidenceScorerInput): ConfidenceFactor {
  const { responseRate, lastInteractionDaysAgo, totalInteractions } =
    input.contactSignals;

  let score = 50; // Baseline
  const reasons: string[] = [];

  // Response rate
  const rr = responseRate ?? 0.5;
  if (rr >= 0.6) {
    score += 20;
    reasons.push('high response rate');
  } else if (rr >= 0.3) {
    score += 10;
    reasons.push('moderate response rate');
  } else {
    score -= 15;
    reasons.push('low response rate');
  }

  // Recency
  const days = lastInteractionDaysAgo ?? 7;
  if (days <= 3) {
    score += 15;
    reasons.push('recently active');
  } else if (days <= 7) {
    score += 5;
    reasons.push('active within a week');
  } else if (days > 14) {
    score -= 20;
    reasons.push('dormant (>14 days)');
  }

  // Interaction volume
  const interactions = totalInteractions ?? 0;
  if (interactions >= 5) {
    score += 10;
    reasons.push('established relationship');
  } else if (interactions <= 1) {
    score -= 10;
    reasons.push('minimal interaction history');
  }

  return {
    name: 'Contact Engagement',
    score: Math.min(100, Math.max(0, score)),
    weight: FACTOR_WEIGHTS.contactEngagement,
    reasoning: reasons.join('; ') || 'baseline engagement',
  };
}

function scoreActionAlignment(input: ConfidenceScorerInput): ConfidenceFactor {
  let score = 60; // Baseline — action determined by rules
  const reasons: string[] = [];

  // Higher confidence if gap suggestions align with chosen action
  if (input.gapContext?.suggestedActionsCount !== undefined) {
    if (input.gapContext.suggestedActionsCount > 0) {
      score += 15;
      reasons.push('gap has actionable suggestions');
    }
  }

  // Severity alignment — critical gaps with escalation = high confidence
  if (
    input.gapContext?.gapSeverity === 'critical' &&
    input.actionType === 'escalate_human'
  ) {
    score += 20;
    reasons.push('critical gap correctly routed to human');
  }

  // Penalize if action doesn't match severity
  if (
    input.gapContext?.gapSeverity === 'critical' &&
    input.actionType === 'wait'
  ) {
    score -= 30;
    reasons.push('WARNING: waiting on critical gap');
  }

  // Strategy-action coherence
  const strategyActionMap: Record<string, string[]> = {
    direct: ['send_message', 'book_meeting'],
    re_engage: ['send_message', 'schedule_follow_up'],
    trust_build: ['send_message', 'schedule_follow_up'],
    guided: ['send_message', 'update_crm'],
    escalate: ['escalate_human'],
    wait: ['wait', 'schedule_follow_up'],
  };
  const expectedActions = strategyActionMap[input.selectedStrategy] ?? [];
  if (expectedActions.includes(input.actionType)) {
    score += 10;
    reasons.push('action aligns with strategy');
  } else {
    score -= 15;
    reasons.push('action diverges from expected strategy pattern');
  }

  return {
    name: 'Action Alignment',
    score: Math.min(100, Math.max(0, score)),
    weight: FACTOR_WEIGHTS.actionAlignment,
    reasoning: reasons.join('; ') || 'baseline alignment',
  };
}

function scoreBrainCompleteness(input: ConfidenceScorerInput): ConfidenceFactor {
  let score = 30; // Low baseline — assumes minimal brain data
  const reasons: string[] = [];

  if (input.brainSignals?.hasCompanyTruth) {
    score += 25;
    reasons.push('company truth available');
  }
  if (input.brainSignals?.hasBlueprintStrategies) {
    score += 20;
    reasons.push('blueprint strategies loaded');
  }
  if (input.brainSignals?.hasHistoricalOutcomes) {
    score += 25;
    reasons.push('historical outcomes available');
  }

  return {
    name: 'Brain Completeness',
    score: Math.min(100, Math.max(0, score)),
    weight: FACTOR_WEIGHTS.brainCompleteness,
    reasoning: reasons.join('; ') || 'minimal brain data',
  };
}

function scoreHistoricalSuccess(input: ConfidenceScorerInput): ConfidenceFactor {
  const winRate = input.brainSignals?.strategyWinRate;
  const sampleSize = input.brainSignals?.sampleSize ?? 0;

  // No historical data — neutral score
  if (winRate === undefined || sampleSize < 5) {
    return {
      name: 'Historical Success',
      score: 50,
      weight: FACTOR_WEIGHTS.historicalSuccess,
      reasoning:
        sampleSize < 5
          ? `Insufficient historical data (n=${sampleSize})`
          : 'No historical data available',
    };
  }

  // Map win rate to confidence (50% = 50, 100% = 100, 0% = 0)
  const score = Math.round(winRate * 100);

  // Adjust for sample size — more data = more trust in the score
  const sizeMultiplier =
    sampleSize >= 50 ? 1.0 : sampleSize >= 20 ? 0.9 : sampleSize >= 10 ? 0.8 : 0.7;

  const adjustedScore = Math.round(score * sizeMultiplier);

  return {
    name: 'Historical Success',
    score: Math.min(100, Math.max(0, adjustedScore)),
    weight: FACTOR_WEIGHTS.historicalSuccess,
    reasoning: `Win rate: ${(winRate * 100).toFixed(0)}% (n=${sampleSize})`,
  };
}

// ─────────────────────────────────────────────
// Risk Flag Detection
// ─────────────────────────────────────────────

function detectRiskFlags(input: ConfidenceScorerInput): string[] {
  const flags: string[] = [];

  if ((input.contactSignals.dataQualityScore ?? 100) < 30) {
    flags.push('VERY_LOW_DATA_QUALITY');
  }
  if ((input.contactSignals.responseRate ?? 1) < 0.1 && (input.contactSignals.totalInteractions ?? 0) > 5) {
    flags.push('CONTACT_UNRESPONSIVE');
  }
  if (input.gapContext?.gapSeverity === 'critical') {
    flags.push('CRITICAL_GAP');
  }
  if (input.strategyConfidence < 50) {
    flags.push('LOW_STRATEGY_CONFIDENCE');
  }
  if (!input.brainSignals?.hasCompanyTruth) {
    flags.push('NO_COMPANY_TRUTH');
  }
  if ((input.contactSignals.lastInteractionDaysAgo ?? 0) > 30) {
    flags.push('CONTACT_DORMANT_30_PLUS_DAYS');
  }

  return flags;
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

/**
 * Calculate a confidence score (0-100) for the proposed action.
 * Combines multiple weighted factors into a single score.
 *
 * @param input - Combined strategy + action + contact + brain signals
 * @returns Confidence score with factor breakdown and risk flags
 */
export function scoreConfidence(
  input: ConfidenceScorerInput,
): ConfidenceScorerResult {
  const parsed = ConfidenceScorerInputSchema.parse(input);

  // Step 1: Score each factor
  const factors: ConfidenceFactor[] = [
    scoreStrategyConfidence(parsed),
    scoreDataQuality(parsed),
    scoreContactEngagement(parsed),
    scoreActionAlignment(parsed),
    scoreBrainCompleteness(parsed),
    scoreHistoricalSuccess(parsed),
  ];

  // Step 2: Calculate weighted overall score
  let totalWeightedScore = 0;
  const factorResults = factors.map((f) => {
    const weightedScore = Math.round(f.score * f.weight * 100) / 100;
    totalWeightedScore += weightedScore;
    return {
      name: f.name,
      score: f.score,
      weight: f.weight,
      weightedScore,
      reasoning: f.reasoning,
    };
  });

  const overallConfidence = Math.min(100, Math.max(0, Math.round(totalWeightedScore)));

  // Step 3: Detect risk flags
  const riskFlags = detectRiskFlags(parsed);

  // Step 4: Apply risk penalty — each flag reduces confidence by 5 (floor: 10)
  const riskPenalty = riskFlags.length * 5;
  const finalConfidence = Math.max(10, overallConfidence - riskPenalty);

  return ConfidenceScorerResultSchema.parse({
    contactId: parsed.contactId,
    tenantId: parsed.tenantId,
    objectiveId: parsed.objectiveId,
    overallConfidence: finalConfidence,
    factors: factorResults,
    riskFlags,
    scoredAt: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createConfidenceScorerRouter(): Router {
  const router = Router();

  /**
   * POST /api/decision/score-confidence
   * Calculate confidence score for a proposed action.
   */
  router.post('/score-confidence', async (req: Request, res: Response) => {
    try {
      const input = ConfidenceScorerInputSchema.parse(req.body);
      const result = scoreConfidence(input);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[ConfidenceScorer] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Confidence scoring failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  scoreStrategyConfidence,
  scoreDataQuality,
  scoreContactEngagement,
  scoreActionAlignment,
  scoreBrainCompleteness,
  scoreHistoricalSuccess,
  detectRiskFlags,
  FACTOR_WEIGHTS,
};
