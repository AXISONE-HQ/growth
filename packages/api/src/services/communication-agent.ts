/**
 * Communication Agent — KAN-377
 *
 * Agent Dispatcher — EXECUTE phase
 * Generates and sends messages via SMS (Twilio) and Email (Resend).
 * Includes channel adapter interfaces, message template rendering,
 * delivery status tracking, and retry logic.
 *
 * Architecture reference:
 *   Agent Router (communication)
 *       │
 *   Communication Agent
 *       │
 *   ┌───┴──────────┐
 *   SMS (Twilio)   Email (Resend)
 *       │
 *   Guardrail Layer  ← validate before send
 *       │
 *   Channel Send → delivery status → action.executed
 *
 * Channels:
 *   - SMS: Twilio API (10DLC registered)
 *   - Email: Resend API (SPF/DKIM/DMARC per tenant)
 *   - WhatsApp: Phase 2 (Twilio WhatsApp Business API)
 */

import { z } from 'zod';
import crypto from 'crypto';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const ChannelType = z.enum(['sms', 'email', 'whatsapp']);

export const DeliveryStatus = z.enum([
  'pending',
  'sent',
  'delivered',
  'failed',
  'bounced',
  'rejected',
]);

export const CommunicationAgentInputSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  objectiveId: z.string(),
  decisionId: z.string(),

  actionType: z.string(),
  channel: ChannelType,
  payload: z.record(z.unknown()),
  strategy: z.string(),
  confidenceScore: z.number(),
  priority: z.enum(['high', 'normal', 'low']),
  maxRetries: z.number(),
  timeoutMs: z.number(),

  // Contact details for delivery
  contact: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    preferredChannel: z.string().optional(),
    timezone: z.string().optional(),
  }),

  // Tenant branding
  tenantBranding: z.object({
    companyName: z.string(),
    fromEmail: z.string().optional(),
    fromName: z.string().optional(),
    fromPhone: z.string().optional(),
    emailFooter: z.string().optional(),
    smsSignature: z.string().optional(),
  }),
});

