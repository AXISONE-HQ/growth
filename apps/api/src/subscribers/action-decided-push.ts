/**
 * action.decided push subscriber — KAN-660
 *
 * Cloud Run Pub/Sub push endpoint. Subscription:
 *   action.decided.message-composer (push to /pubsub/action-decided)
 *
 * Flow:
 *   Pub/Sub push → POST /pubsub/action-decided
 *   → Verify OIDC Bearer token (reject 401 on fail)
 *   → Decode base64 payload + zod-validate ActionDecidedEvent
 *   → Filter non-email channels (ack 200, skip compose)
 *   → Compose subject/body via Haiku (brain.tone fallback)
 *   → Publish action.send to Pub/Sub
 *   → 200 on success
 *
 * Error policy (per KAN-660 decisions):
 *   - 500 (nack → Pub/Sub retries up to 5x → DLQ) on LLM 5xx / network / publish errors
 *   - 200 (ack + drop) on malformed payload / zod validation failure / unknown contact
 *   - 401 on missing or invalid OIDC token
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../prisma.js';
import { getPubSubClient } from '../../../../packages/api/src/lib/pubsub-client.js';
import { ActionDecidedEventSchema } from '../../../../packages/api/src/services/action-decided-publisher.js';
import {
  composeMessage,
  resolveEmailConnectionId,
  gateAndPublishComposed,
} from '../../../../packages/api/src/services/message-composer.js';
import { loadKnowledge } from '../../../../packages/api/src/services/context-assembler.js';

export const actionDecidedPushApp = new Hono();

const oauth = new OAuth2Client();
const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

async function verifyOidc(authHeader: string | undefined, audience: string): Promise<boolean> {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length);
  try {
    const ticket = await oauth.verifyIdToken({ idToken: token, audience });
    return !!ticket.getPayload();
  } catch {
    return false;
  }
}

actionDecidedPushApp.post('/action-decided', async (c) => {
  const skipAuth = process.env.NODE_ENV === 'test' || process.env.PUBSUB_PUSH_SKIP_AUTH === 'true';
  if (!skipAuth) {
    const audience = process.env.APP_API_URL;
    if (!audience) {
      console.error('[action-decided-push] APP_API_URL unset — rejecting');
      return c.text('server misconfigured', 500);
    }
    const ok = await verifyOidc(c.req.header('authorization'), audience);
    if (!ok) return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error('[action-decided-push] malformed envelope', err);
    return c.text('ok', 200);
  }

  let event: z.infer<typeof ActionDecidedEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = ActionDecidedEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error('[action-decided-push] malformed action.decided payload', err);
    return c.text('ok', 200);
  }

  if (event.action.channel !== 'email') {
    console.log(
      `[action-decided-push] skip decisionId=${event.decisionId} channel=${event.action.channel}`,
    );
    return c.text('ok', 200);
  }

  const instruction =
    (event.action.payload?.instruction as string | undefined) ??
    event.decision.actionReasoning ??
    '';
  if (!instruction) {
    console.error(
      `[action-decided-push] no instruction decisionId=${event.decisionId} — ack + drop`,
    );
    return c.text('ok', 200);
  }

  const contact = await prisma.contact.findFirst({
    where: { id: event.contactId, tenantId: event.tenantId },
    select: { email: true },
  });
  if (!contact?.email) {
    console.error(
      `[action-decided-push] contact ${event.contactId} missing email — ack + drop`,
    );
    return c.text('ok', 200);
  }

  const publicWebhookBaseUrl = process.env.PUBLIC_WEBHOOK_BASE_URL ?? 'https://example.invalid';

  try {
    // KAN-698: pull top-K Knowledge Center entries for this tenant + the
    // current instruction so the composed email grounds in tenant facts.
    // loadKnowledge degrades gracefully (returns []) if RAG is unavailable.
    const knowledge = await loadKnowledge(event.tenantId, instruction);

    const composed = await composeMessage(prisma, {
      tenantId: event.tenantId,
      contactId: event.contactId,
      decisionId: event.decisionId,
      instruction,
      publicWebhookBaseUrl,
      knowledge,
    });

    const connectionId =
      (await resolveEmailConnectionId(prisma, event.tenantId)) ?? NIL_UUID;
    if (connectionId === NIL_UUID) {
      console.warn(
        `[action-decided-push] no email ChannelConnection for tenant=${event.tenantId}; publishing with nil connectionId (KAN-661 will supply)`,
      );
    }

    // KAN-697: guardrail gate runs between compose and publishActionSend.
    // gateAndPublishComposed runs validateMessage → decideGuardrailAction →
    // (block) writes Escalation row + publishes escalation.triggered, OR
    // (allow/warn) calls publishActionSend. Single source of truth for
    // severity routing — same runGuardrailGate helper as the rules-path
    // executeCommunication.
    //
    // Tenant guardrail config (Tenant.guardrailSettings JSONB, KAN-450) is
    // loaded here when a Tenant-config loader lands. For V1 we use defaults
    // (block/regenerate → block, warn → allow, pass → allow).
    const fromEmail = process.env.RESEND_DEFAULT_FROM_EMAIL ?? 'hello@growth.axisone.ca';
    const sendResult = await gateAndPublishComposed(
      prisma,
      getPubSubClient(),
      {
        tenantId: event.tenantId,
        contactId: event.contactId,
        decisionId: event.decisionId,
        objectiveId: event.objectiveId,
        toEmail: contact.email,
        fromEmail,
        connectionId,
        strategy: event.decision.selectedStrategy,
        confidenceScore: event.decision.confidenceScore,
      },
      composed,
    );

    if (!sendResult.sent) {
      console.warn(
        `[action-decided-push] guardrail blocked decisionId=${event.decisionId} reason="${sendResult.blockedReason}" — escalation written, no send`,
      );
      return c.text('ok', 200);
    }

    console.log(
      `[action-decided-push] published action.send decisionId=${event.decisionId} messageId=${sendResult.messageId} guardrail=${sendResult.decision}`,
    );
    return c.text('ok', 200);
  } catch (err) {
    console.error(
      `[action-decided-push] transient failure decisionId=${event.decisionId} — nack`,
      err,
    );
    return c.text('retry', 500);
  }
});
