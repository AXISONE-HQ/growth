/**
 * Action Determiner — KAN-37
 *
 * Decision Engine — DECIDE phase, Step 3
 * Given a selected strategy and contact context, determine the single
 * best next action. Uses Claude Sonnet for complex reasoning within
 * an 8,000-token context budget.
 *
 * Architecture reference:
 *   Strategy Selector output (StrategySelectionResult)
 *       │
 *   Action Determiner  ← What is the single best next action?
 *   (Message / Wait / Escalate / Book / Update CRM / Close)
 *       │
 *   Confidence Scorer  ← How confident are we? (0-100)
 *
 * Action types:
 *   - send_message:    Generate and send a message via channel
 *   - schedule_follow_up: Queue a future touchpoint
 *   - escalate_human:  Route to human with full context summary
 *   - book_meeting:    Trigger Cal.com booking flow
 *   - update_crm:      Write-back to CRM (stage change, notes)
 *   - close_objective:  Mark objective complete (won/lost)
 *   - wait:            No action — hold and re-evaluate later
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const ActionType = z.enum([
  'send_message',
  'schedule_follow_up',
  'escalate_human',
  'book_meeting',
  'update_crm',
  'close_objective',
  'wait',
]);

export const ChannelType = z.enum([
  'sms',
  'email',
  'whatsapp',
  'chat',
  'messenger',
  'webhook',
]);

export const ActionDeterminerInputSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string(),
  selectedStrategy: z.enum([
    'direct',
    're_engage',
    'trust_build',
    'guided',
    'escalate',
    'wait',
  ]),
  strategyConfidence: z.number().min(0).max(100),
  strategyReasoning: z.string(),
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
      suggestedActions: z.array(z.string()),
    })
    .nullable(),
  contactContext: z.object({
    name: z.string().optional(),
    lifecycleStage: z.string().optional(),
    segment: z.string().optional(),
    lastInteractionDaysAgo: z.number().optional(),
    totalInteractions: z.number().optional(),
    responseRate: z.number().min(0).max(1).optional(),
    preferredChannel: z.string().optional(),
    timezone: z.string().optional(),
    lastMessageSentAt: z.string().datetime().optional(),
    recentActions: z
      .array(
        z.object({
          actionType: z.string(),
          channel: z.string().optional(),
          sentAt: z.string().datetime(),
          outcome: z.string().optional(),
        }),
      )
      .optional(),
  }),
  brainContext: z
    .object({
      companyTruth: z.record(z.unknown()).optional(),
      products: z.array(z.string()).optional(),
      tone: z.string().optional(),
      constraints: z.array(z.string()).optional(),
    })
    .optional(),
  tenantPermissions: z
    .object({
      allowedChannels: z.array(ChannelType).optional(),
      allowedActionTypes: z.array(ActionType).optional(),
      maxMessagesPerDay: z.number().optional(),
      quietHoursStart: z.number().min(0).max(23).optional(),
      quietHoursEnd: z.number().min(0).max(23).optional(),
      requireHumanApproval: z.boolean().optional(),
    })
    .optional(),
});

export const ActionDeterminerResultSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string(),
  actionType: ActionType,
  channel: ChannelType.nullable(),
  actionPayload: z.object({
    messageTemplate: z.string().optional(),
    messageVariables: z.record(z.string()).optional(),
    escalationReason: z.string().optional(),
    escalationSummary: z.string().optional(),
    meetingType: z.string().optional(),
    meetingDuration: z.number().optional(),
    crmFieldUpdates: z.record(z.unknown()).optional(),
    closeReason: z.string().optional(),
    followUpDelayHours: z.number().optional(),
    followUpActionType: ActionType.optional(),
  }),
  reasoning: z.string(),
  determinedAt: z.string().datetime(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ActionDeterminerInput = z.infer<typeof ActionDeterminerInputSchema>;
export type ActionDeterminerResult = z.infer<typeof ActionDeterminerResultSchema>;
type ActionTypeValue = z.infer<typeof ActionType>;
type ChannelTypeValue = z.infer<typeof ChannelType>;

interface ActionCandidate {
  actionType: ActionTypeValue;
  channel: ChannelTypeValue | null;
  score: number;
  reason: string;
}

// ─────────────────────────────────────────────
// Strategy → Action Mapping (Rule-Based MVP)
// ─────────────────────────────────────────────

/** Strategy-to-action mapping tables — the core decision logic. */
const STRATEGY_ACTION_MAP: Record<
  string,
  { primary: ActionTypeValue; fallback: ActionTypeValue; channels: ChannelTypeValue[] }
