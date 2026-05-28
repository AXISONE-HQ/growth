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
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';
import { getPubSubClient } from '../../../../packages/api/src/lib/pubsub-client.js';
import { ActionDecidedEventSchema } from '../../../../packages/api/src/services/action-decided-publisher.js';
import {
  composeMessage,
  resolveEmailConnectionId,
  gateAndPublishComposed,
} from '../../../../packages/api/src/services/message-composer.js';
import { loadKnowledge } from '../../../../packages/api/src/services/context-assembler.js';
// KAN-1005 M2-5 — human-review sampling lives in apps/api/src/lib/
// (M2-4 pattern). Same-rootDir import; engine never sees this module
// so no new TS6059 in the KAN-689 cohort.
import {
  maybeEnqueueSampledReview,
  resolveSampleRate,
} from '../lib/human-review-sampling.js';

// ─────────────────────────────────────────────
// KAN-1005 M2-2 — Send-policy module loaded via variable-specifier dynamic
// import (cross-rootDir / TS6059 bypass — same pattern as
// lead-received-push.ts loadSendPolicyModule). The send-policy gate is the
// single upstream choke-point on the engine dispatch path: every autonomous
// + approve-to-send action.decided event passes through this subscriber, so
// gating once here covers all 4 production publishActionDecided call sites
// (run-decision-for-contact runAgentic/runPlaybookStep/runFreeform +
// recommendations.accept). KAN-1030's applyRedirect is the downstream
// counterpart; together the order is policy → compose → guardrail →
// dispatch → redirect → provider.
// ─────────────────────────────────────────────

type SendPolicyResult =
  | { type: 'allow'; reason: string }
  | { type: 'deny'; reason: string; ruleViolated: 'suppression' | 'rate_limit' }
  | { type: 'defer'; reason: string; deferUntil: Date };

interface SendPolicyModule {
  evaluateSendPolicy: (
    prisma: unknown,
    tenantId: string,
    contactId: string,
    message: { channel: 'email' | 'sms' | 'social' },
  ) => Promise<SendPolicyResult>;
}
let _sendPolicyModule: SendPolicyModule | null = null;
async function loadSendPolicyModule(): Promise<SendPolicyModule> {
  if (_sendPolicyModule) return _sendPolicyModule;
  const spec = '../../../../packages/api/src/services/send-policy.js';
  _sendPolicyModule = (await import(spec)) as SendPolicyModule;
  return _sendPolicyModule;
}

export const actionDecidedPushApp = new Hono();

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

