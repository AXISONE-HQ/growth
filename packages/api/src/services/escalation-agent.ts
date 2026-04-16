/**
 * Escalation Agent â KAN-379
 *
 * Agent Dispatcher â EXECUTE phase
 * Routes actions to human operators when AI confidence is too low,
 * risk flags are triggered, or the contact requests human assistance.
 * Generates a full conversation summary and context handoff package.
 *
 * Architecture reference:
 *   Agent Router (escalation)
 *       â
 *   Escalation Agent
 *       â
 *   âââââ´âââââââââââââââââââ¬âââââââââââââââââââ
 *   Build Context Summary  Assign to Queue     Notify Assignee
 *       â
 *   escalation.triggered â Pub/Sub
 *
 * Escalation reasons:
 *   - low_confidence: Decision Engine score below threshold
 *   - risk_flag: Critical risk flag detected (e.g., CRITICAL_GAP, CONTACT_UNRESPONSIVE)
 *   - human_requested: Contact explicitly asked for a human
 *   - compliance_block: Guardrail layer blocked the action
 *   - max_attempts: AI retries exhausted without resolution
 *   - manual_override: Tenant admin manually escalated
 */

import { z } from 'zod';
import crypto from 'crypto';

// âââââââââââââââââââââââââââââââââââââââââââââ
// Schemas
// âââââââââââââââââââââââââââââââââââââââââââââ

export const EscalationReason = z.enum([
  'low_confidence',
  'risk_flag',
  'human_requested',
  'compliance_block',
  'max_attempts',
  'manual_override',
]);

export const EscalationPriority = z.enum([
  'critical',
  'high',
  'normal',
  'low',
]);

export const EscalationStatus = z.enum([
  'pending',
  'assigned',
  'in_progress',
  'resolved',
  'expired',
]);

export const EscalationAgentInputSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  decisionId: z.string(),

  actionType: z.string(),
  channel: z.string().nullable(),
  payload: z.record(z.unknown()),
  strategy: z.string(),
  confidenceScore: z.number(),
  priority: z.enum(['high', 'normal', 'low']),
  maxRetries: z.number(),
  timeoutMs: z.number(),

  // Escalation-specific context
  escalationReason: EscalationReason,
  riskFlags: z.array(z.string()).default([]),

  // Contact context for the handoff
  contactContext: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    lifecycleStage: z.string().optional(),
    segment: z.string().optional(),
    lastInteractionAt: z.string().optional(),
  }).optional(),

  // Recent interaction history for summary
  recentActions: z.array(z.object({
    actionType: z.string(),
    channel: z.string().nullable(),
    status: z.string(),
    executedAt: z.string(),
    summary: z.string().optional(),
  })).default([]),

  // Objective context
  objectiveContext: z.object({
    type: z.string(),
    description: z.string().optional(),
    subObjectives: z.array(z.object({
      name: z.string(),
      status: z.string(),
    })).default([]),
    currentStrategy: z.string().optional(),
  }).optional(),
});

export const EscalationAgentResultSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  decisionId: z.string(),
  escalationId: z.string(),
  reason: EscalationReason,
  priority: EscalationPriority,
  status: EscalationStatus,
  assignedTo: z.string().nullable(),
  queueName: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  contextSummary: z.string(),
  handoffPackage: z.record(z.unknown()),
  error: z.string().nullable(),
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// Types
// âââââââââââââââââââââââââââââââââââââââââââââ

export type EscalationAgentInput = z.infer<typeof EscalationAgentInputSchema>;
export type EscalationAgentResult = z.infer<typeof EscalationAgentResultSchema>;

// âââââââââââââââââââââââââââââââââââââââââââââ
// Assignment Queue Interface
// âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Assignment queue â abstracts team routing for testability.
 * In production: routes to tenant's team via notification service.
 */
