/**
 * KAN-1007 — SAE PR3: decision.run push subscriber (DORMANT).
 *
 * Wakeup consumer for the autonomous Decision Engine. SHIPS DORMANT in
 * PR3 — no app code publishes `decision.run` until SAE PR5
 * (`audience.activate()`). The hard guards below would refuse to evaluate
 * any contact whose Campaign isn't status='active', and PR1's backfill
 * relabeled every existing inert campaign to 'committed'. So even a
 * manually-published decision.run event during PR3's smoke will no-op.
 *
 * # Three hard guards (load-bearing safety property)
 *
 * Before any call to `runDecisionForContact`, the consumer asserts:
 *
 *   1. Campaign.status === 'active'
 *      — Nothing has this status until PR5's `audience.activate()` writes
 *        it. PR1 (KAN-1004) backfilled the 2 existing PROD campaigns from
 *        'active' (3a-era misnomer) to 'committed' specifically so this
 *        guard means what it says.
 *
 *   2. Campaign.audienceEvaluatedAt IS NOT NULL
 *      — The partial-materialization interlock from
 *        `feedback_3a_inert_3b_interlock_audience_evaluated_at`. The async
 *        materialize worker only sets this column on full completion;
 *        a half-snapshot (container restart mid-pagination, in-flight
 *        Pub/Sub redelivery) leaves it NULL. PR5's activate() will gate
 *        on it; this consumer ALSO gates defensively so a future PR5 bug
 *        that publishes too eagerly still gets caught here.
 *
 *   3. ContactObjectiveStack.status === 'active' for (tenantId, contactId, campaignId)
 *      — The stack-row guard. Pause flips this to 'paused' for the whole
 *        campaign; the consumer skips paused stacks even if the campaign
 *        itself flips back to 'active' later. Defense in depth.
 *
 * All three pass → call `runDecisionForContact({tenantId, contactId})`
 * UNMODIFIED. The function carries the entire existing governance chain
 * (threshold gate, auto-approve matrix, escalation rules, kill-switch).
 * Under `Tenant.autoApproveEnabled = false` (current AxisOne posture,
 * per KAN-1002 Phase 1 Finding 2), the call resolves as an Escalation
 * row + zero outbound sends.
 *
 * Any guard fails → structured-log + 200 (ack). No retry — the only thing
 * Pub/Sub redelivery would do is re-fire the guard rejection.
 *
 * # NOT in PR3
 *
 *   - De-dup state (PR4 — `stack.lastEvaluatedAt` window). Pub/Sub
 *     at-least-once means redelivery can re-fire runDecisionForContact;
 *     each call writes a fresh Decision row. Acceptable in PR3 because
 *     no publisher exists; PR4 lands the dedup before PR5 wires the
 *     real trigger.
 *   - Cost cap (PR4).
 *   - Any new send-path code. The function called is the same
 *     `runDecisionForContact` already exercised by manual playbook launches.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';

// ─────────────────────────────────────────────
// Variable-specifier dynamic import for the cross-rootDir Decision Engine
// entry point. Same pattern the rest of apps/api uses.
// ─────────────────────────────────────────────

interface RunDecisionModule {
  runDecisionForContact: (
    prisma: unknown,
    input: { tenantId: string; contactId: string; actor?: { type: 'USER' | 'SYSTEM'; id: string } },
  ) => Promise<unknown>;
}
let _runDecisionModule: RunDecisionModule | null = null;
async function loadRunDecisionModule(): Promise<RunDecisionModule> {
  if (_runDecisionModule) return _runDecisionModule;
  const spec = '../../../../packages/api/src/services/run-decision-for-contact.js';
  _runDecisionModule = (await import(spec)) as RunDecisionModule;
  return _runDecisionModule;
}

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const DecisionRunEventSchema = z.object({
  tenantId: z.string().uuid(),
  contactId: z.string().uuid(),
  campaignId: z.string().uuid(),
  /** Optional provenance — PR5's activate() sets this; future cron sources
   *  set 'recurring_cron' or 'data_change' so guard-rejection logs can be
   *  triaged by source. */
  source: z.enum(['activate', 'recurring_cron', 'data_change']).optional(),
});

type DecisionRunGuardOutcome =
  | { ok: true }
  | { ok: false; reason: 'campaign_not_active' | 'audience_not_evaluated' | 'stack_not_active' | 'campaign_not_found' | 'stack_not_found' };

// ─────────────────────────────────────────────
// Guard evaluation (extracted for testability + grep-clarity)
//
// The 3-condition test in the brief is mechanical here. Each predicate has
// a dedicated reason code so guard-rejection logs are filterable in Cloud
// Logging without grepping free-text messages.
// ─────────────────────────────────────────────

