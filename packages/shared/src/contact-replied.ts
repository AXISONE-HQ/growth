/**
 * KAN-1037-PR3 — M3-2.5c Sprint / `contact.replied` event contract.
 *
 * Canonical zod schema shared by the publisher
 * (`apps/api/src/subscribers/lead-received-push.ts`, fires when
 * `writeSidecarAndCorrelate` returns `inbound_correlated`) and the
 * subscriber (`apps/api/src/subscribers/contact-replied-push.ts`,
 * PR3 SKELETON: writes audit + sets Redis cooldown; PR4 wires the
 * actual `runDecisionForContact` engine invocation).
 *
 * Lives in `@growth/shared` so producer + consumer parse against the
 * same shape — same drift-prevention discipline as `lead-received.ts`
 * (the M3-2.5c PR1 precedent).
 *
 * **Topic + subscription provisioning:** see
 * `infra/terraform/contact-replied.tf` for the Pub/Sub topic +
 * push subscription Terraform (Path A `-target` apply per
 * `feedback_terraform_unmanaged_aspirational_state.md`).
 *
 * **Drift discipline note:** typed Zod schema (not Prisma enum), so
 * the existing `enum-drift.test.ts` PAIRS list doesn't directly apply.
 * The adjacent `describe("ContactRepliedEvent schema regression", ...)`
 * block in the same test file asserts the schema parses canonical
 * sample payloads — structural guard against accidental shape
 * regressions. Same pattern locked at `lead-received.ts:18-23`.
 */
import { z } from "zod";

export const CONTACT_REPLIED_TOPIC = "contact.replied";

/**
 * `contact.replied` event payload. The publisher emits this exact
 * shape from `lead-received-push.ts` AFTER the inbound Engagement
 * row's $transaction commits (so the B-override is durable) and
 * AFTER the `emitCorrelationAudit` fire-and-forget. Consumer parses
 * with `ContactRepliedEventSchema.parse(...)`.
 *
 * **Field provenance:**
 *   - `decisionId` + `contactId` come from the matched outbound's
 *     `engagement.decisionId / contactId` (B-override targets, NOT
 *     the redirect-shadowed `event.contactId` from the lead.received
 *     wire — preserves M3-2.5b's redirect-shadowed-rescue invariant).
 *   - `dealId` is the post-B-override `originatorDealId` (resolved
 *     via `resolveActiveDealForContact` against the matched contact).
 *     `null` is permitted because correlation can succeed without
 *     an active Deal on the originator side (edge: Deal closed
 *     between dispatch and reply; M3-2.5b leaves the inbound's
 *     existing dealId as a forensic anchor).
 *   - `inboundEngagementId` is the row this inbound just wrote;
 *     `outboundEngagementId` is the originating outbound matched
 *     via `reply_token` lookup.
 *   - `replyText` is sourced from `event.metadata.bodyPreview` —
 *     already capped at 2000 chars at the webhook layer (matches
 *     `normalizeInbound`'s bodyText.slice(0, 2000) at
 *     `lead-received-push.ts:923 / 1072`). NOT re-fetched from
 *     Engagement to avoid an extra DB roundtrip in the publish-
 *     hot-path. PR4 splices this into the engine prompt as the
 *     new `## Latest inbound` section.
 *   - `metadata.threadDepth` derived via KAN-1056 as a live
 *     `prisma.engagement.count` of prior `email_send` engagements on
 *     `args.outcome.matchedDealId`, cutoff at `event.receivedAt`. When
 *     matchedDealId is null (originator's Deal closed between dispatch
 *     and reply), the publisher falls back to `1` because correlation
 *     succeeded by reply_token so at least one prior outbound exists by
 *     definition. Phase B prompt rendering reads this verbatim.
 *
 * **Versioned** via the `version` literal — bump on incompatible
 * changes; the schema then accepts a discriminated union of versions.
 */