export interface AssignmentQueue {
  assign(params: {
    tenantId: string;
    escalationId: string;
    priority: z.infer<typeof EscalationPriority>;
    queueName: string;
    contextSummary: string;
  }): Promise<{ assignedTo: string | null; queueName: string }>;
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Priority Resolution
// âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Determine escalation priority based on reason and risk flags.
 */
function resolveEscalationPriority(
  reason: z.infer<typeof EscalationReason>,
  riskFlags: string[],
  confidenceScore: number,
): z.infer<typeof EscalationPriority> {
  // Critical: compliance blocks and human-requested always high priority
  if (reason === 'compliance_block') return 'critical';
  if (reason === 'human_requested') return 'high';

  // Risk flags escalate priority
  const criticalFlags = ['CRITICAL_GAP', 'VERY_LOW_DATA_QUALITY'];
  if (riskFlags.some(f => criticalFlags.includes(f))) return 'critical';

  // Very low confidence â high priority
  if (confidenceScore < 20) return 'high';

  // Manual override respects the routing priority
  if (reason === 'manual_override') return 'high';

  // Max attempts â normal priority (AI tried its best)
  if (reason === 'max_attempts') return 'normal';

  // Low confidence default
  if (reason === 'low_confidence') {
    return confidenceScore < 40 ? 'high' : 'normal';
  }

  // Risk flag without critical ones
  if (reason === 'risk_flag') return 'normal';

  return 'normal';
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Queue Resolution
// âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Determine which queue the escalation should be routed to.
 */
function resolveQueueName(
  reason: z.infer<typeof EscalationReason>,
  actionType: string,
): string {
  if (reason === 'compliance_block') return 'compliance_review';
  if (reason === 'human_requested') return 'customer_support';
  if (reason === 'manual_override') return 'admin_review';

  // Route by action type for other reasons
  const actionQueueMap: Record<string, string> = {
    send_email: 'outreach_review',
    send_sms: 'outreach_review',
    send_whatsapp: 'outreach_review',
    book_meeting: 'scheduling_review',
    update_crm: 'data_review',
    close_objective: 'strategy_review',
  };

  return actionQueueMap[actionType] ?? 'general_review';
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Context Summary Builder
// âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Build a human-readable context summary for the handoff.
 */
function buildContextSummary(input: EscalationAgentInput): string {
  const lines: string[] = [];

  lines.push(`**Escalation Reason:** ${formatReason(input.escalationReason)}`);
  lines.push(`**Confidence Score:** ${input.confidenceScore}/100`);
  lines.push(`**Strategy:** ${input.strategy}`);
  lines.push(`**Action Type:** ${input.actionType}`);

  if (input.channel) {
    lines.push(`**Channel:** ${input.channel}`);
  }

  if (input.riskFlags.length > 0) {
    lines.push(`**Risk Flags:** ${input.riskFlags.join(', ')}`);
  }

  // Contact info
  if (input.contactContext) {
    lines.push('');
    lines.push('**Contact:**');
    if (input.contactContext.name) lines.push(`  Name: ${input.contactContext.name}`);
    if (input.contactContext.email) lines.push(`  Email: ${input.contactContext.email}`);
    if (input.contactContext.phone) lines.push(`  Phone: ${input.contactContext.phone}`);
    if (input.contactContext.lifecycleStage) lines.push(`  Stage: ${input.contactContext.lifecycleStage}`);
    if (input.contactContext.segment) lines.push(`  Segment: ${input.contactContext.segment}`);
  }

  // Objective info
  if (input.objectiveContext) {
    lines.push('');
    lines.push(`**Objective:** ${input.objectiveContext.type}`);
    if (input.objectiveContext.description) {
      lines.push(`  ${input.objectiveContext.description}`);
    }
    if (input.objectiveContext.subObjectives.length > 0) {
      lines.push('  Sub-objectives:');
      for (const sub of input.objectiveContext.subObjectives) {
        lines.push(`    - ${sub.name}: ${sub.status}`);
      }
    }
  }

  // Recent actions
  if (input.recentActions.length > 0) {
    lines.push('');
    lines.push('**Recent Actions:**');
    for (const action of input.recentActions.slice(-5)) {
      const summary = action.summary ? ` â ${action.summary}` : '';
      lines.push(`  - ${action.actionType} via ${action.channel ?? 'n/a'} â ${action.status}${summary}`);
    }
  }

  return lines.join('\n');
}

function formatReason(reason: string): string {
  const reasonLabels: Record<string, string> = {
    low_confidence: 'AI confidence below threshold',
    risk_flag: 'Risk flag triggered',
    human_requested: 'Contact requested human assistance',
    compliance_block: 'Compliance check blocked action',
    max_attempts: 'Maximum AI attempts exhausted',
    manual_override: 'Manually escalated by admin',
  };
  return reasonLabels[reason] ?? reason;
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Handoff Package Builder
// âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Build the full handoff package with all context an agent needs.
 */
function buildHandoffPackage(input: EscalationAgentInput): Record<string, unknown> {
  return {
    contact: input.contactContext ?? null,
    objective: input.objectiveContext ?? null,
    decision: {
      decisionId: input.decisionId,
      strategy: input.strategy,
      actionType: input.actionType,
      channel: input.channel,
      confidenceScore: input.confidenceScore,
      payload: input.payload,
    },
    escalation: {
      reason: input.escalationReason,
      riskFlags: input.riskFlags,
    },
    recentActions: input.recentActions.slice(-10),
    suggestedActions: buildSuggestedActions(input),
  };
}

/**
 * Suggest next actions for the human operator based on escalation context.
 */
function buildSuggestedActions(input: EscalationAgentInput): string[] {
  const suggestions: string[] = [];

  switch (input.escalationReason) {
    case 'low_confidence':
      suggestions.push('Review AI strategy selection and adjust if needed');
      suggestions.push('Verify contact data quality and enrich if possible');
      suggestions.push('Manually approve or modify the proposed action');
      break;
    case 'risk_flag':
      suggestions.push('Investigate flagged risk conditions');
      if (input.riskFlags.includes('VERY_LOW_DATA_QUALITY')) {
        suggestions.push('Enrich contact data before re-engaging');
      }
      if (input.riskFlags.includes('CONTACT_UNRESPONSIVE')) {
        suggestions.push('Consider alternate outreach channel or timing');
      }
      if (input.riskFlags.includes('CRITICAL_GAP')) {
        suggestions.push('Review objective configuration and sub-objectives');
      }
      break;
    case 'human_requested':
      suggestions.push('Respond to contact directly via their preferred channel');
      suggestions.push('Review conversation history for context');
      break;
    case 'compliance_block':
      suggestions.push('Review the blocked action for compliance issues');
      suggestions.push('Check consent and opt-in status');
      suggestions.push('Verify message content meets regulatory requirements');
      break;
    case 'max_attempts':
      suggestions.push('Review why AI attempts were unsuccessful');
      suggestions.push('Consider manual outreach or different strategy');
      suggestions.push('Check if contact information is still valid');
      break;
    case 'manual_override':
      suggestions.push('Review the original AI decision');
      suggestions.push('Take manual action as needed');
      break;
  }

  return suggestions;
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Expiry Calculation
// âââââââââââââââââââââââââââââââââââââââââââââ

const EXPIRY_HOURS: Record<string, number> = {
  critical: 4,
  high: 12,
  normal: 24,
  low: 48,
};

function calculateExpiry(priority: z.infer<typeof EscalationPriority>): string {
  const hours = EXPIRY_HOURS[priority] ?? 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Main Entry Point
// âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Execute an escalation â build context summary, assign to queue, notify.
 *
 * @param input - Routed action from the Agent Router
 * @param queue - Assignment queue adapter
 * @returns Escalation result with assignment details
 */
export async function executeEscalation(
  input: EscalationAgentInput,
  queue: AssignmentQueue,
): Promise<EscalationAgentResult> {
  const parsed = EscalationAgentInputSchema.parse(input);
  const escalationId = `esc_${crypto.randomUUID()}`;

  // Step 1: Resolve priority and queue
  const priority = resolveEscalationPriority(
    parsed.escalationReason,
    parsed.riskFlags,
    parsed.confidenceScore,
  );
  const queueName = resolveQueueName(parsed.escalationReason, parsed.actionType);

  // Step 2: Build context summary and handoff package
  const contextSummary = buildContextSummary(parsed);
  const handoffPackage = buildHandoffPackage(parsed);

  // Step 3: Assign to queue
  try {
    const assignment = await queue.assign({
      tenantId: parsed.tenantId,
      escalationId,
      priority,
      queueName,
      contextSummary,
    });

    return EscalationAgentResultSchema.parse({
      tenantId: parsed.tenantId,
      contactId: parsed.contactId,
      decisionId: parsed.decisionId,
      escalationId,
      reason: parsed.escalationReason,
      priority,
      status: assignment.assignedTo ? 'assigned' : 'pending',
      assignedTo: assignment.assignedTo,
      queueName: assignment.queueName,
      createdAt: new Date().toISOString(),
      expiresAt: calculateExpiry(priority),
      contextSummary,
      handoffPackage,
      error: null,
    });
  } catch (err: any) {
    return EscalationAgentResultSchema.parse({
      tenantId: parsed.tenantId,
      contactId: parsed.contactId,
      decisionId: parsed.decisionId,
      escalationId,
      reason: parsed.escalationReason,
      priority,
      status: 'pending',
      assignedTo: null,
      queueName,
      createdAt: new Date().toISOString(),
      expiresAt: calculateExpiry(priority),
      contextSummary,
      handoffPackage,
      error: err.message ?? 'Queue assignment failed',
    });
  }
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// In-Memory Assignment Queue (for testing)
// âââââââââââââââââââââââââââââââââââââââââââââ

export class InMemoryAssignmentQueue implements AssignmentQueue {
  private escalations: Array<Record<string, unknown>> = [];
  private autoAssignTo: string | null = null;

  async assign(params: {
    tenantId: string;
    escalationId: string;
    priority: string;
    queueName: string;
    contextSummary: string;
  }) {
    this.escalations.push(params);
    return {
      assignedTo: this.autoAssignTo,
      queueName: params.queueName,
    };
  }

  setAutoAssign(userId: string | null): void {
    this.autoAssignTo = userId;
  }

  getEscalations() { return this.escalations; }
  clear() { this.escalations = []; this.autoAssignTo = null; }
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// API Route Handlers
// âââââââââââââââââââââââââââââââââââââââââââââ

import { Router, Request, Response } from 'express';

export function createEscalationAgentRouter(
  queue: AssignmentQueue,
): Router {
  const router = Router();

  /**
   * POST /api/agent/escalate
   * Execute an escalation action.
   */
  router.post('/escalate', async (req: Request, res: Response) => {
    try {
      const input = EscalationAgentInputSchema.parse(req.body);
      const result = await executeEscalation(input, queue);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[EscalationAgent] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Escalation execution failed',
      });
    }
  });

  return router;
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Exports
// âââââââââââââââââââââââââââââââââââââââââââââ

export {
  resolveEscalationPriority,
  resolveQueueName,
  buildContextSummary,
  buildHandoffPackage,
  buildSuggestedActions,
  calculateExpiry,
  formatReason,
};
