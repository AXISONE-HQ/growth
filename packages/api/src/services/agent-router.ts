/**
 * Agent Router & Permission Check — KAN-376
 *
 * Agent Dispatcher — EXECUTE phase, Entry Point
 * Receives action.decided events from Pub/Sub, validates tenant
 * permissions, and routes to the correct agent type.
 *
 * Architecture reference:
 *   action.decided (Pub/Sub)
 *       │
 *   Permission Check  ← Is this action allowed for this tenant?
 *       │
 *   Agent Router
 *       │
 *   ┌───┴──────────┬──────────────┬──────────────┐
 *   Comms Agent   Ops Agent   Escalation Agent   (blocked)
 *
 * Permission checks:
 *   - Channel allowed for tenant
 *   - Action type not blocked
 *   - Daily execution limit not exceeded
 *   - Quiet hours respected
 *   - Agent type available for tenant tier
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const AgentType = z.enum([
  'communication',
  'operational',
  'escalation',
]);

export const RoutingDecision = z.enum([
  'routed',
  'blocked_channel',
  'blocked_action',
  'blocked_limit',
  'blocked_quiet_hours',
  'blocked_tier',
]);

export const AgentRouterInputSchema = z.object({
  // From action.decided event
  eventId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  decisionId: z.string(),

  action: z.object({
    actionType: z.string(),
    channel: z.string().nullable(),
    payload: z.record(z.unknown()),
  }),

  decision: z.object({
    selectedStrategy: z.string(),
    confidenceScore: z.number(),
    strategyReasoning: z.string(),
    actionReasoning: z.string(),
  }),

  routing: z.object({
    agentType: z.string(),
    priority: z.enum(['high', 'normal', 'low']),
    maxRetries: z.number(),
    timeoutMs: z.number(),
  }),

  // Tenant permissions (injected by dispatcher)
  tenantPermissions: z.object({
    planTier: z.enum(['free', 'starter', 'growth', 'enterprise']),
    allowedChannels: z.array(z.string()),
    blockedActionTypes: z.array(z.string()).default([]),
    maxDailyExecutions: z.number().default(100),
    quietHoursStart: z.number().nullable().default(null),
    quietHoursEnd: z.number().nullable().default(null),
    quietHoursTimezone: z.string().default('UTC'),
    enabledAgentTypes: z.array(z.string()).default(['communication', 'operational', 'escalation']),
  }),

  // Current state (injected by dispatcher)
  dailyExecutionCount: z.number().default(0),
});

export const AgentRouterResultSchema = z.object({
  eventId: z.string(),
  tenantId: z.string(),
  contactId: z.string(),
  decisionId: z.string(),
  routingDecision: RoutingDecision,
  targetAgent: AgentType.nullable(),
  reasoning: z.string(),
  routedAt: z.string().datetime(),

  // Pass-through for the target agent
  actionPayload: z
    .object({
      actionType: z.string(),
      channel: z.string().nullable(),
      payload: z.record(z.unknown()),
      strategy: z.string(),
      confidenceScore: z.number(),
      priority: z.enum(['high', 'normal', 'low']),
      maxRetries: z.number(),
      timeoutMs: z.number(),
    })
    .nullable(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type AgentRouterInput = z.infer<typeof AgentRouterInputSchema>;
export type AgentRouterResult = z.infer<typeof AgentRouterResultSchema>;

// ─────────────────────────────────────────────
// Permission Checks
// ─────────────────────────────────────────────

function checkChannelAllowed(
  channel: string | null,
  allowedChannels: string[],
): boolean {
  if (!channel) return true; // Non-channel actions (CRM updates, etc.) always allowed
  return allowedChannels.includes(channel);
}

function checkActionNotBlocked(
  actionType: string,
  blockedActionTypes: string[],
): boolean {
  return !blockedActionTypes.includes(actionType);
}

function checkDailyLimit(
  currentCount: number,
  maxDaily: number,
): boolean {
  return currentCount < maxDaily;
}

/**
 * Check if current time falls within quiet hours.
 * Quiet hours are specified in the tenant's timezone.
 */
function checkQuietHours(
  quietStart: number | null,
  quietEnd: number | null,
  timezone: string,
): boolean {
  if (quietStart === null || quietEnd === null) return true; // No quiet hours configured

  const now = new Date();
  let currentHour: number;

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    });
    currentHour = parseInt(formatter.format(now), 10);
  } catch {
    currentHour = now.getUTCHours();
  }

  // Handle overnight quiet hours (e.g., 22:00 - 06:00)
  if (quietStart > quietEnd) {
    // Quiet if current hour >= start OR < end
    return !(currentHour >= quietStart || currentHour < quietEnd);
  }

  // Standard quiet hours (e.g., 00:00 - 06:00)
  return !(currentHour >= quietStart && currentHour < quietEnd);
}

