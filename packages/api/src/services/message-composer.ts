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

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { PubSubClient } from './action-decided-publisher.js';
import { complete as llmComplete } from './llm-client.js';
import type { KnowledgeHit } from './context-assembler.js';

/** KAN-703: subset of the BrainContext.pipeline shape we render in the prompt. */
export interface PipelineContext {
  name: string;
  objectiveType: string;
  objectiveDescription?: string | null;
}

/** KAN-703: subset of the BrainContext.stage shape we render in the prompt. */
export interface StageContext {
  name: string;
  isInitial?: boolean;
  isTerminal?: boolean;
}

/** KAN-703: subset of MicroObjective for the prompt — name + completion status if known. */
export interface MicroObjectiveContext {
  id: string;
  name: string;
}

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
  /**
   * KAN-698: top-K Knowledge Center entries for this tenant + context.
   * When present, injected into the user prompt so Haiku grounds the email
   * in tenant facts instead of hallucinating. Caller fetches via
   * `loadKnowledge` from context-assembler.
   */
  knowledge?: KnowledgeHit[];
  /**
   * KAN-703: pipeline-aware context. When present, the composer prepends a
   * "Pipeline Context" block before the knowledge block so Haiku knows what
   * funnel + stage + outstanding micro-objectives the message is operating
   * within. Legacy contacts (pre-pipeline-assignment) get all three undefined
   * and the prompt falls back to the KAN-660 / KAN-698 baseline.
   */
  pipeline?: PipelineContext;
  stage?: StageContext;
  microObjectives?: MicroObjectiveContext[];
  /** Per-MicroObjective progress: `{ moId: { completed, completedAt, evidence } }`. */
  microObjectiveProgress?: Record<string, unknown>;
}

/** KAN-698: render knowledge hits as a compact prompt block. */
function formatKnowledgeBlock(hits: KnowledgeHit[]): string {
  if (!hits.length) return '';
  const lines = hits
    .map((h, i) => {
      const text = (h.contentText ?? '').trim();
      if (!text) return null;
      return `${i + 1}. [${h.contentType}] ${text}`;
    })
    .filter((l): l is string => l !== null);
  if (!lines.length) return '';
  return `\nTenant Knowledge (use these facts to ground the message; do not contradict them):\n${lines.join('\n')}\n`;
}

/**
 * KAN-703: render pipeline + stage + outstanding micro-objectives as a compact
 * prompt block. Returns '' when no pipeline context is provided so the prompt
 * stays at the KAN-660 baseline for legacy contacts.
 */
function formatPipelineBlock(
  pipeline: PipelineContext | undefined,
  stage: StageContext | undefined,
  microObjectives: MicroObjectiveContext[] | undefined,
  microObjectiveProgress: Record<string, unknown> | undefined,
): string {
  if (!pipeline && !stage && (!microObjectives || microObjectives.length === 0)) return '';
  const parts: string[] = ['\nPipeline Context (frame the message within this funnel + stage):'];
  if (pipeline) {
    const desc = pipeline.objectiveDescription ? ` — ${pipeline.objectiveDescription}` : '';
    parts.push(`- Pipeline: ${pipeline.name} (objective: ${pipeline.objectiveType}${desc})`);
  }
  if (stage) {
    const flags: string[] = [];
    if (stage.isInitial) flags.push('initial');
    if (stage.isTerminal) flags.push('terminal');
    const flagSuffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    parts.push(`- Stage: ${stage.name}${flagSuffix}`);
  }
  if (microObjectives && microObjectives.length > 0) {
    const outstanding = microObjectives.filter((mo) => {
      const progress = microObjectiveProgress?.[mo.id] as { completed?: boolean } | undefined;
      return !progress?.completed;
    });
    if (outstanding.length > 0) {
      parts.push(`- Outstanding micro-objectives: ${outstanding.map((mo) => mo.name).join('; ')}`);
    }
  }
  return parts.join('\n') + '\n';
}

