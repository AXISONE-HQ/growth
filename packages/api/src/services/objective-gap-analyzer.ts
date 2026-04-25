/**
 * Objective Gap Analyzer — KAN-35
 *
 * Decision Engine — DECIDE phase, Step 1
 * Examines a contact's current state against stated objectives to identify
 * missing sub-objectives and gaps. Returns a structured gap report that
 * feeds into the Strategy Selector.
 *
 * Architecture reference:
 *   contact.state + Brain context
 *         │
 *   Objective Gap Analyzer  ← What sub-objectives are missing?
 *         │
 *   Strategy Selector       ← Which strategy fits?
 */

import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const SubObjectiveStatus = z.enum([
  'not_started',
  'in_progress',
  'completed',
  'failed',
  'skipped',
]);

export const SubObjectiveSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: SubObjectiveStatus,
  weight: z.number().min(0).max(1).default(1),
  completedAt: z.string().datetime().nullable().optional(),
  dependsOn: z.array(z.string()).default([]),
  category: z.enum([
    'awareness',
    'engagement',
    'qualification',
    'conversion',
    'retention',
    'expansion',
  ]),
  metadata: z.record(z.unknown()).optional(),
});

export const ObjectiveSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  type: z.enum([
    'lead_conversion',
    'customer_retention',
    'upsell',
    're_engagement',
    'onboarding',
    'renewal',
    'win_back',
  ]),
  name: z.string(),
  successCondition: z.object({
    metric: z.string(),
    operator: z.enum(['eq', 'gt', 'gte', 'lt', 'lte']),
    value: z.number(),
    timeframeDays: z.number().optional(),
  }),
  subObjectives: z.array(SubObjectiveSchema),
  blueprintId: z.string().optional(),
  createdAt: z.string().datetime(),
});

export const ContactStateSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  subObjectives: z.record(z.object({
    status: SubObjectiveStatus,
    completedAt: z.string().datetime().nullable().optional(),
    attempts: z.number().default(0),
    lastAttemptAt: z.string().datetime().nullable().optional(),
    notes: z.string().optional(),
  })),
  strategyCurrent: z.string().nullable(),
  confidenceScore: z.number().min(0).max(100).nullable(),
  updatedAt: z.string().datetime(),
});

export const GapSeverity = z.enum(['critical', 'high', 'medium', 'low']);

export const GapSchema = z.object({
  subObjectiveId: z.string(),
  subObjectiveName: z.string(),
  category: z.string(),
  severity: GapSeverity,
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
  metadata: z.record(z.unknown()).optional(),
});

