/**
 * KAN-741 — Sprint 3 / S3.11 — `lead.received` event contract.
 *
 * Canonical zod schema shared by all producers and all consumers of the
 * `lead.received` topic. Lives in @growth/shared so producer (KAN-741 inbox
 * webhook + KAN-742 lead API) and consumer (KAN-705 assignment worker, plus
 * future producers/consumers) all parse against the same shape.
 *
 * Pre-emptive drift prevention: two producer stories (KAN-741, KAN-742) ship
 * back-to-back. Without a shared schema each producer would freeze its own
 * variant + the consumer would have to handle both shapes. Locking the shape
 * in @growth/shared at KAN-741 PR open keeps KAN-742 + downstream consumers
 * type-checked against the same surface.
 *
 * **Drift discipline note:** this is a typed schema, NOT a Prisma enum, so
 * the existing `enum-drift.test.ts` PAIRS list does not directly apply. The
 * adjacent `describe("LeadReceivedEvent schema regression", ...)` block in
 * the same test file asserts the schema parses canonical sample payloads —
 * a structural guard against accidental shape regressions. PAIRS list
 * rationale extended to cover the same drift-prevention discipline class
 * (Prisma enum ↔ zod mirror AND shared event schema ↔ canonical samples),
 * even though the assertion mechanics differ.
 */
import { z } from "zod";

export const LEAD_RECEIVED_TOPIC = "lead.received";
export const LEAD_RECEIVED_DEADLETTER_TOPIC = "lead.received.deadletter";

/**
 * Source of the lead. Bounded set — extending requires producer + consumer
 * coordination. Adding a new source = update this enum + audit assignment-
 * worker (KAN-705) for posture defaults.
 */
export const LeadSourceEnum = z.enum([
  "email_inbox",
  "lead_api",
  "form_fill",
  "import",
  "crm_sync",
]);
export type LeadSource = z.infer<typeof LeadSourceEnum>;

/**
 * `lead.received` event payload. Producers publish this exact shape;
 * consumers parse with `LeadReceivedEventSchema.parse(...)`.
 *
 * Versioned via the `version` literal — bump on incompatible changes; the
 * schema then accepts a discriminated union of versions.
 */
export const LeadReceivedEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal("lead.received"),
  version: z.literal("1.0"),
  publishedAt: z.string().datetime(),
  tenantId: z.string().uuid(),
  contactId: z.string().uuid(),
  source: LeadSourceEnum,
  metadata: z.object({
    /** Sender email address (for email_inbox source) or originator identifier. */
    fromAddress: z.string().optional(),
    /** Email subject line — only set for email_inbox source. */
    subject: z.string().optional(),
    /** First N chars of body for routing context. Full body lives on the Contact's notes. */
    bodyPreview: z.string().optional(),
    /** How many attachments arrived with the lead. */
    attachmentCount: z.number().int().nonnegative().default(0),
    /** Audit anchor — points back to LeadInboxEvent or LeadApiEvent row. */
    leadInboxEventId: z.string().uuid().optional(),
    leadApiEventId: z.string().uuid().optional(),
    /** API key tag (lead_api source only) for posture/rate-limit attribution. */
    apiKeyTag: z.string().optional(),
    /**
     * KAN-954 — optional vendor-attribution + deal-naming fields for
     * email-forwarded form submissions (Formspree V1; Tally/Typeform later).
     * Additive / backward-compatible: existing producers omit these and
     * consumers fall back to current defaults.
     */
    /** Hidden form field — e.g. `growth-landing-v1`. Persists campaign attribution. */
    formSource: z.string().optional(),
    /** Hidden form field — e.g. `early_access_request`. Persists intent attribution. */
    leadType: z.string().optional(),
    /** Form-vendor identifier — `formspree`, `tally`, etc. */
    vendor: z.string().optional(),
    /**
     * Pre-computed deal name to use when the consumer creates the Deal row.
     * If unset, the consumer uses the Prisma column default (`Untitled deal`).
     * Format example: `Early-access — Acme Corp`.
     */
    dealName: z.string().optional(),
    /**
     * Free-shape map of form-field values from the parser (Formspree V1:
     * role, monthlyLeadVolume, biggestPain, plus echoes of name/email/
     * company/formSource/leadType). The consumer writes this verbatim
     * to Deal.customFields (which DOES have a custom_fields column;
     * Contact does not). Keys are caller-defined strings; values are
     * strings only for V1.
     */
    customFields: z.record(z.string(), z.string()).optional(),
    /**
     * M3-2.5b — Resend Receiving header propagation for inbound reply
     * correlation. All three fields hold the RAW wire form
     * (`<id@domain>` with brackets, References space-separated) so the
     * forensic trail is preserved on the wire; the consumer normalizes
     * via @growth/shared's stripMessageIdBrackets + parseReferencesHeader
     * before sidecar write + outbound-sidecar correlation lookup.
     *
     * Additive + optional: pre-M3-2.5b producers (lead_api, Formspree pre-
     * receiving-fetch) omit this entirely; consumer falls back to the no-
     * correlation path (decisionId stays null; audit row records
     * 'no_in_reply_to_header').
     */
    inboundHeaders: z
      .object({
        /** This inbound's own Message-ID — raw `<id@domain>` form. */
        messageId: z.string().optional(),
        /** Raw `In-Reply-To` header value — `<id@domain>`. */
        inReplyTo: z.string().optional(),
        /** Raw `References` header value — `<id1@d1> <id2@d2> ...`. */
        references: z.string().optional(),
      })
      .optional(),
    /**
     * KAN-1036 — per-decision reply correlation token, parsed from the
     * subaddressed To: at the webhook layer (`<slug>+<replyToken>@<domain>`).
     * Producer side: `resend-inbound.ts` calls `extractSlugAndToken(data.to)`
     * and propagates the 16-char hex token here. Consumer side:
     * `lead-received-push.ts:writeSidecarAndCorrelate` queries
     * `engagement_email_metadata.reply_token` for O(1) correlation against
     * the originating outbound row.
     *
     * Strict 16-char hex regex on parse: an unexpected token shape fails
     * Zod validation upstream of the consumer's lookup — belt-and-
     * suspenders alongside the webhook-level shape validation. Optional +
     * additive: pre-KAN-1036 producers + inbounds with no subaddress
     * omit; consumer falls back to today's orphan-engagement behavior.
     */
    replyToken: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  }),
  receivedAt: z.string().datetime(),
});

export type LeadReceivedEvent = z.infer<typeof LeadReceivedEventSchema>;

/**
 * Helper for producers — generates a canonical event payload from minimum
 * inputs. Producers should NOT hand-construct the event object; calling this
 * helper guarantees the version + eventType literals are correct.
 */
export function buildLeadReceivedEvent(input: {
  eventId: string;
  tenantId: string;
  contactId: string;
  source: LeadSource;
  metadata: LeadReceivedEvent["metadata"];
  receivedAt?: string;
}): LeadReceivedEvent {
  const now = new Date().toISOString();
  return LeadReceivedEventSchema.parse({
    eventId: input.eventId,
    eventType: "lead.received",
    version: "1.0",
    publishedAt: now,
    tenantId: input.tenantId,
    contactId: input.contactId,
    source: input.source,
    metadata: input.metadata,
    receivedAt: input.receivedAt ?? now,
  });
}