actionDecidedPushApp.post('/action-decided', async (c) => {
  // KAN-732: shared helper derives audience from request URL — retires the
  // per-subscriber APP_API_URL env-var read + local verifyOidc helper.
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
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

  // ─────────────────────────────────────────────
  // KAN-1005 M2-2 — Send-policy gate.
  // BEFORE composeMessage so we don't burn an LLM call composing a message
  // that policy will deny/defer. First-deny ordering inside the gate is
  // suppression > rate-limit > time-of-day (defer).
  //
  // Three outcomes:
  //   - allow → fall through to compose + guardrail + dispatch (existing flow)
  //   - defer → persist deferred_sends row with replay_via='action_decided'
  //             so the cron evaluator (KAN-814) re-publishes the
  //             ActionDecidedEvent at window-open. Full chain reruns post-defer
  //             (compose + guardrail + dispatch) — different from Lead Inbox's
  //             replay_via='action_send' (skips re-compose).
  //   - deny  → best-effort AuditLog row (fire-and-forget + catch) + 200-ack.
  //             No dispatch. Greppable via actionType='engine.send_policy_denied'.
  // ─────────────────────────────────────────────
  try {
    const { evaluateSendPolicy } = await loadSendPolicyModule();
    const policyResult = await evaluateSendPolicy(prisma, event.tenantId, event.contactId, {
      channel: 'email',
    });

    if (policyResult.type === 'deny') {
      console.warn(
        `[action-decided-push] send-policy-denied decisionId=${event.decisionId} ruleViolated=${policyResult.ruleViolated} reason=${policyResult.reason}`,
      );
      // Best-effort AuditLog — fire-and-forget + catch. A failed audit
      // write must not destabilize the deny path or block the ack.
      void prisma.auditLog
        .create({
          data: {
            tenantId: event.tenantId,
            actor: 'engine_send_policy',
            actionType: 'engine.send_policy_denied',
            reasoning: policyResult.reason,
            payload: {
              decisionId: event.decisionId,
              contactId: event.contactId,
              objectiveId: event.objectiveId,
              ruleViolated: policyResult.ruleViolated,
              source: 'action_decided',
              eventId: event.eventId,
            },
          },
        })
        .catch((err: unknown) => {
          console.warn(
            `[action-decided-push] audit-emit-send-policy-denied-failed decisionId=${event.decisionId} err=${(err as Error)?.message ?? String(err)}`,
          );
        });
      return c.text('ok', 200);
    }

    if (policyResult.type === 'defer') {
      // Persist the deferred send so the cron worker can re-publish the
      // ActionDecidedEvent at window-open. Engine-path replay = full chain
      // rerun (compose + guardrail + dispatch); replay_via discriminator
      // routes the cron to publishActionDecided (vs Lead Inbox's
      // publishActionSend with pre-shaped message).
      try {
        await (
          prisma as unknown as {
            deferredSend: {
              create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
            };
          }
        ).deferredSend.create({
          data: {
            tenantId: event.tenantId,
            // KAN-1005 M2-2 — engine-path defers have no Deal anchor today.
            // DeferredSend.dealId is nullable (additive migration in this PR);
            // cron evaluator doesn't depend on it for dispatch (replay_via
            // determines path; dealId is only legacy metadata for Lead Inbox
            // Decision-row writes).
            dealId: null,
            contactId: event.contactId,
            deferUntil: policyResult.deferUntil,
            deferReason: policyResult.reason,
            status: 'pending',
            attempts: 0,
            replayVia: 'action_decided',
            payload: {
              // Stash the full ActionDecidedEvent verbatim so the cron
              // can re-publish it via publishActionDecided. Zod-revalidated
              // at read-time against ActionDecidedEventSchema.
              actionDecidedEvent: event as unknown as Record<string, unknown>,
              originalEventId: event.eventId,
            },
          },
        });
        console.log(
          `[action-decided-push] send-policy-deferred decisionId=${event.decisionId} deferUntil=${policyResult.deferUntil.toISOString()} reason=${policyResult.reason} persisted=true replayVia=action_decided`,
        );
      } catch (err) {
        // Persistence failure is observable but non-fatal: 200-ack so
        // Pub/Sub doesn't storm; the message is lost the same as
        // pre-M2-2 (no defer at all), but the failure is audited.
        console.error(
          `[action-decided-push] send-policy-deferred-persist-failed decisionId=${event.decisionId} err=${(err as Error)?.message ?? String(err)}`,
        );
      }
      return c.text('ok', 200);
    }

    // policyResult.type === 'allow' → fall through to compose + dispatch.
    console.log(
      `[action-decided-push] send-policy-allowed decisionId=${event.decisionId} reason=${policyResult.reason}`,
    );

    const publicWebhookBaseUrl =
      process.env.PUBLIC_WEBHOOK_BASE_URL ?? 'https://example.invalid';

    // KAN-698: pull top-K Knowledge Center entries for this tenant + the
    // current instruction so the composed email grounds in tenant facts.
    // loadKnowledge degrades gracefully (returns []) if RAG is unavailable.
    const knowledge = await loadKnowledge(event.tenantId, instruction);

    // M3-1b — read discovery target from action.payload (populated by
    // action-determiner.ts when discovery candidate wins). Additive:
    // omitted on non-discovery decisions → composeMessage receives no
    // gapContext → prompt identical to pre-M3-1b path.
    const discoveryTarget = event.action.payload?.discoveryTarget as
      | { subObjectiveKey: string; label: string }
      | undefined;
    const gapContext = discoveryTarget
      ? {
          subObjectiveKey: discoveryTarget.subObjectiveKey,
          label: discoveryTarget.label,
          currentState: 'unknown' as const,
          compound: true,
        }
      : undefined;
    if (gapContext) {
      console.log(
        `[action-decided-push] M3-1b discovery dispatch decisionId=${event.decisionId} subObjectiveKey=${gapContext.subObjectiveKey}`,
      );
    }

    const composed = await composeMessage(prisma, {
      tenantId: event.tenantId,
      contactId: event.contactId,
      decisionId: event.decisionId,
      instruction,
      publicWebhookBaseUrl,
      knowledge,
      ...(gapContext ? { gapContext } : {}),
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

    // ─────────────────────────────────────────────
    // KAN-1005 M2-5 — non-blocking human-review sampling fork.
    //
    // Real action is already in Pub/Sub by this point (publishActionSend
    // fired inside gateAndPublishComposed above). Sampling is a post-hoc
    // observability concern; this fork is fire-and-forget — any throw
    // here is caught + logged with "action UNAFFECTED", never blocks or
    // retries the ack-200 response.
    //
    // Filters on event.decision.decisionSource (M2-5 wire-format
    // discriminator): 'agentic_live' + 'freeform' sample; 'playbook' +
    // 'approve_to_send' skip; undefined (pre-M2-5 in-flight messages)
    // also skip (safe back-compat).
    //
    // Rate read from Tenant.settings.humanReviewSampling.rate via
    // fail-safe parse (defaults to DEFAULT_SAMPLE_RATE on any malformed
    // input; never falls back to 0 or runaway).
    //
    // M2-4 pattern: module lives in apps/api/src/lib/ (same rootDir);
    // engine never imports it, so zero new TS6059 in the KAN-689
    // cohort. Sampling fork lives where it semantically belongs —
    // post-execution observability in the dispatch layer.
    // ─────────────────────────────────────────────
    void (async () => {
      try {
        const tenantRow = await prisma.tenant.findUnique({
          where: { id: event.tenantId },
          select: { settings: true },
        });
        const sampleRate = resolveSampleRate(tenantRow?.settings);
        // M3-1b — carry the discovery target into the sample's
        // context.discoveryTarget so operators spot-check the engine's
        // discovery judgment alongside the routine action.
        const sampleDiscoveryTarget = event.action.payload?.discoveryTarget as
          | { subObjectiveKey: string; label: string; triggerType: 'hard' | 'soft' }
          | undefined;
        const result = await maybeEnqueueSampledReview(prisma, {
          tenantId: event.tenantId,
          contactId: event.contactId,
          decisionId: event.decisionId,
          actionType: event.action.actionType,
          channel: event.action.channel,
          confidence: event.decision.confidenceScore,
          decisionSource: event.decision.decisionSource,
          reasoning: event.decision.actionReasoning,
          sampleRate,
          ...(sampleDiscoveryTarget ? { discoveryTarget: sampleDiscoveryTarget } : {}),
        });
        if (result.sampled) {
          console.log(
            JSON.stringify({
              type: 'human_review_sample_enqueued',
              tenantId: event.tenantId,
              decisionId: event.decisionId,
              escalationId: result.escalationId,
              sampleRate,
              decisionSource: event.decision.decisionSource,
            }),
          );
        }
      } catch (sampleErr) {
        console.error(
          `[action-decided-push] human-review sampling failed decisionId=${event.decisionId} (action UNAFFECTED):`,
          sampleErr,
        );
      }
    })();

    return c.text('ok', 200);
  } catch (err) {
    console.error(
      `[action-decided-push] transient failure decisionId=${event.decisionId} — nack`,
      err,
    );
    return c.text('retry', 500);
  }
});