export const GapReportSchema = z.object({
  contactId: z.string(),
  objectiveId: z.string(),
  objectiveType: z.string(),
  tenantId: z.string(),
  analyzedAt: z.string().datetime(),
  overallProgress: z.number().min(0).max(1),
  overallHealth: z.enum(['on_track', 'at_risk', 'off_track', 'stalled']),
  totalSubObjectives: z.number(),
  completedCount: z.number(),
  inProgressCount: z.number(),
  gapCount: z.number(),
  gaps: z.array(GapSchema),
  primaryGap: GapSchema.nullable(),
  recommendedStrategy: z.enum([
    'direct',
    're_engage',
    'trust_build',
    'guided',
    'escalate',
    'wait',
  ]).nullable(),
  contextSummary: z.string(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type SubObjective = z.infer<typeof SubObjectiveSchema>;
export type Objective = z.infer<typeof ObjectiveSchema>;
export type ContactState = z.infer<typeof ContactStateSchema>;
export type Gap = z.infer<typeof GapSchema>;
export type GapReport = z.infer<typeof GapReportSchema>;
type GapSeverityType = z.infer<typeof GapSeverity>;

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const SEVERITY_WEIGHTS: Record<GapSeverityType, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const CATEGORY_ORDER: Record<string, number> = {
  awareness: 1,
  engagement: 2,
  qualification: 3,
  conversion: 4,
  retention: 5,
  expansion: 6,
};

const STALL_THRESHOLD_HOURS = 72; // 3 days without progress = stalled
const MAX_RETRY_ATTEMPTS = 3;

// ─────────────────────────────────────────────
// Gap Analysis Functions (KAN-154)
// ─────────────────────────────────────────────

/**
 * Analyze a single sub-objective to determine if it represents a gap.
 * Returns null if the sub-objective is completed or skipped.
 */
function analyzeSubObjective(
  subObj: SubObjective,
  stateEntry: ContactState['subObjectives'][string] | undefined,
  allSubObjectives: SubObjective[],
  contactState: ContactState,
): Gap | null {
  const status = stateEntry?.status ?? 'not_started';

  // Completed or intentionally skipped — not a gap
  if (status === 'completed' || status === 'skipped') {
    return null;
  }

  // Check dependency blocking
  const blockedBy = subObj.dependsOn.filter((depId) => {
    const depState = contactState.subObjectives[depId];
    return !depState || depState.status !== 'completed';
  });
  const isDependencyBlocked = blockedBy.length > 0;

  // Determine reason
  let reason: Gap['reason'];
  if (isDependencyBlocked) {
    reason = 'dependency_blocked';
  } else if (status === 'failed') {
    reason = 'failed_needs_retry';
  } else if (status === 'in_progress' && stateEntry?.lastAttemptAt) {
    const hoursSinceAttempt =
      (Date.now() - new Date(stateEntry.lastAttemptAt).getTime()) /
      (1000 * 60 * 60);
    reason = hoursSinceAttempt > STALL_THRESHOLD_HOURS ? 'stalled' : 'not_started';
  } else if (status === 'not_started') {
    reason = 'not_started';
  } else {
    reason = 'not_started';
  }

  // Determine severity
  const severity = calculateGapSeverity(subObj, stateEntry, reason);

  // Calculate priority score
  const priorityScore = calculatePriorityScore(subObj, severity, reason, isDependencyBlocked);

  // Generate suggested actions
  const suggestedActions = generateSuggestedActions(subObj, reason, stateEntry);

  return {
    subObjectiveId: subObj.id,
    subObjectiveName: subObj.name,
    category: subObj.category,
    severity,
    reason,
    weight: subObj.weight,
    priorityScore,
    blockedBy,
    suggestedActions,
  };
}

/**
 * Calculate gap severity based on sub-objective properties and state.
 */
function calculateGapSeverity(
  subObj: SubObjective,
  stateEntry: ContactState['subObjectives'][string] | undefined,
  reason: Gap['reason'],
): GapSeverityType {
  // Failed after max retries → critical
  if (reason === 'failed_needs_retry' && (stateEntry?.attempts ?? 0) >= MAX_RETRY_ATTEMPTS) {
    return 'critical';
  }

  // High-weight conversion/retention gaps → critical
  if (subObj.weight >= 0.8 && ['conversion', 'retention'].includes(subObj.category)) {
    return 'critical';
  }

  // Stalled items → high
  if (reason === 'stalled') {
    return 'high';
  }

  // Failed items needing retry → high
  if (reason === 'failed_needs_retry') {
    return 'high';
  }

  // Early funnel gaps with high weight → medium
  if (subObj.weight >= 0.5) {
    return 'medium';
  }

  // Dependency-blocked items → low (can't act on them directly)
  if (reason === 'dependency_blocked') {
    return 'low';
  }

  return 'medium';
}

/**
 * Generate suggested actions based on gap reason and context.
 */
function generateSuggestedActions(
  subObj: SubObjective,
  reason: Gap['reason'],
  stateEntry: ContactState['subObjectives'][string] | undefined,
): string[] {
  const actions: string[] = [];

  switch (reason) {
    case 'not_started':
      actions.push(`Initiate ${subObj.category} action for: ${subObj.name}`);
      if (subObj.category === 'awareness') {
        actions.push('Send introductory message');
      } else if (subObj.category === 'engagement') {
        actions.push('Send follow-up with value proposition');
      } else if (subObj.category === 'conversion') {
        actions.push('Present offer or proposal');
      }
      break;

    case 'stalled':
      actions.push(`Re-engage: ${subObj.name} has stalled`);
      actions.push('Try alternative channel or message approach');
      if ((stateEntry?.attempts ?? 0) > 1) {
        actions.push('Consider escalation to human');
      }
      break;

    case 'failed_needs_retry':
      if ((stateEntry?.attempts ?? 0) >= MAX_RETRY_ATTEMPTS) {
        actions.push('Escalate to human — max retries exceeded');
      } else {
        actions.push(`Retry with adjusted strategy (attempt ${(stateEntry?.attempts ?? 0) + 1})`);
        actions.push('Analyze failure reason and adapt approach');
      }
      break;

    case 'dependency_blocked':
      actions.push(`Resolve blocking dependencies first`);
      subObj.dependsOn.forEach((depId) => {
        actions.push(`Complete dependency: ${depId}`);
      });
      break;

    case 'overdue':
      actions.push('Urgently address overdue sub-objective');
      actions.push('Consider direct outreach or escalation');
      break;
  }

  return actions;
}

// ─────────────────────────────────────────────
// Gap Prioritization Logic (KAN-155)
// ─────────────────────────────────────────────

/**
 * Calculate a numeric priority score for ranking gaps.
 * Higher score = higher priority.
 */
function calculatePriorityScore(
  subObj: SubObjective,
  severity: GapSeverityType,
  reason: Gap['reason'],
  isDependencyBlocked: boolean,
): number {
  let score = 0;

  // Base severity weight (0-40)
  score += SEVERITY_WEIGHTS[severity] * 10;

  // Sub-objective weight contribution (0-20)
  score += subObj.weight * 20;

  // Category position — earlier in funnel = higher urgency (0-12)
  const categoryPos = CATEGORY_ORDER[subObj.category] ?? 3;
  score += (7 - categoryPos) * 2;

  // Actionability bonus — items we can act on NOW get priority
  if (!isDependencyBlocked) {
    score += 10;
  }

  // Reason-specific adjustments
  if (reason === 'stalled') {
    score += 5; // Stalled items need attention
  }
  if (reason === 'failed_needs_retry') {
    score += 8; // Failed items are urgent
  }
  if (reason === 'dependency_blocked') {
    score -= 15; // Can't act directly — lower priority
  }

  return Math.max(0, Math.round(score * 100) / 100);
}

/**
 * Sort gaps by priority score (descending) with tiebreakers.
 */
function prioritizeGaps(gaps: Gap[]): Gap[] {
  return [...gaps].sort((a, b) => {
    // Primary: priority score descending
    if (b.priorityScore !== a.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }

    // Tiebreaker 1: severity
    if (SEVERITY_WEIGHTS[b.severity] !== SEVERITY_WEIGHTS[a.severity]) {
      return SEVERITY_WEIGHTS[b.severity] - SEVERITY_WEIGHTS[a.severity];
    }

    // Tiebreaker 2: weight
    if (b.weight !== a.weight) {
      return b.weight - a.weight;
    }

    // Tiebreaker 3: earlier category first
    const catA = CATEGORY_ORDER[a.category] ?? 99;
    const catB = CATEGORY_ORDER[b.category] ?? 99;
    return catA - catB;
  });
}

// ─────────────────────────────────────────────
// Health Assessment
// ─────────────────────────────────────────────

/**
 * Determine overall objective health based on progress and gap analysis.
 */
function assessObjectiveHealth(
  progress: number,
  gaps: Gap[],
  completedCount: number,
  totalCount: number,
): GapReport['overallHealth'] {
  const criticalGaps = gaps.filter((g) => g.severity === 'critical').length;
  const highGaps = gaps.filter((g) => g.severity === 'high').length;
  const stalledGaps = gaps.filter((g) => g.reason === 'stalled').length;

  // Stalled: no progress and critical/stalled gaps
  if (progress === 0 && totalCount > 0) {
    return 'stalled';
  }
  if (stalledGaps >= 2 || (stalledGaps >= 1 && progress < 0.2)) {
    return 'stalled';
  }

  // Off track: critical gaps or very low progress with many gaps
  if (criticalGaps > 0) {
    return 'off_track';
  }
  if (progress < 0.3 && gaps.length > totalCount * 0.7) {
    return 'off_track';
  }

  // At risk: high gaps or moderate gap ratio
  if (highGaps >= 2) {
    return 'at_risk';
  }
  if (gaps.length > totalCount * 0.5) {
    return 'at_risk';
  }

  return 'on_track';
}

/**
 * Recommend a high-level strategy based on the gap analysis.
 */
function recommendStrategy(
  gaps: Gap[],
  health: GapReport['overallHealth'],
  progress: number,
): GapReport['recommendedStrategy'] {
  if (gaps.length === 0) {
    return null; // No gaps — objective may be complete
  }

  const primaryGap = gaps[0];
  const criticalCount = gaps.filter((g) => g.severity === 'critical').length;
  const failedCount = gaps.filter((g) => g.reason === 'failed_needs_retry').length;

  // Escalate if too many failures or critical issues
  if (criticalCount >= 2 || failedCount >= MAX_RETRY_ATTEMPTS) {
    return 'escalate';
  }

  // Wait if all actionable gaps are dependency-blocked
  const actionableGaps = gaps.filter((g) => g.reason !== 'dependency_blocked');
  if (actionableGaps.length === 0) {
    return 'wait';
  }

  // Strategy based on primary gap category and health
  if (health === 'stalled') {
    return 're_engage';
  }

  if (primaryGap.category === 'awareness' || primaryGap.category === 'engagement') {
    return progress < 0.2 ? 'trust_build' : 'direct';
  }

  if (primaryGap.category === 'conversion') {
    return 'direct';
  }

  if (primaryGap.category === 'retention' || primaryGap.category === 'expansion') {
    return 'guided';
  }

  return 'direct';
}

/**
 * Generate a human-readable context summary for the gap report.
 */
function generateContextSummary(
  objective: Objective,
  progress: number,
  health: GapReport['overallHealth'],
  gaps: Gap[],
  completedCount: number,
): string {
  const parts: string[] = [];

  parts.push(
    `Objective "${objective.name}" (${objective.type}) is ${Math.round(progress * 100)}% complete.`,
  );
  parts.push(`${completedCount} of ${objective.subObjectives.length} sub-objectives done.`);
  parts.push(`Health: ${health.replace('_', ' ')}.`);

  if (gaps.length > 0) {
    parts.push(`${gaps.length} gap(s) identified.`);
    const criticals = gaps.filter((g) => g.severity === 'critical');
    if (criticals.length > 0) {
      parts.push(
        `Critical: ${criticals.map((g) => g.subObjectiveName).join(', ')}.`,
      );
    }
    parts.push(`Top priority: ${gaps[0].subObjectiveName} (${gaps[0].reason}).`);
  } else {
    parts.push('No gaps — all sub-objectives are on track or complete.');
  }

  return parts.join(' ');
}

// ─────────────────────────────────────────────
// Structured Gap Report (KAN-156)
// ─────────────────────────────────────────────

/**
 * Main entry point: analyze gaps for a contact's objective.
 *
 * Takes an objective definition and the contact's current state,
 * returns a fully structured gap report with prioritized gaps,
 * health assessment, and strategy recommendation.
 */
export function analyzeObjectiveGaps(
  objective: Objective,
  contactState: ContactState,
): GapReport {
  const { subObjectives } = objective;

  // Analyze each sub-objective for gaps
  const rawGaps: Gap[] = [];
  let completedCount = 0;
  let inProgressCount = 0;

  for (const subObj of subObjectives) {
    const stateEntry = contactState.subObjectives[subObj.id];
    const effectiveStatus = stateEntry?.status ?? 'not_started';

    if (effectiveStatus === 'completed') {
      completedCount++;
      continue;
    }
    if (effectiveStatus === 'in_progress') {
      inProgressCount++;
    }

    const gap = analyzeSubObjective(subObj, stateEntry, subObjectives, contactState);
    if (gap) {
      rawGaps.push(gap);
    }
  }

  // Prioritize gaps
  const gaps = prioritizeGaps(rawGaps);

  // Calculate overall progress (weighted)
  const totalWeight = subObjectives.reduce((sum, s) => sum + s.weight, 0);
  const completedWeight = subObjectives
    .filter((s) => {
      const st = contactState.subObjectives[s.id];
      return st?.status === 'completed';
    })
    .reduce((sum, s) => sum + s.weight, 0);
  const overallProgress = totalWeight > 0 ? completedWeight / totalWeight : 0;

  // Assess health
  const overallHealth = assessObjectiveHealth(
    overallProgress,
    gaps,
    completedCount,
    subObjectives.length,
  );

  // Recommend strategy
  const recommendedStrategy = recommendStrategy(gaps, overallHealth, overallProgress);

  // Build context summary
  const contextSummary = generateContextSummary(
    objective,
    overallProgress,
    overallHealth,
    gaps,
    completedCount,
  );

  const report: GapReport = {
    contactId: contactState.contactId,
    objectiveId: objective.id,
    objectiveType: objective.type,
    tenantId: objective.tenantId,
    analyzedAt: new Date().toISOString(),
    overallProgress: Math.round(overallProgress * 1000) / 1000,
    overallHealth,
    totalSubObjectives: subObjectives.length,
    completedCount,
    inProgressCount,
    gapCount: gaps.length,
    gaps,
    primaryGap: gaps.length > 0 ? gaps[0] : null,
    recommendedStrategy,
    contextSummary,
  };

  return GapReportSchema.parse(report);
}

// ─────────────────────────────────────────────
// Database Integration
// ─────────────────────────────────────────────

/**
 * Fetch objective and contact state from database, then analyze gaps.
 * This is the primary integration point for the Decision Engine pipeline.
 */
export async function analyzeGapsForContact(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  objectiveId: string,
): Promise<GapReport> {
  // Fetch objective with sub-objectives
  const objective = await prisma.objective.findFirstOrThrow({
    where: {
      id: objectiveId,
      tenantId,
    },
  });

  // Fetch contact state for this objective
  const contactState = await prisma.contactState.findFirstOrThrow({
    where: {
      contactId,
      objectiveId,
    },
  });

  // Parse into typed structures
  const parsedObjective = ObjectiveSchema.parse({
    id: objective.id,
    tenantId: objective.tenantId,
    type: objective.type,
    name: (objective as any).name ?? objective.type,
    successCondition: objective.successCondition,
    subObjectives: (objective as any).subObjectives ?? [],
    blueprintId: objective.blueprintId,
    createdAt: objective.createdAt?.toISOString() ?? new Date().toISOString(),
  });

  const parsedState = ContactStateSchema.parse({
    id: contactState.id,
    contactId: contactState.contactId,
    objectiveId: contactState.objectiveId,
    subObjectives: (contactState as any).subObjectives ?? {},
    strategyCurrent: contactState.strategyCurrent,
    confidenceScore: contactState.confidenceScore,
    updatedAt: contactState.updatedAt?.toISOString() ?? new Date().toISOString(),
  });

  return analyzeObjectiveGaps(parsedObjective, parsedState);
}

/**
 * Analyze gaps for ALL active objectives of a contact.
 * Returns an array of gap reports, one per objective.
 */
export async function analyzeAllGapsForContact(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
): Promise<GapReport[]> {
  const contactStates = await prisma.contactState.findMany({
    where: { contactId },
  });

  const reports: GapReport[] = [];

  for (const state of contactStates) {
    try {
      const report = await analyzeGapsForContact(
        prisma,
        tenantId,
        contactId,
        state.objectiveId,
      );
      reports.push(report);
    } catch (err) {
      console.error(
        `[GapAnalyzer] Failed to analyze objective ${state.objectiveId} for contact ${contactId}:`,
        err,
      );
    }
  }

  return reports;
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createGapAnalyzerRouter(prisma: PrismaClient): Router {
  const router = Router();

  /**
   * POST /api/decision/analyze-gaps
   * Analyze objective gaps for a specific contact + objective.
   */
  router.post('/analyze-gaps', async (req: Request, res: Response) => {
    try {
      const { tenantId, contactId, objectiveId } = z
        .object({
          tenantId: z.string(),
          contactId: z.string(),
          objectiveId: z.string(),
        })
        .parse(req.body);

      const report = await analyzeGapsForContact(
        prisma,
        tenantId,
        contactId,
        objectiveId,
      );

      res.json({ success: true, data: report });
    } catch (err: any) {
      console.error('[GapAnalyzer] Error:', err);
      res.status(err.code === 'P2025' ? 404 : 500).json({
        success: false,
        error: err.message ?? 'Gap analysis failed',
      });
    }
  });

  /**
   * POST /api/decision/analyze-all-gaps
   * Analyze all objective gaps for a contact.
   */
  router.post('/analyze-all-gaps', async (req: Request, res: Response) => {
    try {
      const { tenantId, contactId } = z
        .object({
          tenantId: z.string(),
          contactId: z.string(),
        })
        .parse(req.body);

      const reports = await analyzeAllGapsForContact(
        prisma,
        tenantId,
        contactId,
      );

      res.json({
        success: true,
        data: {
          contactId,
          reportCount: reports.length,
          reports,
          worstHealth: reports.reduce(
            (worst, r) => {
              const order = { stalled: 0, off_track: 1, at_risk: 2, on_track: 3 };
              return order[r.overallHealth] < order[worst]
                ? r.overallHealth
                : worst;
            },
            'on_track' as GapReport['overallHealth'],
          ),
        },
      });
    } catch (err: any) {
      console.error('[GapAnalyzer] Error:', err);
      res.status(500).json({
        success: false,
        error: err.message ?? 'Gap analysis failed',
      });
    }
  });

  /**
   * GET /api/decision/gap-summary/:contactId
   * Quick summary of gap status for a contact.
   */
  router.get('/gap-summary/:contactId', async (req: Request, res: Response) => {
    try {
      const tenantId = req.headers['x-tenant-id'] as string;
      if (!tenantId) {
        res.status(400).json({ success: false, error: 'Missing x-tenant-id header' });
        return;
      }

      const { contactId } = req.params;
      if (typeof contactId !== 'string') {
        res.status(400).json({ success: false, error: 'Invalid contactId' });
        return;
      }
      const reports = await analyzeAllGapsForContact(prisma, tenantId, contactId);

      const summary = reports.map((r) => ({
        objectiveId: r.objectiveId,
        objectiveType: r.objectiveType,
        progress: r.overallProgress,
        health: r.overallHealth,
        gapCount: r.gapCount,
        primaryGap: r.primaryGap
          ? {
              name: r.primaryGap.subObjectiveName,
              severity: r.primaryGap.severity,
              reason: r.primaryGap.reason,
            }
          : null,
        recommendedStrategy: r.recommendedStrategy,
      }));

      res.json({ success: true, data: { contactId, objectives: summary } });
    } catch (err: any) {
      console.error('[GapAnalyzer] Error:', err);
      res.status(500).json({
        success: false,
        error: err.message ?? 'Gap summary failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  analyzeSubObjective,
  calculateGapSeverity,
  calculatePriorityScore,
  prioritizeGaps,
  assessObjectiveHealth,
  recommendStrategy,
  generateContextSummary,
  generateSuggestedActions,
};
