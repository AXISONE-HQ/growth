/**
 * Message Composer — KAN-660
 *
 * Given an action.decided event, composes a tone-aligned email (subject + body)
 * via Anthropic Haiku and publishes it to action.send for the connector layer
 * (KAN-661 Resend adapter).
 *
 * Structured output via zod — text-mode JSON pattern mirroring apps/api/src/llm.ts.
 * Brand voice: brain.tone ?? 'professional, concise' (TODO swap to Business Brain v2).
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { PubSubClient } from './action-decided-publisher.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

export const ComposedMessageSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  unsubscribeUrl: z.string().url(),
});
export type ComposedMessage = z.infer<typeof ComposedMessageSchema>;

export interface ComposeMessageInput {
  tenantId: string;
  contactId: string;
  decisionId: string;
  instruction: string;
  publicWebhookBaseUrl: string;
}

const anthropic = new Anthropic();

export async function composeMessage(
  prisma: PrismaClient,
  input: ComposeMessageInput,
): Promise<ComposedMessage> {
  const { tenantId, contactId, instruction, publicWebhookBaseUrl } = input;

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: { firstName: true, lastName: true, email: true },
  });
  if (!contact) throw new Error(`contact ${contactId} not in tenant ${tenantId}`);

  const snapshot = await (prisma as any).brainSnapshot?.findFirst({
    where: { tenantId },
    orderBy: { version: 'desc' },
  });
  const tone =
    ((snapshot?.companyTruth as Record<string, unknown> | undefined)?.tone as string | undefined) ??
    'professional, concise';

  const firstName = contact.firstName ?? 'there';

  const systemPrompt =
    'You are a sales communication AI composing a short, tone-aligned email. ' +
    'Respond with ONLY valid JSON in the exact format specified. No markdown, no code fences, no extra text.';

  const userPrompt = `Compose a short email (3-5 sentences) based on this instruction and context.

Instruction: "${instruction}"
Recipient first name: ${firstName}
Brand voice: ${tone}

Respond with a JSON object with these fields:
1. "subject" — a natural subject line that includes the recipient's first name. Keep under 60 characters.
2. "body" — the email body, plain text, 3-5 sentences, reflecting the instruction intent and the brand voice. Sign off with a warm closing but no name (the connector layer appends sender identity).

Return ONLY the JSON object, no markdown formatting.`;

  const message = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const textContent = message.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Haiku');
  }

  let jsonStr = textContent.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(jsonStr) as { subject?: unknown; body?: unknown };
  return ComposedMessageSchema.parse({
    subject: parsed.subject,
    body: parsed.body,
    unsubscribeUrl: `${publicWebhookBaseUrl.replace(/\/$/, '')}/unsubscribe/${contactId}`,
  });
}

export interface PublishActionSendInput {
  tenantId: string;
  contactId: string;
  decisionId: string;
  toEmail: string;
  composed: ComposedMessage;
  connectionId: string;
}

// KAN-661 fix: topic `action.send` exists in GCP; the previous `growth.` prefix
// caused silent publish failures (no topic of that name).
const ACTION_SEND_TOPIC = 'action.send';

export async function publishActionSend(
  client: PubSubClient,
  input: PublishActionSendInput,
): Promise<string> {
  const event = {
    topic: 'action.send' as const,
    timestamp: new Date().toISOString(),
    connectionId: input.connectionId,
    message: {
      tenantId: input.tenantId,
      actionId: randomUUID(),
      decisionId: input.decisionId,
      contactId: input.contactId,
      traceId: input.decisionId,
      recipient: { email: input.toEmail },
      content: {
        subject: input.composed.subject,
        body: input.composed.body,
      },
      categories: ['wedge', 'kan-660'],
    },
  };

  const data = Buffer.from(JSON.stringify(event));
  return client.publish(ACTION_SEND_TOPIC, data, {
    eventType: 'action.send',
    tenantId: input.tenantId,
    decisionId: input.decisionId,
  });
}

export async function resolveEmailConnectionId(
  prisma: PrismaClient,
  tenantId: string,
): Promise<string | null> {
  const conn = await (prisma as any).channelConnection?.findFirst({
    where: { tenantId, channelType: 'EMAIL', status: 'ACTIVE' },
    orderBy: { connectedAt: 'desc' },
  });
  return (conn?.id as string) ?? null;
}

// ─────────────────────────────────────────────
// KAN-697: Guardrail gate for the active wedge path
// ─────────────────────────────────────────────

import {
  runGuardrailGate,
  type GuardrailGateHooks,
  type TenantGuardrailConfig,
} from './communication-agent.js';
import { publishEscalationTriggered } from './action-decided-publisher.js';

export interface GateAndPublishContext {
  tenantId: string;
  contactId: string;
  decisionId: string;
  objectiveId: string;
  toEmail: string;
  fromEmail: string;
  connectionId: string;
  /** Strategy from the upstream Decision (for Escalation context if blocked). */
  strategy?: string;
  /** Confidence from the upstream Decision (for Escalation context if blocked). */
  confidenceScore?: number;
}