export async function composeMessage(
  prisma: PrismaClient,
  input: ComposeMessageInput,
): Promise<ComposedMessage> {
  const {
    tenantId,
    contactId,
    instruction,
    publicWebhookBaseUrl,
    knowledge,
    pipeline,
    stage,
    microObjectives,
    microObjectiveProgress,
  } = input;

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: { firstName: true, lastName: true, email: true },
  });
  if (!contact) throw new Error(`contact ${contactId} not in tenant ${tenantId}`);

  // KAN-1023 audit: stripped `(prisma as any).brainSnapshot?.` cast.
  const snapshot = await prisma.brainSnapshot.findFirst({
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

  const knowledgeBlock = formatKnowledgeBlock(knowledge ?? []);
  const pipelineBlock = formatPipelineBlock(pipeline, stage, microObjectives, microObjectiveProgress);

  const userPrompt = `Compose a short email (3-5 sentences) based on this instruction and context.

Instruction: "${instruction}"
Recipient first name: ${firstName}
Brand voice: ${tone}
${pipelineBlock}${knowledgeBlock}
Respond with a JSON object with these fields:
1. "subject" — a natural subject line that includes the recipient's first name. Keep under 60 characters.
2. "body" — the email body, plain text, 3-5 sentences, reflecting the instruction intent and the brand voice. Sign off with a warm closing but no name (the connector layer appends sender identity).

Return ONLY the JSON object, no markdown formatting.`;

  const llm = await llmComplete({
    tenantId,
    tier: 'cheap',
    systemPrompt,
    userPrompt,
    maxTokens: 512,
    jsonMode: true,
    callerTag: 'message-composer:compose',
  });

  let jsonStr = llm.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(jsonStr) as { subject?: unknown; body?: unknown };
  // KAN-1005 M2-6b — append CAN-SPAM unsubscribe footer; guardrail-layer body keyword check requires it. KAN-808 owns final HTML polish.
  const unsubscribeUrl = `${publicWebhookBaseUrl.replace(/\/$/, '')}/unsubscribe/${contactId}`;
  const bodyText = typeof parsed.body === 'string' ? parsed.body : '';
  const body = `${bodyText.trimEnd()}\n\n---\nUnsubscribe: ${unsubscribeUrl}`;
  return ComposedMessageSchema.parse({ subject: parsed.subject, body, unsubscribeUrl });
}

export interface PublishActionSendInput {
  tenantId: string;
  contactId: string;
  decisionId: string;
  toEmail: string;
  composed: ComposedMessage;
  connectionId: string;
  /**
   * KAN-816: optional per-message Reply-To override. Populated by callers
   * via `resolveReplyToForTenant(prisma, tenantId)` to route recipient
   * replies back to the tenant inbound address (`<inboxSlug>@leads.
   * <LEAD_INBOX_DOMAIN>`). Enables the customer-reply → AI auto-response
   * loop. Optional + additive: callers that omit it preserve legacy
   * behavior (no Reply-To header on outbound; recipient replies go to
   * the From address).
   */
  replyTo?: string;
}

/**
 * KAN-816: Construct a tenant's customer-reply Reply-To address by reading
 * `Tenant.inboxSlug` and combining with `LEAD_INBOX_DOMAIN`. Returns null
 * when the tenant hasn't been assigned an inbox slug yet (legacy tenants
 * pre-KAN-741 + tenants whose admin hasn't called regenerateSlug).
 *
 * Callers (KAN-815c dispatchPhase2Send + legacy gateAndPublishComposed)
 * invoke this BEFORE publishActionSend and pass the result via
 * `PublishActionSendInput.replyTo`. The Resend adapter reads the
 * per-message `replyTo` first, falls back to ChannelConnection metadata.
 */
export async function resolveReplyToForTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<string | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { inboxSlug: true },
  });
  if (!tenant?.inboxSlug) {
    console.warn(
      `[message-composer] resolveReplyToForTenant: tenantId=${tenantId} has no inboxSlug — Reply-To omitted`,
    );
    return null;
  }
  const domain = process.env.LEAD_INBOX_DOMAIN ?? 'leads.axisone.app';
  return `${tenant.inboxSlug}@${domain}`;
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
      // KAN-816: per-message Reply-To override propagated to the Resend
      // adapter. Read by adapters/resend/index.ts:148-149 (`messageReplyTo`)
      // with fallback to ChannelConnection.metadata.replyTo.
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
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
  // KAN-1023 audit: stripped `(prisma as any).channelConnection?.` cast.
  const conn = await prisma.channelConnection.findFirst({
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
      await prisma.escalation.create({
        data: {
          tenantId: ctx.tenantId,
          contactId: ctx.contactId,
          decisionId: ctx.decisionId,
          severity: 'high',
          triggerType: 'guardrail_block',
          triggerReason: blockedReason || 'guardrail blocked send',
          aiSuggestion: 'Review the AI-composed message and either approve a regenerated version or send manually.',
          status: 'open',
          context: {
            strategy: ctx.strategy ?? null,
            confidence: ctx.confidenceScore ?? null,
            violations: result.violations.map((v) => ({
              checkType: v.checkType,
              severity: v.severity,
              description: v.description,
            })),
            objectiveId: ctx.objectiveId,
          } as unknown as object,
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
        // KAN-1005 M2-6b — flow the real Decision row id from ctx so the
        // escalation.triggered event FK-resolves against decisions.id.
        decisionId: ctx.decisionId,
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