export const ContactRepliedEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal("contact.replied"),
  version: z.literal("1.0"),
  publishedAt: z.string().datetime(),
  tenantId: z.string().uuid(),
  /** Post-B-override matched contact (the originator, NOT the redirect target). */
  contactId: z.string().uuid(),
  /**
   * Post-B-override active Deal on the matched contact. Nullable per edge
   * case above.
   *
   * **Prisma cuid (NOT uuid)** per `packages/db/prisma/schema.prisma:Deal`:
   * `id String @id @default(cuid())`. Same KAN-657 cuid convention as
   * `decisionId` below; `.min(1)` rather than `.uuid()` because cuids fail
   * Zod's uuid validator (caught post-PR3-deploy when a fresh dispatch
   * landed at the publisher with a real Engagement cuid — see
   * `feedback_class_fix_not_instance_fix.md` for the discipline correction).
   */
  dealId: z.string().min(1).nullable(),
  /**
   * Originating Decision id from the matched outbound's
   * `engagement.decisionId`. Prisma cuid (not uuid) — matches the
   * existing `OutboundMessage.decisionId` / `ActionExecutedEvent.decisionId`
   * shape (cuid string, KAN-657 convention).
   */
  decisionId: z.string().min(1),
  /**
   * The inbound Engagement row just written by lead-received-push.
   *
   * **Prisma cuid (NOT uuid)** per `packages/db/prisma/schema.prisma:Engagement`:
   * `id String @id @default(cuid())`. The pre-fix `.uuid()` validator failed
   * every real publish at runtime (caught by the post-deploy verify chain
   * 2026-05-31 13:41 UTC; the buildContactRepliedEvent throw inside the
   * publisher's IIFE caught + warn-logged but no contact.replied event ever
   * fired, blocking the full downstream subscriber chain).
   */
  inboundEngagementId: z.string().min(1),
  /**
   * Originating outbound Engagement row matched via reply_token.
   *
   * **Nullable until KAN-1044 lands** — `CorrelationOutcome` from
   * `writeSidecarAndCorrelate` currently carries `matchedDecisionId`,
   * `matchedContactId`, and `matchedDealId` but NOT the matched outbound's
   * Engagement id. Surfacing it cleanly requires a small refactor to the
   * outcome shape (KAN-1044 follow-up filed during PR3 review). PR3 publisher
   * passes `null` — honest about the gap. Consumers (PR4+) re-derive the
   * outbound row from `decisionId` (one indexed Prisma roundtrip) when they
   * need it; an `if (outboundEngagementId)` guard skips that lookup cleanly
   * post-KAN-1044 when the field starts being populated.
   *
   * **Why nullable rather than placeholder:** an earlier draft passed
   * `inboundEngagementId` as a placeholder, but that semantically lies —
   * code that JOINs `outboundEngagementId` to `engagements` would read the
   * inbound row's data. Nullable forces consumers to handle the "not yet
   * available" case explicitly.
   *
   * **Prisma cuid (NOT uuid)** per the same `Engagement.id` convention as
   * `inboundEngagementId` above. Hotfix landed alongside the
   * `inboundEngagementId` correction to close the class-fix gap.
   */
  outboundEngagementId: z.string().min(1).nullable(),
  /**
   * Body of the reply, normalized + capped at 2000 chars upstream.
   * PR4 splices this into the engine prompt's `## Latest inbound`
   * section. Empty string when the webhook had no body to extract
   * (graceful degradation — engine still re-evaluates with
   * metadata-only context).
   */
  replyText: z.string(),
  /** When the reply actually arrived (Resend webhook occurredAt). */
  replyReceivedAt: z.string().datetime(),
  metadata: z.object({
    /** From-address on the inbound (the contact's email). */
    senderEmail: z.string().email(),
    /** Display name on the From header. Optional + nullable. */
    senderName: z.string().nullable().optional(),
    /** Subject line on the inbound. Empty string when absent. */
    subjectLine: z.string(),
    /**
     * Thread depth — KAN-1056 derives this at publish time as a live
     * `prisma.engagement.count` of prior outbounds on the matched Deal
     * (matchedDealId-null fallback to 1; see publisher in
     * lead-received-push.ts at emitContactRepliedIfCorrelated).
     *
     * `.min(0)` per KAN-1056 because the count CAN be zero in a narrow
     * race window — the inbound Engagement row is written before the
     * publish IIFE runs, but the matched outbound's row write is a
     * separate $transaction. In practice (correlation reached here via
     * reply_token match), the matched outbound row already committed so
     * the count is ≥1, but the schema accepts 0 for forward-compat with
     * any future correlation paths that don't require a prior-outbound
     * row to exist (Phase B+ extensions, KAN-1052 initial-lead path which
     * uses its own threadDepth=0 codepath without going through this
     * publisher).
     */
    threadDepth: z.number().int().min(0),
  }),
});

export type ContactRepliedEvent = z.infer<typeof ContactRepliedEventSchema>;

/**
 * Helper for the publisher in `lead-received-push.ts` — generates a
 * canonical event payload from minimum inputs. Publishers should NOT
 * hand-construct the event object; calling this helper guarantees the
 * version + eventType literals are correct.
 */
export function buildContactRepliedEvent(input: {
  eventId?: string;
  tenantId: string;
  contactId: string;
  dealId: string | null;
  decisionId: string;
  inboundEngagementId: string;
  /** Nullable until KAN-1044 — see schema docstring. */
  outboundEngagementId: string | null;
  replyText: string;
  replyReceivedAt: string;
  metadata: ContactRepliedEvent["metadata"];
}): ContactRepliedEvent {
  const now = new Date().toISOString();
  return ContactRepliedEventSchema.parse({
    eventId: input.eventId ?? crypto.randomUUID(),
    eventType: "contact.replied",
    version: "1.0",
    publishedAt: now,
    tenantId: input.tenantId,
    contactId: input.contactId,
    dealId: input.dealId,
    decisionId: input.decisionId,
    inboundEngagementId: input.inboundEngagementId,
    outboundEngagementId: input.outboundEngagementId,
    replyText: input.replyText,
    replyReceivedAt: input.replyReceivedAt,
    metadata: input.metadata,
  });
}
