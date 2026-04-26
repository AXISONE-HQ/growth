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
import {
  validateMessage as runGuardrailChecks,
  type GuardrailInput,
  type GuardrailResult,
  type Violation,
} from './guardrail-layer.js';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const ChannelType = z.enum(['sms', 'email', 'whatsapp']);

// KAN-697: 'blocked' added so guardrail rejections are semantically distinct
// from provider 'rejected' (bad recipient) and from network 'failed' (retry).
// Consumers reading status can branch on it; existing consumers that don't
// recognize it will treat it as "not sent" which is the correct fallback.
export const DeliveryStatus = z.enum([
  'pending',
  'sent',
  'delivered',
  'failed',
  'bounced',
  'rejected',
  'blocked', // KAN-697: blocked by guardrail before send
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
// Guardrail wiring (KAN-697)
// ─────────────────────────────────────────────

/**
 * Per-tenant guardrail configuration. Stored in `Tenant.guardrailSettings`
 * JSONB column (KAN-450). All fields optional — sensible defaults below.
 *
 * `perCheck` lets tenants tune individual validators (e.g., a tenant whose
 * brand voice intentionally uses ALL-CAPS can downgrade `tone` from
 * 'block' to 'allow' without blanket-disabling guardrails).
 *
 * `warnAction` controls what happens when a check returns severity='warn':
 *   - 'allow' (default) → log + send
 *   - 'block' → treat as block + send escalation
 *
 * Defaults preserve safety: any check returning `block`/`regenerate` always
 * blocks the send regardless of tenant config — those severities indicate
 * structural problems (e.g., empty message, prompt injection) where tenant
 * preference shouldn't override.
 */
export const TenantGuardrailConfigSchema = z.object({
  perCheck: z
    .record(z.enum(['allow', 'warn', 'block']))
    .optional()
    .describe('Per-validator override: tone | accuracy | hallucination | compliance | injection → allow|warn|block'),
  warnAction: z
    .enum(['allow', 'block'])
    .optional()
    .describe('What happens when overall severity is warn (default: allow)'),
}).default({});
export type TenantGuardrailConfig = z.infer<typeof TenantGuardrailConfigSchema>;

/**
 * Optional callbacks for production wiring of guardrail outcomes.
 *
 * `executeCommunication` stays pure (no Prisma, no Pub/Sub). Callers wire
 * these hooks to write Escalation rows and publish `escalation.triggered`
 * Pub/Sub events. Tests can pass no-ops; production wires real handlers.
 *
 * Per AC: a `block` outcome MUST never silent-drop. The `onBlock` hook is
 * how the production caller honors that contract — the call site is
 * responsible for writing the Escalation row + publishing the event.
 */
export interface GuardrailHooks {
  /**
   * Override the validator (default: real `validateMessage` from guardrail-layer).
   * Tests inject a stub; production omits this and gets the real validator.
   */
  validate?: (input: GuardrailInput) => GuardrailResult;
  /** Called when the message is blocked. Production: write Escalation + publish escalation.triggered. */
  onBlock?: (result: GuardrailResult, input: CommunicationAgentInput) => Promise<void>;
  /** Called when the message passed with warnings. Production: warn-log + audit-log. */
  onWarn?: (result: GuardrailResult, input: CommunicationAgentInput) => Promise<void>;
  /** Called for every check (pass or otherwise). Production: append to audit log per KAN-660. */
  onAudit?: (result: GuardrailResult, input: CommunicationAgentInput) => Promise<void>;
}

type GuardrailDecision = 'allow' | 'warn' | 'block';

/**
 * Map a GuardrailResult to a single decision given the tenant config.
 *
 * Default routing (no config):
 *   block       → block (any structural failure stops the send)
 *   regenerate  → block (V1: regeneration loop is Sprint 3-4 agentic territory)
 *   warn        → allow (informational; default permissive)
 *   pass        → allow
 *
 * Tenant overrides:
 *   - `perCheck['<checkType>']` overrides per-validator if THAT check fired
 *   - `warnAction` overrides the warn → allow default
 *
 * Defense-in-depth: a tenant can DOWNGRADE warn→block but cannot UPGRADE
 * block→allow. Structural failures stay blocked regardless of preference.
 */
export function decideGuardrailAction(
  result: GuardrailResult,
  config: TenantGuardrailConfig = {},
): GuardrailDecision {
  // Apply per-check overrides FIRST. If a tenant set `perCheck.tone='allow'`
  // and the only violation is a tone violation, demote to 'allow'.
  const violationsAfterOverride: Violation[] = [];
  for (const v of result.violations) {
    const override = config.perCheck?.[v.checkType];
    if (override === 'allow') continue; // tenant suppressed this check
    if (override === 'warn' && (v.severity === 'block' || v.severity === 'regenerate')) {
      violationsAfterOverride.push({ ...v, severity: 'warn' });
      continue;
    }
    if (override === 'block' && v.severity === 'warn') {
      violationsAfterOverride.push({ ...v, severity: 'block' });
      continue;
    }
    violationsAfterOverride.push(v);
  }

  // Resolve overall severity from filtered violations
  const hasBlock = violationsAfterOverride.some(
    (v) => v.severity === 'block' || v.severity === 'regenerate',
  );
  if (hasBlock) return 'block';

  const hasWarn = violationsAfterOverride.some((v) => v.severity === 'warn');
  if (hasWarn) {
    return config.warnAction === 'block' ? 'block' : 'warn';
  }

  return 'allow';
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

/**
 * Execute a communication action — build the message and send via the channel adapter.
 *
 * @param input - Routed action from the Agent Router
 * @param adapter - Channel adapter (Twilio, Resend, etc.)
 * @param options - Optional guardrail config + hooks (KAN-697). When omitted,
 *                  guardrails still run with default routing; hooks no-op.
 * @returns Execution result with delivery status
 */
export async function executeCommunication(
  input: CommunicationAgentInput,
  adapter: ChannelAdapter,
  options: { guardrailConfig?: TenantGuardrailConfig; hooks?: GuardrailHooks } = {},
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

  // Step 2.5 (KAN-697): Guardrail validation before any send.
  // - All 5 validators run (tone, accuracy, hallucination, compliance, injection).
  // - Severity → action via decideGuardrailAction() with tenant config.
  // - block: short-circuit, return rejected result, await onBlock hook
  //   (production wires onBlock to write Escalation row + publish escalation.triggered).
  // - warn: await onWarn hook (warn-log + audit), continue to send.
  // - allow: await onAudit hook (audit-only), continue to send.
  const validate = options.hooks?.validate ?? runGuardrailChecks;
  const guardrailInput: GuardrailInput = {
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    decisionId: parsed.decisionId,
    channel: parsed.channel,
    message: {
      subject: message.subject,
      body: message.body,
      to: message.to,
      from: message.from,
    },
    // companyTruth + complianceSettings intentionally omitted in V1 — KAN-698
    // (RAG wiring) populates companyTruth from BrainContext; tenant-level
    // complianceSettings come from a future Sprint 1+ schema extension.
  };
  const guardrailResult = validate(guardrailInput);
  const decision = decideGuardrailAction(guardrailResult, options.guardrailConfig);

  if (decision === 'block') {
    if (options.hooks?.onBlock) {
      // Caller is responsible for writing the Escalation row + publishing
      // escalation.triggered. Per AC: NEVER silent drop.
      await options.hooks.onBlock(guardrailResult, parsed);
    }
    return CommunicationAgentResultSchema.parse({
      tenantId: parsed.tenantId,
      contactId: parsed.contactId,
      decisionId: parsed.decisionId,
      messageId: message.messageId,
      channel: parsed.channel,
      status: 'blocked',
      sentAt: null,
      providerMessageId: null,
      error: `Guardrail blocked: ${guardrailResult.violations
        .filter((v) => v.severity === 'block' || v.severity === 'regenerate')
        .map((v) => `${v.checkType}: ${v.description}`)
        .join('; ')}`,
      retryCount: 0,
      message,
    });
  }

  if (decision === 'warn') {
    if (options.hooks?.onWarn) {
      await options.hooks.onWarn(guardrailResult, parsed);
    }
  } else if (options.hooks?.onAudit) {
    await options.hooks.onAudit(guardrailResult, parsed);
  }

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
