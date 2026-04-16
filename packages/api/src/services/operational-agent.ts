/**
 * Operational Agent — KAN-378
 *
 * Agent Dispatcher — EXECUTE phase
 * Handles non-communication actions: CRM field updates, Cal.com meeting
 * booking, objective status changes, and webhook triggers.
 *
 * Architecture reference:
 *   Agent Router (operational)
 *       │
 *   Operational Agent
 *       │
 *   ┌───┴──────────┬──────────────┬──────────────┐
 *   CRM Update    Book Meeting   Webhook        Close Objective
 *       │
 *   action.executed → Pub/Sub
 *
 * Operations:
 *   - update_crm: Write-back contact/deal fields via Nango
 *   - book_meeting: Schedule via Cal.com API
 *   - close_objective: Mark objective complete/failed
 *   - schedule_follow_up: Create a delayed re-engagement task
 *   - webhook: Fire arbitrary webhook to external system
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const OperationType = z.enum([
  'update_crm',
  'book_meeting',
  'close_objective',
  'schedule_follow_up',
  'webhook',
]);

export const OperationStatus = z.enum([
  'success',
  'failed',
  'partial',
  'skipped',
]);

export const OperationalAgentInputSchema = z.object({
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
});

export const OperationalAgentResultSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  decisionId: z.string(),
  operationId: z.string(),
  operationType: z.string(),
  status: OperationStatus,
  executedAt: z.string().datetime(),
  result: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  retryCount: z.number(),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type OperationalAgentInput = z.infer<typeof OperationalAgentInputSchema>;
export type OperationalAgentResult = z.infer<typeof OperationalAgentResultSchema>;

// ─────────────────────────────────────────────
// CRM Adapter Interface
// ─────────────────────────────────────────────

/**
 * CRM adapter — abstracts Nango for testability.
 * In production: NangoCrmAdapter wrapping HubSpot/Salesforce/Pipedrive.
 */
export interface CrmAdapter {
  updateContact(tenantId: string, contactId: string, fields: Record<string, unknown>): Promise<{ success: boolean; updatedFields: string[] }>;
  updateDeal(tenantId: string, dealId: string, fields: Record<string, unknown>): Promise<{ success: boolean; updatedFields: string[] }>;
}

/**
 * Calendar adapter — abstracts Cal.com for testability.
 */
export interface CalendarAdapter {
  bookMeeting(params: {
    tenantId: string;
    contactEmail: string;
    contactName?: string;
    durationMinutes: number;
    preferredTime?: string;
    notes?: string;
  }): Promise<{ bookingId: string; scheduledAt: string; meetingUrl: string }>;
}

/**
 * Webhook adapter — sends HTTP requests to external systems.
 */
export interface WebhookAdapter {
  fire(url: string, payload: Record<string, unknown>, headers?: Record<string, string>): Promise<{ statusCode: number; responseBody?: string }>;
}

// ─────────────────────────────────────────────
// Operation Handlers
// ─────────────────────────────────────────────

function generateOperationId(): string {
  return `op_${crypto.randomUUID()}`;
}

async function handleCrmUpdate(
  input: OperationalAgentInput,
  crm: CrmAdapter,
): Promise<OperationalAgentResult> {
  const operationId = generateOperationId();
  const fields = (input.payload.fields as Record<string, unknown>) ?? {};
  const targetType = (input.payload.targetType as string) ?? 'contact';

  try {
    let result;
    if (targetType === 'deal') {
      const dealId = (input.payload.dealId as string) ?? input.contactId;
      result = await crm.updateDeal(input.tenantId, dealId, fields);
    } else {
      result = await crm.updateContact(input.tenantId, input.contactId, fields);
    }

    return OperationalAgentResultSchema.parse({
      tenantId: input.tenantId,
      contactId: input.contactId,
      decisionId: input.decisionId,
      operationId,
      operationType: 'update_crm',
      status: result.success ? 'success' : 'partial',
      executedAt: new Date().toISOString(),
      result: { updatedFields: result.updatedFields, targetType },
      error: null,
      retryCount: 0,
    });
  } catch (err: any) {
    return OperationalAgentResultSchema.parse({
      tenantId: input.tenantId,
      contactId: input.contactId,
      decisionId: input.decisionId,
      operationId,
      operationType: 'update_crm',
      status: 'failed',
      executedAt: new Date().toISOString(),
      result: null,
      error: err.message ?? 'CRM update failed',
      retryCount: 0,
    });
  }
}