interface DecisionRunGuardPrisma {
  campaign: {
    findFirst: (args: {
      where: { id: string; tenantId: string };
      select: { id: true; status: true; audienceEvaluatedAt: true };
    }) => Promise<{
      id: string;
      status: string;
      audienceEvaluatedAt: Date | null;
    } | null>;
  };
  contactObjectiveStack: {
    findFirst: (args: {
      where: {
        tenantId: string;
        contactId: string;
        campaignId: string;
      };
      select: { id: true; status: true };
    }) => Promise<{ id: string; status: string } | null>;
  };
}

export async function evaluateDecisionRunGuards(
  prismaClient: DecisionRunGuardPrisma,
  event: { tenantId: string; contactId: string; campaignId: string },
): Promise<DecisionRunGuardOutcome> {
  const campaign = await prismaClient.campaign.findFirst({
    where: { id: event.campaignId, tenantId: event.tenantId },
    select: { id: true, status: true, audienceEvaluatedAt: true },
  });
  if (!campaign) {
    return { ok: false, reason: 'campaign_not_found' };
  }
  // Guard 1
  if (campaign.status !== 'active') {
    return { ok: false, reason: 'campaign_not_active' };
  }
  // Guard 2
  if (campaign.audienceEvaluatedAt === null) {
    return { ok: false, reason: 'audience_not_evaluated' };
  }
  // Guard 3
  const stack = await prismaClient.contactObjectiveStack.findFirst({
    where: {
      tenantId: event.tenantId,
      contactId: event.contactId,
      campaignId: event.campaignId,
    },
    select: { id: true, status: true },
  });
  if (!stack) {
    return { ok: false, reason: 'stack_not_found' };
  }
  if (stack.status !== 'active') {
    return { ok: false, reason: 'stack_not_active' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────

export const decisionRunPushApp = new Hono();

decisionRunPushApp.post('/decision-run', async (c) => {
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error(
      `[decision-run-push] malformed envelope: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  let event: z.infer<typeof DecisionRunEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = DecisionRunEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error(
      `[decision-run-push] malformed event: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  // ─── 3 HARD GUARDS ──────────────────────────────────────────
  const guardResult = await evaluateDecisionRunGuards(prisma, event);

  if (!guardResult.ok) {
    console.log(
      JSON.stringify({
        type: 'decision_run_guard_rejected',
        reason: guardResult.reason,
        tenantId: event.tenantId,
        contactId: event.contactId,
        campaignId: event.campaignId,
        source: event.source ?? 'unspecified',
        messageId: envelope.message.messageId,
      }),
    );
    // Ack — Pub/Sub redelivery would only re-fire the same guard rejection.
    return c.text('ok', 200);
  }

  // ─── ALL GUARDS PASSED — call Decision Engine unmodified ────
  // Governance pass-through: runDecisionForContact carries the full chain
  // (threshold gate, auto-approve matrix, escalation rules, kill-switch).
  // Under autoApproveEnabled=false the kill-switch routes to ESCALATED
  // outcome → Escalation row written + escalation.triggered Pub/Sub; NO
  // action.decided publish, NO outbound. See KAN-1002 Phase 1 Finding 2.
  try {
    const { runDecisionForContact } = await loadRunDecisionModule();
    const decision = await runDecisionForContact(prisma, {
      tenantId: event.tenantId,
      contactId: event.contactId,
      actor: { type: 'SYSTEM', id: 'decision-run-push' },
    });
    console.log(
      JSON.stringify({
        type: 'decision_run_dispatched',
        tenantId: event.tenantId,
        contactId: event.contactId,
        campaignId: event.campaignId,
        source: event.source ?? 'unspecified',
        messageId: envelope.message.messageId,
        // Don't log the full decision (PII risk) — outcome/decisionId
        // only. Full payload is in the Decision row + audit log.
        decisionSummary:
          decision && typeof decision === 'object'
            ? {
                decisionId: (decision as { decisionId?: string }).decisionId,
                outcome: (decision as { outcome?: string }).outcome,
                strategy: (decision as { strategy?: string }).strategy,
              }
            : null,
      }),
    );
    return c.text('ok', 200);
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'decision_run_dispatched',
        status: 'failed',
        tenantId: event.tenantId,
        contactId: event.contactId,
        campaignId: event.campaignId,
        error: err instanceof Error ? err.message : String(err),
        messageId: envelope.message.messageId,
      }),
    );
    // Nack — runDecisionForContact transient errors (DB connection, LLM
    // timeout) merit Pub/Sub redelivery. Permanent errors burn through to
    // the DLQ after max_delivery_attempts.
    return c.text('retry', 500);
  }
});