export const MessageSchema = z.object({
  messageId: z.string(),
  channel: ChannelType,
  to: z.string(),
  from: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export const CommunicationAgentResultSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  decisionId: z.string(),
  messageId: z.string(),
  channel: ChannelType,
  status: DeliveryStatus,
  sentAt: z.string().datetime().nullable(),
  providerMessageId: z.string().nullable(),
  error: z.string().nullable(),
  retryCount: z.number(),
  message: MessageSchema,
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type CommunicationAgentInput = z.infer<typeof CommunicationAgentInputSchema>;
export type CommunicationAgentResult = z.infer<typeof CommunicationAgentResultSchema>;
export type Message = z.infer<typeof MessageSchema>;

// ─────────────────────────────────────────────
// Channel Adapter Interface
// ─────────────────────────────────────────────

/**
 * Channel adapter interface — abstracts SMS/Email providers for testability.
 * In production: TwilioSmsAdapter, ResendEmailAdapter.
 */
export interface ChannelAdapter {
  channel: string;
  send(message: Message): Promise<{
    providerMessageId: string;
    status: z.infer<typeof DeliveryStatus>;
  }>;
}

// ─────────────────────────────────────────────
// Message Builders
// ─────────────────────────────────────────────

function generateMessageId(): string {
  return `msg_${crypto.randomUUID()}`;
}

/**
 * Build an SMS message from the action payload.
 */
function buildSmsMessage(
  input: CommunicationAgentInput,
): Message {
  const body = (input.payload.messageBody as string) ??
    (input.payload.message as string) ??
    `Hi${input.contact.name ? ` ${input.contact.name}` : ''}, we have an update for you.`;

  const signature = input.tenantBranding.smsSignature
    ? `\n${input.tenantBranding.smsSignature}`
    : `\n— ${input.tenantBranding.companyName}`;

  return MessageSchema.parse({
    messageId: generateMessageId(),
    channel: 'sms',
    to: input.contact.phone ?? '',
    from: input.tenantBranding.fromPhone ?? '',
    subject: null,
    body: body + signature,
  });
}

/**
 * Build an email message from the action payload.
 */
function buildEmailMessage(
  input: CommunicationAgentInput,
): Message {
  const subject = (input.payload.subject as string) ??
    `Update from ${input.tenantBranding.companyName}`;

  const body = (input.payload.messageBody as string) ??
    (input.payload.message as string) ??
    `Hello${input.contact.name ? ` ${input.contact.name}` : ''},\n\nWe wanted to reach out with an update.\n\nBest regards,\n${input.tenantBranding.companyName}`;

  const footer = input.tenantBranding.emailFooter
    ? `\n\n---\n${input.tenantBranding.emailFooter}`
    : '';

  return MessageSchema.parse({
    messageId: generateMessageId(),
    channel: 'email',
    to: input.contact.email ?? '',
    from: input.tenantBranding.fromEmail ?? `noreply@${input.tenantBranding.companyName.toLowerCase().replace(/\s+/g, '')}.com`,
    subject,
    body: body + footer,
    metadata: {
      fromName: input.tenantBranding.fromName ?? input.tenantBranding.companyName,
    },
  });
}

/**
 * Build a message for the specified channel.
 */
export function buildMessage(
  input: CommunicationAgentInput,
): Message {
  switch (input.channel) {
    case 'sms':
      return buildSmsMessage(input);
    case 'email':
      return buildEmailMessage(input);
    case 'whatsapp':
      // Phase 2 — fall back to SMS format for now
      return buildSmsMessage(input);
    default:
      throw new Error(`Unsupported channel: ${input.channel}`);
  }
}

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────

/**
 * Validate that the contact has the required delivery address for the channel.
 */
function validateDeliveryAddress(
  input: CommunicationAgentInput,
): { valid: boolean; error?: string } {
  switch (input.channel) {
    case 'sms':
    case 'whatsapp':
      if (!input.contact.phone) {
        return { valid: false, error: 'Contact has no phone number for SMS/WhatsApp delivery.' };
      }
      return { valid: true };
    case 'email':
      if (!input.contact.email) {
        return { valid: false, error: 'Contact has no email address for email delivery.' };
      }
      return { valid: true };
    default:
      return { valid: false, error: `Unknown channel: ${input.channel}` };
  }
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

/**
 * Execute a communication action — build the message and send via the channel adapter.
 *
 * @param input - Routed action from the Agent Router
 * @param adapter - Channel adapter (Twilio, Resend, etc.)
 * @returns Execution result with delivery status
 */
export async function executeCommunication(
  input: CommunicationAgentInput,
  adapter: ChannelAdapter,
): Promise<CommunicationAgentResult> {
  const parsed = CommunicationAgentInputSchema.parse(input);

  // Step 1: Validate delivery address
  const validation = validateDeliveryAddress(parsed);
  if (!validation.valid) {
    return CommunicationAgentResultSchema.parse({
      tenantId: parsed.tenantId,
      contactId: parsed.contactId,
      decisionId: parsed.decisionId,
      messageId: generateMessageId(),
      channel: parsed.channel,
      status: 'failed',
      sentAt: null,
      providerMessageId: null,
      error: validation.error,
      retryCount: 0,
      message: {
        messageId: generateMessageId(),
        channel: parsed.channel,
        to: '',
        from: '',
        subject: null,
        body: '',
      },
    });
  }

  // Step 2: Build the message
  const message = buildMessage(parsed);

  // Step 3: Send via channel adapter with retry
  let lastError: string | null = null;
  let retryCount = 0;

  for (let attempt = 0; attempt <= parsed.maxRetries; attempt++) {
    try {
      const result = await adapter.send(message);
      return CommunicationAgentResultSchema.parse({
        tenantId: parsed.tenantId,
        contactId: parsed.contactId,
        decisionId: parsed.decisionId,
        messageId: message.messageId,
        channel: parsed.channel,
        status: result.status,
        sentAt: new Date().toISOString(),
        providerMessageId: result.providerMessageId,
        error: null,
        retryCount: attempt,
        message,
      });
    } catch (err: any) {
      lastError = err.message ?? 'Unknown send error';
      retryCount = attempt + 1;
      // Exponential backoff would go here in production
    }
  }

  // All retries exhausted
  return CommunicationAgentResultSchema.parse({
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    decisionId: parsed.decisionId,
    messageId: message.messageId,
    channel: parsed.channel,
    status: 'failed',
    sentAt: null,
    providerMessageId: null,
    error: `Failed after ${retryCount} attempts: ${lastError}`,
    retryCount,
    message,
  });
}

// ─────────────────────────────────────────────
// In-Memory Channel Adapter (for testing)
// ─────────────────────────────────────────────

export class InMemoryChannelAdapter implements ChannelAdapter {
  channel: string;
  private sent: Message[] = [];
  private shouldFail = false;

  constructor(channel: string) {
    this.channel = channel;
  }

  async send(message: Message): Promise<{ providerMessageId: string; status: z.infer<typeof DeliveryStatus> }> {
    if (this.shouldFail) {
      throw new Error('Simulated send failure');
    }
    this.sent.push(message);
    return {
      providerMessageId: `provider_${crypto.randomUUID()}`,
      status: 'sent',
    };
  }

  getSentMessages(): Message[] {
    return this.sent;
  }

  setFailMode(fail: boolean): void {
    this.shouldFail = fail;
  }

  clear(): void {
    this.sent = [];
  }
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createCommunicationAgentRouter(
  adapters: Record<string, ChannelAdapter>,
): Router {
  const router = Router();

  /**
   * POST /api/agent/communicate
   * Execute a communication action.
   */
  router.post('/communicate', async (req: Request, res: Response) => {
    try {
      const input = CommunicationAgentInputSchema.parse(req.body);
      const adapter = adapters[input.channel];
      if (!adapter) {
        res.status(400).json({
          success: false,
          error: `No adapter configured for channel: ${input.channel}`,
        });
        return;
      }
      const result = await executeCommunication(input, adapter);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[CommunicationAgent] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Communication execution failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  buildSmsMessage,
  buildEmailMessage,
  validateDeliveryAddress,
  generateMessageId,
};
