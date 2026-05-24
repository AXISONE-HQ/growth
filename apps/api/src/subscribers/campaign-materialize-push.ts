/**
 * KAN-1007 — SAE PR3: campaign.materialize push subscriber.
 *
 * Durable replacement for the KAN-1002 in-process fire-and-forget worker
 * (folds KAN-1003). Pub/Sub at-least-once delivery + ack/nack semantics
 * provide the durability the in-process approach lacked: container restart
 * mid-pagination → Pub/Sub redelivers → batched INSERT with
 * `skipDuplicates: true` (existing `@@unique([campaignId, contactId])`)
 * keeps the snapshot idempotent.
 *
 * Behavior:
 *   - OIDC verify (shared `verifyPubsubOidc` — audience derived from
 *     request URL; no env var per `feedback_kan_732_audience_class_eliminated`)
 *   - Envelope + event parse (Zod; poison → ack+drop with 200)
 *   - Tenant-scoped Campaign read (defensive — message could be stale)
 *   - Delegate to `materializeAudienceSnapshot()` (unchanged from KAN-1002;
 *     pages contacts in 500-row batches, INSERTs CampaignMembership rows,
 *     sets `audienceEvaluatedAt` + `audienceSnapshotCount` on full completion)
 *   - 200 on success (ack); 500 on transient error (nack → redelivery);
 *     200 on permanent error (poison → ack+drop)
 *
 * Safety property: `audienceEvaluatedAt` is set ONLY after the final
 * batch completes. SAE PR5's activation interlock (per
 * `feedback_3a_inert_3b_interlock_audience_evaluated_at`) reads this column
 * before any decision.run publish — a partially-materialized snapshot (mid-
 * pagination restart, redelivery in flight) leaves it NULL and PR5 will
 * refuse to activate.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';

// ─────────────────────────────────────────────
// Variable-specifier dynamic import (per
// reference_variable_specifier_dynamic_import.md): bypasses TS6059
// cross-rootDir while keeping the live import working at runtime + in
// vitest (vi.mock matches by resolved path).
// ─────────────────────────────────────────────

interface CampaignCommitModule {
  materializeAudienceSnapshot: (
    prisma: unknown,
    args: { tenantId: string; campaignId: string; conditions: unknown },
  ) => Promise<{
    campaignId: string;
    totalContactsScanned: number;
    totalMembershipInserted: number;
    batchCount: number;
  }>;
}
let _campaignCommitModule: CampaignCommitModule | null = null;
async function loadCampaignCommitModule(): Promise<CampaignCommitModule> {
  if (_campaignCommitModule) return _campaignCommitModule;
  const spec = '../../../../packages/api/src/services/campaign-commit.js';
  _campaignCommitModule = (await import(spec)) as CampaignCommitModule;
  return _campaignCommitModule;
}

// ─────────────────────────────────────────────
// Envelope + event schemas
// ─────────────────────────────────────────────

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

/**
 * Inner event schema — published by `audience.commit` tRPC mutation when
 * audience size exceeds `MEMBERSHIP_SYNC_LIMIT` (500). `conditions` is
 * the AudienceConditions JSONB the campaign was committed with; the
 * worker re-parses it via AudienceConditionsSchema inside
 * `materializeAudienceSnapshot()` for defense-in-depth.
 */
const CampaignMaterializeEventSchema = z.object({
  tenantId: z.string().uuid(),
  campaignId: z.string().uuid(),
  conditions: z.unknown(), // schema-parsed inside the worker
});

// ─────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────

export const campaignMaterializePushApp = new Hono();

campaignMaterializePushApp.post('/campaign-materialize', async (c) => {
  // OIDC verify — same shared helper as other push subscribers.
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  // Envelope parse — poison → ack+drop. Pub/Sub redelivery cannot recover
  // a malformed envelope; nack'ing would only chew through delivery
  // attempts to the DLQ.
  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error(
      `[campaign-materialize-push] malformed envelope: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  let event: z.infer<typeof CampaignMaterializeEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = CampaignMaterializeEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error(
      `[campaign-materialize-push] malformed event: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  // Defensive Campaign existence + tenant scope check. The producer (commit
  // mutation) writes the Campaign inside the same tx that publishes, so
  // by the time Pub/Sub delivers, the row is committed + visible. A miss
  // here means the message is stale (campaign was archived/deleted between
  // commit and delivery) or wrong-tenant (cosmic); either way, no work to
  // do — ack+drop.
  const campaign = await prisma.campaign.findFirst({
    where: { id: event.campaignId, tenantId: event.tenantId },
    select: { id: true, status: true, audienceEvaluatedAt: true },
  });
  if (!campaign) {
    console.warn(
      `[campaign-materialize-push] campaign not found tenantId=${event.tenantId} campaignId=${event.campaignId} — ack+drop`,
    );
    return c.text('ok', 200);
  }

  // Idempotency optimization: if a previous delivery already completed
  // the snapshot (audienceEvaluatedAt set), skip the re-run. Per-batch
  // skipDuplicates means a re-run would be safe (no dups), but skipping
  // avoids the wasted pagination + DB load.
  if (campaign.audienceEvaluatedAt !== null) {
    console.log(
      `[campaign-materialize-push] already materialized tenantId=${event.tenantId} campaignId=${event.campaignId} audienceEvaluatedAt=${campaign.audienceEvaluatedAt.toISOString()} — ack+drop`,
    );
    return c.text('ok', 200);
  }

  // Delegate to the lifted worker. Transient errors (DB connection,
  // timeout) bubble up → 500 → nack → Pub/Sub redelivers with backoff.
  try {
    const { materializeAudienceSnapshot } = await loadCampaignCommitModule();
    const result = await materializeAudienceSnapshot(prisma, {
      tenantId: event.tenantId,
      campaignId: event.campaignId,
      conditions: event.conditions,
    });
    console.log(
      JSON.stringify({
        type: 'campaign_materialize_async',
        status: 'success',
        tenantId: event.tenantId,
        campaignId: event.campaignId,
        totalContactsScanned: result.totalContactsScanned,
        totalMembershipInserted: result.totalMembershipInserted,
        batchCount: result.batchCount,
        messageId: envelope.message.messageId,
        durableTransport: 'pubsub',
      }),
    );
    return c.text('ok', 200);
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'campaign_materialize_async',
        status: 'failed',
        tenantId: event.tenantId,
        campaignId: event.campaignId,
        error: err instanceof Error ? err.message : String(err),
        messageId: envelope.message.messageId,
      }),
    );
    // Nack → Pub/Sub redelivers. After max_delivery_attempts (5), the
    // DLQ takes the message.
    return c.text('retry', 500);
  }
});
