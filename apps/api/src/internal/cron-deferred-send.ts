/**
 * KAN-814 — Cron HTTP route for the deferred-send evaluator.
 *
 * Mounted at POST /internal/cron/deferred-send-evaluator. Cloud Scheduler
 * fires every 5 minutes with an OIDC bearer token; the route reuses the
 * existing `verifyPubsubOidc` helper (KAN-732) which derives the expected
 * audience from the request URL and validates Google-issued OIDC tokens
 * generically — works equally for Pub/Sub push and Cloud Scheduler HTTP
 * triggers (despite the helper's pubsub-flavored name).
 *
 * The route is a thin wrapper: load production dependencies, call
 * `processPendingDeferredSends`, return JSON summary. The evaluator does
 * the work in `packages/api/src/services/deferred-send-evaluator.ts`.
 *
 * Auth: 401 on missing/invalid OIDC. NODE_ENV=test bypass per existing
 * test convention.
 *
 * Error policy: HTTP 500 on unhandled evaluator throws (Cloud Scheduler
 * will retry per its own policy). Per-row errors are caught + logged
 * inside the evaluator and don't fail the request.
 */
import { Hono } from 'hono';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';

export const cronDeferredSendApp = new Hono();

// ─────────────────────────────────────────────
// Variable-specifier dynamic imports — TS6059 cohort hygiene
// (sibling discipline to lead-received-push.ts module loaders).
// ─────────────────────────────────────────────

interface DeferredSendEvaluatorModule {
  processPendingDeferredSends: (
    prisma: unknown,
    opts: Record<string, unknown>,
  ) => Promise<{
    totalClaimed: number;
    dispatched: number;
    reDeferred: number;
    expired: number;
    cancelled: number;
    errors: number;
    rowResults: Array<{ id: string; outcome: string }>;
  }>;
}
let _evaluatorModule: DeferredSendEvaluatorModule | null = null;
async function loadEvaluatorModule(): Promise<DeferredSendEvaluatorModule> {
  if (_evaluatorModule) return _evaluatorModule;
  const spec = '../../../../packages/api/src/services/deferred-send-evaluator.js';
  _evaluatorModule = (await import(spec)) as DeferredSendEvaluatorModule;
  return _evaluatorModule;
}

interface SendPolicyModule {
  evaluateSendPolicy: (...args: unknown[]) => Promise<unknown>;
}
let _sendPolicyModule: SendPolicyModule | null = null;
async function loadSendPolicyModule(): Promise<SendPolicyModule> {
  if (_sendPolicyModule) return _sendPolicyModule;
  const spec = '../../../../packages/api/src/services/send-policy.js';
  _sendPolicyModule = (await import(spec)) as SendPolicyModule;
  return _sendPolicyModule;
}

interface MessageComposerModule {
  publishActionSend: (...args: unknown[]) => Promise<string>;
  resolveEmailConnectionId: (prisma: unknown, tenantId: string) => Promise<string | null>;
  resolveReplyToForTenant: (prisma: unknown, tenantId: string) => Promise<string | null>;
}
let _messageComposerModule: MessageComposerModule | null = null;
async function loadMessageComposerModule(): Promise<MessageComposerModule> {
  if (_messageComposerModule) return _messageComposerModule;
  const spec = '../../../../packages/api/src/services/message-composer.js';
  _messageComposerModule = (await import(spec)) as MessageComposerModule;
  return _messageComposerModule;
}

/**
 * KAN-1005 M2-2 + KAN-1046 — engine-path replay publisher. Loaded
 * separately from message-composer because the replay publisher lives
 * in action-decided-publisher.ts (different module).
 *
 * Wires `republishActionDecidedEvent` (re-validator), NOT
 * `publishActionDecided` (flat-input builder). The stashed payload is
 * the previously-validated nested envelope; the builder would attempt
 * a flat-to-nested rebuild on an already-nested input, find every flat
 * field `undefined`, and `ZodError` at schema parse. See KAN-1046 for
 * the root-cause trace.
 */
interface ActionDecidedPublisherModule {
  republishActionDecidedEvent: (
    pubsubClient: unknown,
    event: Record<string, unknown>,
  ) => Promise<{ published: boolean; messageId: string | null }>;
}
let _actionDecidedPublisherModule: ActionDecidedPublisherModule | null = null;
async function loadActionDecidedPublisherModule(): Promise<ActionDecidedPublisherModule> {
  if (_actionDecidedPublisherModule) return _actionDecidedPublisherModule;
  const spec = '../../../../packages/api/src/services/action-decided-publisher.js';
  _actionDecidedPublisherModule = (await import(spec)) as ActionDecidedPublisherModule;
  return _actionDecidedPublisherModule;
}

interface PubSubClientModule {
  getPubSubClient: () => unknown;
}
let _pubsubClientModule: PubSubClientModule | null = null;
async function loadPubSubClientModule(): Promise<PubSubClientModule> {
  if (_pubsubClientModule) return _pubsubClientModule;
  const spec = '../../../../packages/api/src/lib/pubsub-client.js';
  _pubsubClientModule = (await import(spec)) as PubSubClientModule;
  return _pubsubClientModule;
}

cronDeferredSendApp.post('/cron/deferred-send-evaluator', async (c) => {
  // OIDC verification — same audience-derivation pattern as the Pub/Sub
  // push routes. Cloud Scheduler signs tokens identically.
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  try {
    const { processPendingDeferredSends } = await loadEvaluatorModule();
    const { evaluateSendPolicy } = await loadSendPolicyModule();
    const { publishActionSend, resolveEmailConnectionId, resolveReplyToForTenant } =
      await loadMessageComposerModule();
    // KAN-1005 M2-2 + KAN-1046 — engine-path replay uses
    // `republishActionDecidedEvent` (re-validator), not the builder.
    // Cron evaluator switches on row.replay_via and calls this for
    // replayVia='action_decided' rows.
    const { republishActionDecidedEvent } = await loadActionDecidedPublisherModule();
    const { getPubSubClient } = await loadPubSubClientModule();

    const result = await processPendingDeferredSends(prisma, {
      evaluateSendPolicy,
      publishActionSend,
      publishActionDecided: republishActionDecidedEvent,
      resolveEmailConnectionId,
      resolveReplyToForTenant,
      getPubSubClient,
    });

    return c.json({
      ok: true,
      totalClaimed: result.totalClaimed,
      dispatched: result.dispatched,
      reDeferred: result.reDeferred,
      expired: result.expired,
      cancelled: result.cancelled,
      errors: result.errors,
    });
  } catch (err) {
    console.error(
      `[cron-deferred-send] evaluator-failed err=${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('error', 500);
  }
});