> = {
  direct: {
    primary: 'send_message',
    fallback: 'book_meeting',
    channels: ['email', 'sms', 'whatsapp'],
  },
  re_engage: {
    primary: 'send_message',
    fallback: 'schedule_follow_up',
    channels: ['email', 'sms'],
  },
  trust_build: {
    primary: 'send_message',
    fallback: 'schedule_follow_up',
    channels: ['email'],
  },
  guided: {
    primary: 'send_message',
    fallback: 'update_crm',
    channels: ['email', 'sms', 'whatsapp'],
  },
  escalate: {
    primary: 'escalate_human',
    fallback: 'escalate_human',
    channels: [],
  },
  wait: {
    primary: 'wait',
    fallback: 'schedule_follow_up',
    channels: [],
  },
};

// ─────────────────────────────────────────────
// Channel Selection
// ─────────────────────────────────────────────

function selectChannel(
  input: ActionDeterminerInput,
  strategyChannels: ChannelTypeValue[],
): ChannelTypeValue | null {
  if (strategyChannels.length === 0) return null;
  const allowedChannels = input.tenantPermissions?.allowedChannels;
  const preferred = input.contactContext.preferredChannel as ChannelTypeValue | undefined;
  let candidates = allowedChannels
    ? strategyChannels.filter((c) => allowedChannels.includes(c))
    : strategyChannels;
  if (candidates.length === 0) {
    candidates = allowedChannels ?? strategyChannels;
  }
  if (preferred && candidates.includes(preferred)) {
    return preferred;
  }
  return candidates[0] ?? null;
}

function shouldDeferAction(input: ActionDeterminerInput): { defer: boolean; reason: string | null; } {
  const permissions = input.tenantPermissions;
  if (!permissions) return { defer: false, reason: null };
  if (permissions.quietHoursStart !== undefined && permissions.quietHoursEnd !== undefined && input.contactContext.timezone) {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const start = permissions.quietHoursStart;
    const end = permissions.quietHoursEnd;
    const inQuietHours = start < end ? currentHour >= start && currentHour < end : currentHour >= start || currentHour < end;
    if (inQuietHours) return { defer: true, reason: 'Contact is in quiet hours' };
  }
  if (permissions.maxMessagesPerDay !== undefined) {
    const today = new Date().toISOString().slice(0, 10);
    const todaysMessages = input.contactContext.recentActions?.filter((a) => a.actionType === 'send_message' && a.sentAt.startsWith(today)) ?? [];
    if (todaysMessages.length >= permissions.maxMessagesPerDay) return { defer: true, reason: `Daily message limit reached (${permissions.maxMessagesPerDay})` };
  }
  return { defer: false, reason: null };
}

function scoreActions(input: ActionDeterminerInput): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  const strategyMap = STRATEGY_ACTION_MAP[input.selectedStrategy];
  if (!strategyMap) { candidates.push({ actionType: 'escalate_human', channel: null, score: 100, reason: `Unknown strategy: ${input.selectedStrategy}` }); return candidates; }
  const channel = selectChannel(input, strategyMap.channels);
  const deferCheck = shouldDeferAction(input);
  if (deferCheck.defer && strategyMap.primary === 'send_message') { candidates.push({ actionType: 'schedule_follow_up', channel, score: 80, reason: `Deferred: ${deferCheck.reason}` }); return candidates; }
  candidates.push({ actionType: strategyMap.primary, channel: strategyMap.primary === 'send_message' ? channel : null, score: 70, reason: `Primary action for "${input.selectedStrategy}" strategy` });
  if (input.primaryGap?.suggestedActions) {
    const suggestions = input.primaryGap.suggestedActions;
    if (suggestions.some((s) => s.toLowerCase().includes('message') || s.toLowerCase().includes('email'))) { const mc = candidates.find((c) => c.actionType === 'send_message'); if (mc) { mc.score += 15; mc.reason += '; aligned with gap suggestion'; } }
    if (suggestions.some((s) => s.toLowerCase().includes('escalat'))) candidates.push({ actionType: 'escalate_human', channel: null, score: 60, reason: 'Gap suggests escalation' });
    if (suggestions.some((s) => s.toLowerCase().includes('meeting') || s.toLowerCase().includes('book'))) candidates.push({ actionType: 'book_meeting', channel: null, score: 55, reason: 'Gap suggests meeting' });
  }
  if (input.tenantPermissions?.requireHumanApproval) candidates.push({ actionType: 'escalate_human', channel: null, score: 100, reason: 'Tenant requires human approval for all actions' });
  return candidates.sort((a, b) => b.score - a.score);
}

