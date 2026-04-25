/**
 * Message Composer — KAN-660
 *
 * Given an action.decided event, composes a tone-aligned email (subject + body)
 * via Anthropic Haiku and publishes it to action.send for the connector layer
 * (KAN-661 SendGrid adapter).
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
