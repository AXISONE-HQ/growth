/**
 * Strategy Selector — KAN-36
 *
 * Decision Engine — DECIDE phase, Step 2
 * Given a gap report from the Objective Gap Analyzer, select the best
 * strategy for addressing the contact's needs. Rule-based MVP with
 * Sonnet LLM fallback for complex or ambiguous cases.
 *
 * Architecture reference:
 *   Objective Gap Analyzer output (GapReport)
 *       │
 *   Strategy Selector  ← Which strategy fits?
 *   (Direct / Re-engage / Trust / Guided)
 *       │
 *   Action Determiner  ← What is the single best next action?
 *
 * Strategies:
 *   - direct:      Push toward conversion (high confidence, engaged contact)
 *   - re_engage:   Revive stalled or dormant contacts
 *   - trust_build: Nurture early-funnel contacts with value-first approach
 *   - guided:      Structured path for retention/expansion
 *   - escalate:    Route to human (critical issues, low confidence)
 *   - wait:        Hold — dependencies unresolved or timing not right
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const StrategyType = z.enum([
  'direct',
  're_engage',
  'trust_build',
  'guided',
  'escalate',
  'wait',
]);

export const StrategySelectionInputSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string(),
  objectiveType: z.string(),
  overallProgress: z.number().min(0).max(1),
  overallHealth: z.enum(['on_track', 'at_risk', 'off_track', 'stalled']),
  gapCount: z.number(),
  primaryGap: z
    .object({
      subObjectiveId: z.string(),
      subObjectiveName: z.string(),
      category: z.string(),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      reason: z.enum([
        'not_started',
        'stalled',
        'failed_needs_retry',
        'dependency_blocked',
        'overdue',
      ]),
      weight: z.number(),
      priorityScore: z.number(),
      blockedBy: z.array(z.string()),
      suggestedActions: z.array(z.string()),
    })
    .nullable(),
  recommendedStrategy: StrategyType.nullable(),
  contactContext: z.object({
    lifecycleStage: z.string().optional(),
    segment: z.string().optional(),
    lastInteractionDaysAgo: z.number().optional(),
    totalInteractions: z.number().optional(),
    responseRate: z.number().min(0).max(1).optional(),
    preferredChannel: z.string().optional(),
    dataQualityScore: z.number().min(0).max(100).optional(),
  }).optional(),
  brainContext: z.object({
    companyTruth: z.record(z.unknown()).optional(),
    blueprintStrategies: z.array(z.string()).optional(),
    strategyWeights: z.record(z.number()).optional(),
  }).optional(),
});

export const StrategySelectionResultSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string(),
  selectedStrategy: StrategyType,
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
  selectionMethod: z.enum(['rule_based', 'llm_fallback', 'brain_weighted']),
  alternativeStrategies: z.array(
    z.object({
      strategy: StrategyType,
      score: z.number(),
      reason: z.string(),
    }),
  ),
  selectedAt: z.string().datetime(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type StrategySelectionInput = z.infer<typeof StrategySelectionInputSchema>;
export type StrategySelectionResult = z.infer<typeof StrategySelectionResultSchema>;
type StrategyTypeValue = z.infer<typeof StrategyType>;

interface StrategyScore {
  strategy: StrategyTypeValue;
  score: number;
  reason: string;
}

// ─────────────────────────────────────────────
// Rule-Based Strategy Selection (MVP)
// ─────────────────────────────────────────────

/**
 * Score each strategy based on the input context.
 * Returns scored strategies sorted by score descending.
 */