function buildActionPayload(actionType: ActionTypeValue, input: ActionDeterminerInput): ActionDeterminerResult['actionPayload'] {
  switch (actionType) {
    case 'send_message': return { messageTemplate: `{{strategy_${input.selectedStrategy}_template}}`, messageVariables: { contactName: input.contactContext.name ?? 'there', objectiveId: input.objectiveId, strategy: input.selectedStrategy, gapCategory: input.primaryGap?.category ?? 'general' } };
    case 'schedule_follow_up': { const delayMap: Record<string, number> = { direct: 24, re_engage: 72, trust_build: 48, guided: 48, escalate: 4, wait: 168 }; return { followUpDelayHours: delayMap[input.selectedStrategy] ?? 48, followUpActionType: 'send_message' }; }
    case 'escalate_human': return { escalationReason: input.primaryGap?.severity === 'critical' ? 'Critical gap requires human intervention' : `Strategy "${input.selectedStrategy}" requires human routing`, escalationSummary: [`Contact: ${input.contactContext.name ?? input.contactId}`, `Strategy: ${input.selectedStrategy}`, `Gap: ${input.primaryGap?.subObjectiveName ?? 'N/A'} (${input.primaryGap?.severity ?? 'unknown'})`, `Reasoning: ${input.strategyReasoning}`].join('\n') };
    case 'book_meeting': return { meetingType: 'discovery', meetingDuration: 30 };
    case 'update_crm': return { crmFieldUpdates: { lastStrategyApplied: input.selectedStrategy, lastDecisionAt: new Date().toISOString() } };
    case 'close_objective': return { closeReason: input.primaryGap ? `Objective closed — ${input.primaryGap.reason}` : 'Objective completed' };
    case 'wait': return { followUpDelayHours: 168, followUpActionType: 'send_message' };
    default: return {};
  }
}

export function determineAction(input: ActionDeterminerInput): ActionDeterminerResult {
  const parsed = ActionDeterminerInputSchema.parse(input);
  const candidates = scoreActions(parsed);
  const winner = candidates[0];
  const strategyMap = STRATEGY_ACTION_MAP[parsed.selectedStrategy];
  const channel = winner.actionType === 'send_message' ? winner.channel ?? selectChannel(parsed, strategyMap?.channels ?? []) : null;
  const payload = buildActionPayload(winner.actionType, parsed);
  const result: ActionDeterminerResult = { contactId: parsed.contactId, tenantId: parsed.tenantId, objectiveId: parsed.objectiveId, actionType: winner.actionType, channel, actionPayload: payload, reasoning: `Action: "${winner.actionType}" (score: ${winner.score}). ${winner.reason}.`, determinedAt: new Date().toISOString() };
  return ActionDeterminerResultSchema.parse(result);
}

import { Router, Request, Response } from 'express';

export function createActionDeterminerRouter(): Router {
  const router = Router();
  router.post('/determine-action', async (req: Request, res: Response) => {
    try {
      const input = ActionDeterminerInputSchema.parse(req.body);
      const result = determineAction(input);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[ActionDeterminer] Error:', err);
      res.status(400).json({ success: false, error: err.message ?? 'Action determination failed' });
    }
  });
  return router;
}

export { scoreActions, selectChannel, shouldDeferAction, buildActionPayload };