function checkAgentTypeAllowed(
  agentType: string,
  enabledAgentTypes: string[],
): boolean {
  return enabledAgentTypes.includes(agentType);
}

// ─────────────────────────────────────────────
// Agent Type Resolution
// ─────────────────────────────────────────────

/**
 * Resolve the target agent type from the routing hint.
 * Falls back to 'communication' for unknown types.
 */
function resolveAgentType(routingAgentType: string): z.infer<typeof AgentType> {
  const validTypes: Record<string, z.infer<typeof AgentType>> = {
    communication: 'communication',
    operational: 'operational',
    escalation: 'escalation',
  };
  return validTypes[routingAgentType] ?? 'communication';
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

/**
 * Route an action.decided event to the correct agent.
 * Runs all permission checks before routing.
 *
 * Check order:
 * 1. Action type not blocked
 * 2. Channel allowed
 * 3. Agent type available for tier
 * 4. Daily limit not exceeded
 * 5. Quiet hours respected (escalations bypass quiet hours)
 *
 * @param input - action.decided event + tenant permissions + current state
 * @returns Routing decision with target agent or block reason
 */
export function routeAction(
  input: AgentRouterInput,
): AgentRouterResult {
  const parsed = AgentRouterInputSchema.parse(input);
  const targetAgent = resolveAgentType(parsed.routing.agentType);

  // Check 1: Action type not blocked
  if (!checkActionNotBlocked(parsed.action.actionType, parsed.tenantPermissions.blockedActionTypes)) {
    return buildResult(parsed, 'blocked_action', null,
      `Action type "${parsed.action.actionType}" is blocked for this tenant.`);
  }

  // Check 2: Channel allowed
  if (!checkChannelAllowed(parsed.action.channel, parsed.tenantPermissions.allowedChannels)) {
    return buildResult(parsed, 'blocked_channel', null,
      `Channel "${parsed.action.channel}" is not allowed for this tenant.`);
  }

  // Check 3: Agent type available for tier
  if (!checkAgentTypeAllowed(targetAgent, parsed.tenantPermissions.enabledAgentTypes)) {
    return buildResult(parsed, 'blocked_tier', null,
      `Agent type "${targetAgent}" is not available on the ${parsed.tenantPermissions.planTier} plan.`);
  }

  // Check 4: Daily limit
  if (!checkDailyLimit(parsed.dailyExecutionCount, parsed.tenantPermissions.maxDailyExecutions)) {
    return buildResult(parsed, 'blocked_limit', null,
      `Daily execution limit reached (${parsed.tenantPermissions.maxDailyExecutions}).`);
  }

  // Check 5: Quiet hours (escalations bypass)
  if (targetAgent !== 'escalation') {
    if (!checkQuietHours(
      parsed.tenantPermissions.quietHoursStart,
      parsed.tenantPermissions.quietHoursEnd,
      parsed.tenantPermissions.quietHoursTimezone,
    )) {
      return buildResult(parsed, 'blocked_quiet_hours', null,
        'Action blocked during quiet hours. Will be retried after quiet hours end.');
    }
  }

  // All checks passed — route to agent
  return buildResult(parsed, 'routed', targetAgent,
    `Routed to ${targetAgent} agent. Action: ${parsed.action.actionType}, Channel: ${parsed.action.channel ?? 'n/a'}, Priority: ${parsed.routing.priority}.`);
}

// ─────────────────────────────────────────────
// Result Builder
// ─────────────────────────────────────────────

function buildResult(
  input: AgentRouterInput,
  decision: z.infer<typeof RoutingDecision>,
  agent: z.infer<typeof AgentType> | null,
  reasoning: string,
): AgentRouterResult {
  return AgentRouterResultSchema.parse({
    eventId: input.eventId,
    tenantId: input.tenantId,
    contactId: input.contactId,
    decisionId: input.decisionId,
    routingDecision: decision,
    targetAgent: agent,
    reasoning,
    routedAt: new Date().toISOString(),
    actionPayload: agent
      ? {
          actionType: input.action.actionType,
          channel: input.action.channel,
          payload: input.action.payload,
          strategy: input.decision.selectedStrategy,
          confidenceScore: input.decision.confidenceScore,
          priority: input.routing.priority,
          maxRetries: input.routing.maxRetries,
          timeoutMs: input.routing.timeoutMs,
        }
      : null,
  });
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createAgentRouterRouter(): Router {
  const router = Router();

  /**
   * POST /api/agent/route
   * Route an action.decided event to the correct agent.
   */
  router.post('/route', async (req: Request, res: Response) => {
    try {
      const input = AgentRouterInputSchema.parse(req.body);
      const result = routeAction(input);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[AgentRouter] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Routing failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  checkChannelAllowed,
  checkActionNotBlocked,
  checkDailyLimit,
  checkQuietHours,
  checkAgentTypeAllowed,
  resolveAgentType,
};