function scoreStrategies(input: StrategySelectionInput): StrategyScore[] {
  const scores: StrategyScore[] = [];
  const {
    overallProgress,
    overallHealth,
    gapCount,
    primaryGap,
    contactContext,
  } = input;

  const lastInteractionDays = contactContext?.lastInteractionDaysAgo ?? 0;
  const responseRate = contactContext?.responseRate ?? 0.5;
  const totalInteractions = contactContext?.totalInteractions ?? 0;

  // ── Direct Strategy ──
  // Best when contact is engaged and close to conversion
  {
    let score = 0;
    const reasons: string[] = [];

    if (overallProgress >= 0.5) {
      score += 30;
      reasons.push('good progress (>50%)');
    }
    if (overallHealth === 'on_track') {
      score += 20;
      reasons.push('on track');
    }
    if (responseRate >= 0.5) {
      score += 15;
      reasons.push('good response rate');
    }
    if (primaryGap?.category === 'conversion') {
      score += 25;
      reasons.push('conversion gap identified');
    }
    if (lastInteractionDays <= 3) {
      score += 10;
      reasons.push('recently active');
    }

    // Penalize if stalled or low engagement
    if (overallHealth === 'stalled') score -= 30;
    if (lastInteractionDays > 14) score -= 20;

    scores.push({
      strategy: 'direct',
      score: Math.max(0, score),
      reason: reasons.join('; ') || 'baseline',
    });
  }

  // ── Re-engage Strategy ──
  // Best for stalled or dormant contacts
  {
    let score = 0;
    const reasons: string[] = [];

    if (overallHealth === 'stalled') {
      score += 35;
      reasons.push('objective stalled');
    }
    if (lastInteractionDays > 7) {
      score += 20;
      reasons.push(`no interaction in ${lastInteractionDays} days`);
    }
    if (lastInteractionDays > 14) {
      score += 15;
      reasons.push('dormant contact');
    }
    if (primaryGap?.reason === 'stalled') {
      score += 20;
      reasons.push('primary gap is stalled');
    }
    if (responseRate < 0.2 && totalInteractions > 3) {
      score += 10;
      reasons.push('low response rate');
    }

    // Penalize if actively engaged
    if (lastInteractionDays <= 2) score -= 25;
    if (overallHealth === 'on_track') score -= 15;

    scores.push({
      strategy: 're_engage',
      score: Math.max(0, score),
      reason: reasons.join('; ') || 'baseline',
    });
  }

  // ── Trust Build Strategy ──
  // Best for early-funnel, new, or low-data contacts
  {
    let score = 0;
    const reasons: string[] = [];

    if (overallProgress < 0.2) {
      score += 25;
      reasons.push('early stage (<20% progress)');
    }
    if (totalInteractions <= 2) {
      score += 20;
      reasons.push('few interactions');
    }
    if (
      primaryGap?.category === 'awareness' ||
      primaryGap?.category === 'engagement'
    ) {
      score += 20;
      reasons.push(`early funnel gap: ${primaryGap.category}`);
    }
    if ((contactContext?.dataQualityScore ?? 100) < 50) {
      score += 15;
      reasons.push('low data quality — need to learn more');
    }

    // Penalize if well into the funnel
    if (overallProgress >= 0.5) score -= 20;
    if (primaryGap?.category === 'conversion') score -= 15;

    scores.push({
      strategy: 'trust_build',
      score: Math.max(0, score),
      reason: reasons.join('; ') || 'baseline',
    });
  }

  // ── Guided Strategy ──
  // Best for retention, expansion, or complex journeys
  {
    let score = 0;
    const reasons: string[] = [];

    if (
      input.objectiveType === 'customer_retention' ||
      input.objectiveType === 'upsell' ||
      input.objectiveType === 'renewal'
    ) {
      score += 30;
      reasons.push(`objective type: ${input.objectiveType}`);
    }
    if (
      primaryGap?.category === 'retention' ||
      primaryGap?.category === 'expansion'
    ) {
      score += 25;
      reasons.push(`${primaryGap.category} gap`);
    }
    if (gapCount >= 3) {
      score += 10;
      reasons.push('multiple gaps — structured approach needed');
    }
    if (overallHealth === 'at_risk') {
      score += 15;
      reasons.push('at risk — needs careful guidance');
    }

    scores.push({
      strategy: 'guided',
      score: Math.max(0, score),
      reason: reasons.join('; ') || 'baseline',
    });
  }

  // ── Escalate Strategy ──
  // When AI confidence is too low or critical issues exist
  {
    let score = 0;
    const reasons: string[] = [];

    if (primaryGap?.severity === 'critical') {
      score += 35;
      reasons.push('critical gap');
    }
    if (overallHealth === 'off_track') {
      score += 20;
      reasons.push('objective off track');
    }
    if (
      primaryGap?.reason === 'failed_needs_retry' &&
      primaryGap.suggestedActions.some((a) => a.includes('Escalate'))
    ) {
      score += 30;
      reasons.push('max retries exceeded');
    }

    scores.push({
      strategy: 'escalate',
      score: Math.max(0, score),
      reason: reasons.join('; ') || 'baseline',
    });
  }

  // ── Wait Strategy ──
  // When dependencies are blocked or timing is wrong
  {
    let score = 0;
    const reasons: string[] = [];

    if (primaryGap?.reason === 'dependency_blocked') {
      score += 40;
      reasons.push('primary gap is dependency-blocked');
    }
    if (gapCount === 0) {
      score += 30;
      reasons.push('no actionable gaps');
    }
    if (lastInteractionDays <= 1 && responseRate >= 0.5) {
      score += 10;
      reasons.push('recently contacted — avoid over-communication');
    }

    scores.push({
      strategy: 'wait',
      score: Math.max(0, score),
      reason: reasons.join('; ') || 'baseline',
    });
  }

  // Sort by score descending
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Apply Brain-learned strategy weights to adjust scores.
 * Strategy weights from the Learning Service represent historical
 * win rates per strategy type.
 */
function applyBrainWeights(
  scores: StrategyScore[],
  strategyWeights: Record<string, number> | undefined,
): StrategyScore[] {
  if (!strategyWeights || Object.keys(strategyWeights).length === 0) {
    return scores;
  }

  return scores
    .map((s) => {
      const weight = strategyWeights[s.strategy];
      if (weight !== undefined && weight > 0) {
        // Blend: 70% rule-based + 30% learned weight
        const adjustedScore = s.score * 0.7 + weight * 100 * 0.3;
        return {
          ...s,
          score: Math.round(adjustedScore * 100) / 100,
          reason: `${s.reason}; brain weight: ${(weight * 100).toFixed(0)}%`,
        };
      }
      return s;
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Determine confidence in the strategy selection.
 * Higher gap between top two strategies = higher confidence.
 */
function calculateSelectionConfidence(scores: StrategyScore[]): number {
  if (scores.length === 0) return 0;
  if (scores.length === 1) return 80;

  const topScore = scores[0].score;
  const secondScore = scores[1].score;

  // No clear winner
  if (topScore === 0) return 10;

  // Gap-based confidence
  const gap = topScore - secondScore;
  const gapRatio = topScore > 0 ? gap / topScore : 0;

  // Map gapRatio to confidence: 0% gap = 40 confidence, 100% gap = 95 confidence
  const confidence = Math.min(95, Math.max(40, 40 + gapRatio * 55));

  return Math.round(confidence);
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

/**
 * Select the best strategy for a contact based on gap analysis
 * and business context. Rule-based MVP.
 *
 * @param input - Combined gap report + contact context + brain context
 * @returns Strategy selection result with confidence and reasoning
 */
export function selectStrategy(
  input: StrategySelectionInput,
): StrategySelectionResult {
  const parsed = StrategySelectionInputSchema.parse(input);

  // Step 1: Score all strategies using rules
  let scores = scoreStrategies(parsed);

  // Step 2: Apply Brain-learned weights if available
  let selectionMethod: StrategySelectionResult['selectionMethod'] = 'rule_based';
  if (parsed.brainContext?.strategyWeights) {
    scores = applyBrainWeights(scores, parsed.brainContext.strategyWeights);
    selectionMethod = 'brain_weighted';
  }

  // Step 3: Use gap analyzer's recommendation as a tiebreaker
  if (
    parsed.recommendedStrategy &&
    scores.length >= 2 &&
    scores[0].score === scores[1].score
  ) {
    const recIdx = scores.findIndex(
      (s) => s.strategy === parsed.recommendedStrategy,
    );
    if (recIdx > 0) {
      // Boost recommended strategy by 1 point to break tie
      scores[recIdx].score += 1;
      scores[recIdx].reason += '; gap-analyzer recommendation tiebreaker';
      scores.sort((a, b) => b.score - a.score);
    }
  }

  // Step 4: Calculate confidence
  const confidence = calculateSelectionConfidence(scores);

  // Step 5: Build result
  const winner = scores[0];
  const alternatives = scores
    .slice(1)
    .filter((s) => s.score > 0)
    .map((s) => ({
      strategy: s.strategy,
      score: s.score,
      reason: s.reason,
    }));

  const result: StrategySelectionResult = {
    contactId: parsed.contactId,
    tenantId: parsed.tenantId,
    objectiveId: parsed.objectiveId,
    selectedStrategy: winner.strategy,
    confidence,
    reasoning: `Selected "${winner.strategy}" (score: ${winner.score}). ${winner.reason}.`,
    selectionMethod,
    alternativeStrategies: alternatives,
    selectedAt: new Date().toISOString(),
  };

  return StrategySelectionResultSchema.parse(result);
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createStrategyRouter(): Router {
  const router = Router();

  /**
   * POST /api/decision/select-strategy
   * Select the best strategy for a contact based on gap analysis.
   */
  router.post('/select-strategy', async (req: Request, res: Response) => {
    try {
      const input = StrategySelectionInputSchema.parse(req.body);
      const result = selectStrategy(input);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[StrategySelector] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Strategy selection failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  scoreStrategies,
  applyBrainWeights,
  calculateSelectionConfidence,
};