async function handleBookMeeting(
  input: OperationalAgentInput,
  calendar: CalendarAdapter,
): Promise<OperationalAgentResult> {
  const operationId = generateOperationId();

  try {
    const result = await calendar.bookMeeting({
      tenantId: input.tenantId,
      contactEmail: (input.payload.contactEmail as string) ?? '',
      contactName: input.payload.contactName as string | undefined,
      durationMinutes: (input.payload.durationMinutes as number) ?? 30,
      preferredTime: input.payload.preferredTime as string | undefined,
      notes: input.payload.notes as string | undefined,
    });

    return OperationalAgentResultSchema.parse({
      tenantId: input.tenantId,
      contactId: input.contactId,
      decisionId: input.decisionId,
      operationId,
      operationType: 'book_meeting',
      status: 'success',
      executedAt: new Date().toISOString(),
      result: {
        bookingId: result.bookingId,
        scheduledAt: result.scheduledAt,
        meetingUrl: result.meetingUrl,
      },
      error: null,
      retryCount: 0,
    });
  } catch (err: any) {
    return OperationalAgentResultSchema.parse({
      tenantId: input.tenantId,
      contactId: input.contactId,
      decisionId: input.decisionId,
      operationId,
      operationType: 'book_meeting',
      status: 'failed',
      executedAt: new Date().toISOString(),
      result: null,
      error: err.message ?? 'Meeting booking failed',
      retryCount: 0,
    });
  }
}

async function handleCloseObjective(
  input: OperationalAgentInput,
): Promise<OperationalAgentResult> {
  const operationId = generateOperationId();
  const result = (input.payload.result as string) ?? 'completed';
  const reason = (input.payload.reason as string) ?? 'Objective completed by AI agent.';

  // In production, this updates the objectives and contact_states tables
  return OperationalAgentResultSchema.parse({
    tenantId: input.tenantId,
    contactId: input.contactId,
    decisionId: input.decisionId,
    operationId,
    operationType: 'close_objective',
    status: 'success',
    executedAt: new Date().toISOString(),
    result: {
      objectiveId: input.objectiveId,
      closedResult: result,
      closedReason: reason,
    },
    error: null,
    retryCount: 0,
  });
}

async function handleScheduleFollowUp(
  input: OperationalAgentInput,
): Promise<OperationalAgentResult> {
  const operationId = generateOperationId();
  const delayHours = (input.payload.delayHours as number) ?? 24;
  const followUpAt = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString();

  // In production, creates a Cloud Task for delayed execution
  return OperationalAgentResultSchema.parse({
    tenantId: input.tenantId,
    contactId: input.contactId,
    decisionId: input.decisionId,
    operationId,
    operationType: 'schedule_follow_up',
    status: 'success',
    executedAt: new Date().toISOString(),
    result: {
      followUpAt,
      delayHours,
      channel: input.payload.channel ?? null,
    },
    error: null,
    retryCount: 0,
  });
}

