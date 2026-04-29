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
  "inbox_email",
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
    /** Sender email address (for inbox_email source) or originator identifier. */
    fromAddress: z.string().optional(),
    /** Email subject line — only set for inbox_email source. */
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