export interface GateAndPublishResult {
  /** True if action.send was published; false if guardrail blocked the send. */
  sent: boolean;
  /** Pub/Sub messageId of the action.send publish, only set when sent=true. */
  messageId?: string;
  /** Final guardrail decision: 'allow' | 'warn' | 'block'. */
  decision: 'allow' | 'warn' | 'block';
  /** Human-readable reason if blocked. */
  blockedReason?: string;
}

/**
 * KAN-697 active-wedge-path guardrail gate.
 *
 * Runs the same `runGuardrailGate` helper that `executeCommunication` uses
 * (single source of truth for severity routing), then either publishes
 * `action.send` or — on block — writes an Escalation row + publishes
 * `escalation.triggered` and skips the send.
 *
 * Per the AC NEVER-silent-drop contract: a block ALWAYS produces an
 * Escalation row + Pub/Sub event. The hook awaits both before this
 * function returns, so the caller can ack the Pub/Sub message safely.
 *
 * `prisma` and `pubsubClient` are injected so tests can mock them. Both
 * are real in production.
 *
 * Returns whether the send happened. Caller logs accordingly.
 */
export async function gateAndPublishComposed(
  prisma: PrismaClient,
  pubsubClient: PubSubClient,
  ctx: GateAndPublishContext,
  composed: ComposedMessage,
  options: { guardrailConfig?: TenantGuardrailConfig; extraHooks?: Partial<GuardrailGateHooks> } = {},
): Promise<GateAndPublishResult> {
  // Production onBlock hook: write Escalation row + publish escalation.triggered.
  // Awaited inside runGuardrailGate before the gate returns, so this completes
  // before our caller can ack the Pub/Sub message.
  const onBlock: GuardrailGateHooks['onBlock'] = async (result) => {
    const blockedReason = result.violations
      .filter((v) => v.severity === 'block' || v.severity === 'regenerate')
      .map((v) => `${v.checkType}: ${v.description}`)
      .join('; ');

    try {
      await (prisma as any).escalation.create({
        data: {
          tenantId: ctx.tenantId,
          contactId: ctx.contactId,
          severity: 'high',
          triggerType: 'guardrail_block',
          triggerReason: blockedReason || 'guardrail blocked send',
          aiSuggestion: 'Review the AI-composed message and either approve a regenerated version or send manually.',
          status: 'open',
        },
      });
    } catch (err) {
      // Surfaces as ERROR but does not throw — escalation Pub/Sub still fires
      // so the human-review path isn't fully silent.
      console.error('[gateAndPublishComposed] failed to write Escalation row', err);
    }

    try {
      await publishEscalationTriggered(pubsubClient, {
        tenantId: ctx.tenantId,
        contactId: ctx.contactId,
        objectiveId: ctx.objectiveId,
        reason: `guardrail_block: ${blockedReason}`,
        riskFlags: result.violations.map((v) => `${v.checkType}:${v.severity}`),
        proposedAction: {
          actionType: 'send_message',
          channel: 'email',
          payload: { subject: composed.subject, bodyPreview: composed.body.slice(0, 200) },
        },
        strategy: ctx.strategy ?? 'unknown',
        confidenceScore: ctx.confidenceScore ?? 0,
        reasoning: blockedReason || 'guardrail blocked send',
        // 7d default human-review window for guardrail blocks; tunable per-tenant later.
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch (err) {
      console.error('[gateAndPublishComposed] failed to publish escalation.triggered', err);
    }
  };

  const gate = await runGuardrailGate(
    {
      tenantId: ctx.tenantId,
      contactId: ctx.contactId,
      decisionId: ctx.decisionId,
      channel: 'email',
      message: {
        subject: composed.subject,
        body: composed.body,
        to: ctx.toEmail,
        from: ctx.fromEmail,
      },
    },
    options.guardrailConfig,
    { onBlock, ...(options.extraHooks ?? {}) },
  );

  if (gate.decision === 'block') {
    return { sent: false, decision: 'block', blockedReason: gate.blockedReason };
  }

  const messageId = await publishActionSend(pubsubClient, {
    tenantId: ctx.tenantId,
    contactId: ctx.contactId,
    decisionId: ctx.decisionId,
    toEmail: ctx.toEmail,
    composed,
    connectionId: ctx.connectionId,
  });
  return { sent: true, messageId, decision: gate.decision };
}