async function handleWebhook(
  input: OperationalAgentInput,
  webhook: WebhookAdapter,
): Promise<OperationalAgentResult> {
  const operationId = generateOperationId();
  const url = (input.payload.webhookUrl as string) ?? '';
  const body = (input.payload.webhookBody as Record<string, unknown>) ?? {};
  const headers = (input.payload.webhookHeaders as Record<string, string>) ?? {};

  if (!url) {
    return OperationalAgentResultSchema.parse({
      tenantId: input.tenantId,
      contactId: input.contactId,
      decisionId: input.decisionId,
      operationId,
      operationType: 'webhook',
      status: 'failed',
      executedAt: new Date().toISOString(),
      result: null,
      error: 'No webhook URL provided.',
      retryCount: 0,
    });
  }

  try {
    const result = await webhook.fire(url, body, headers);
    const success = result.statusCode >= 200 && result.statusCode < 300;

    return OperationalAgentResultSchema.parse({
      tenantId: input.tenantId,
      contactId: input.contactId,
      decisionId: input.decisionId,
      operationId,
      operationType: 'webhook',
      status: success ? 'success' : 'failed',
      executedAt: new Date().toISOString(),
      result: { statusCode: result.statusCode },
      error: success ? null : `Webhook returned ${result.statusCode}`,
      retryCount: 0,
    });
  } catch (err: any) {
    return OperationalAgentResultSchema.parse({
      tenantId: input.tenantId,
      contactId: input.contactId,
      decisionId: input.decisionId,
      operationId,
      operationType: 'webhook',
      status: 'failed',
      executedAt: new Date().toISOString(),
      result: null,
      error: err.message ?? 'Webhook execution failed',
      retryCount: 0,
    });
  }
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

export interface OperationalDependencies {
  crm: CrmAdapter;
  calendar: CalendarAdapter;
  webhook: WebhookAdapter;
}

/**
 * Execute an operational action based on the action type.
 *
 * @param input - Routed action from the Agent Router
 * @param deps - Injected adapters (CRM, Calendar, Webhook)
 * @returns Operation result with status and details
 */
export async function executeOperation(
  input: OperationalAgentInput,
  deps: OperationalDependencies,
): Promise<OperationalAgentResult> {
  const parsed = OperationalAgentInputSchema.parse(input);

  switch (parsed.actionType) {
    case 'update_crm':
      return handleCrmUpdate(parsed, deps.crm);
    case 'book_meeting':
      return handleBookMeeting(parsed, deps.calendar);
    case 'close_objective':
      return handleCloseObjective(parsed);
    case 'schedule_follow_up':
      return handleScheduleFollowUp(parsed);
    case 'webhook':
      return handleWebhook(parsed, deps.webhook);
    default:
      return OperationalAgentResultSchema.parse({
        tenantId: parsed.tenantId,
        contactId: parsed.contactId,
        decisionId: parsed.decisionId,
        operationId: generateOperationId(),
        operationType: parsed.actionType,
        status: 'skipped',
        executedAt: new Date().toISOString(),
        result: null,
        error: `Unknown operation type: ${parsed.actionType}`,
        retryCount: 0,
      });
  }
}

// ─────────────────────────────────────────────
// In-Memory Adapters (for testing)
// ─────────────────────────────────────────────

export class InMemoryCrmAdapter implements CrmAdapter {
  private updates: Array<{ tenantId: string; id: string; fields: Record<string, unknown>; type: string }> = [];

  async updateContact(tenantId: string, contactId: string, fields: Record<string, unknown>) {
    this.updates.push({ tenantId, id: contactId, fields, type: 'contact' });
    return { success: true, updatedFields: Object.keys(fields) };
  }

  async updateDeal(tenantId: string, dealId: string, fields: Record<string, unknown>) {
    this.updates.push({ tenantId, id: dealId, fields, type: 'deal' });
    return { success: true, updatedFields: Object.keys(fields) };
  }

  getUpdates() { return this.updates; }
  clear() { this.updates = []; }
}

export class InMemoryCalendarAdapter implements CalendarAdapter {
  private bookings: Array<Record<string, unknown>> = [];

  async bookMeeting(params: Record<string, unknown>) {
    const bookingId = `booking_${crypto.randomUUID()}`;
    this.bookings.push({ ...params, bookingId });
    return {
      bookingId,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      meetingUrl: `https://cal.com/${bookingId}`,
    };
  }

  getBookings() { return this.bookings; }
  clear() { this.bookings = []; }
}

export class InMemoryWebhookAdapter implements WebhookAdapter {
  private calls: Array<{ url: string; payload: Record<string, unknown> }> = [];

  async fire(url: string, payload: Record<string, unknown>) {
    this.calls.push({ url, payload });
    return { statusCode: 200 };
  }

  getCalls() { return this.calls; }
  clear() { this.calls = []; }
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createOperationalAgentRouter(
  deps: OperationalDependencies,
): Router {
  const router = Router();

  router.post('/operate', async (req: Request, res: Response) => {
    try {
      const input = OperationalAgentInputSchema.parse(req.body);
      const result = await executeOperation(input, deps);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[OperationalAgent] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Operation execution failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  generateOperationId,
  handleCrmUpdate,
  handleBookMeeting,
  handleCloseObjective,
  handleScheduleFollowUp,
  handleWebhook,
};
