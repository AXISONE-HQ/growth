/**
 * KAN-852 — Account Page Cohort 1. `account.field_updated` Pub/Sub event.
 *
 * Published by every successful update mutation on the accountRouter (sub-
 * router inline in apps/api/src/router.ts). The downstream consumer that
 * writes these events to the AuditLog table — letting the existing audit
 * UI (KAN-830) render Account changes as `AIActionCard` entries — is
 * scheduled for Cohort 6 alongside the per-field detection treatment +
 * "Last updated" click-through.
 *
 * Cohort 1 hard-gates the actual `topic.publishMessage()` call behind the
 * env flag `ACCOUNT_EVENTS_ENABLED` (default false) so this PR ships pure
 * code/schema with zero infra-coupling. Cohort 6 owns Terraform topic
 * creation, push subscriber wiring, and flipping the flag to true.
 *
 * Naming convention: `<noun>.<verb_past>` — matches `knowledge.source_ingested`
 * (KAN-827) and `lead.received` (KAN-741). Per memory
 * `feedback_pubsub_route_registration_vs_subscription_config`, the topic
 * name + push endpoint route + gcloud subscription `--push-endpoint` must
 * align exactly when wiring the consumer in Cohort 6.
 */
import { z } from "zod";

// ─────────────────────────────────────────────
// Source taxonomy — who initiated the change
// ─────────────────────────────────────────────

/**
 * `human` — user save from the /settings/account UI (Cohort 1 default).
 * `ai_detection` — Cohort 6 acceptance of a detect-from-website proposal.
 * Reserve room for future sources without breaking the contract.
 */
export const AccountFieldUpdateSourceEnum = z.enum(["human", "ai_detection"]);
export type AccountFieldUpdateSource = z.infer<typeof AccountFieldUpdateSourceEnum>;

// ─────────────────────────────────────────────
// Event payload schema
// ─────────────────────────────────────────────

/**
 * `account.field_updated` event payload. Published once per field that
 * changed within a single mutation. A multi-field update (e.g.,
 * updateIdentity touching legalName + displayName + websiteUrl) emits one
 * event per field — the downstream AuditLog row maps 1:1.
 *
 * `oldValue` / `newValue` are stringified for forward-compat: scalars,
 * arrays, JSON objects, and dates all serialize cleanly. Consumers that
 * need typed access JSON.parse on read.
 */
export const AccountFieldUpdatedEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal("account.field_updated"),
  version: z.literal("1.0"),
  publishedAt: z.string().datetime(),
  tenantId: z.string().uuid(),
  fieldPath: z.string().min(1),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  source: AccountFieldUpdateSourceEnum,
  /** Set when source='human' to attribute the change in the audit log. */
  userId: z.string().nullable().optional(),
});
export type AccountFieldUpdatedEvent = z.infer<typeof AccountFieldUpdatedEventSchema>;

/**
 * Helper for producers — build a canonical event payload. Producers MUST
 * call this so version + eventType literals stay in lockstep; mirrors
 * `buildKnowledgeSourceIngestedEvent` in knowledge-source-ingest.ts.
 */
export function buildAccountFieldUpdatedEvent(input: {
  eventId: string;
  tenantId: string;
  fieldPath: string;
  oldValue: unknown;
  newValue: unknown;
  source: AccountFieldUpdateSource;
  userId?: string | null;
}): AccountFieldUpdatedEvent {
  return AccountFieldUpdatedEventSchema.parse({
    eventId: input.eventId,
    eventType: "account.field_updated",
    version: "1.0",
    publishedAt: new Date().toISOString(),
    tenantId: input.tenantId,
    fieldPath: input.fieldPath,
    oldValue: serializeValue(input.oldValue),
    newValue: serializeValue(input.newValue),
    source: input.source,
    userId: input.userId ?? null,
  });
}

/**
 * Coerce arbitrary input into the wire-format string. `null` and
 * `undefined` are treated as absent (audit log shows "—"); everything
 * else is JSON-stringified.
 */
function serializeValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ─────────────────────────────────────────────
// Topic name (single source of truth)
// ─────────────────────────────────────────────

/**
 * Pub/Sub topic name for the `account.field_updated` event. Cohort 6
 * provisions this topic via Terraform alongside the AuditLog push
 * subscriber; Cohort 1 only references the constant from the publisher
 * (guarded by ACCOUNT_EVENTS_ENABLED, so no real publish until the topic
 * exists).
 */
export const ACCOUNT_FIELD_UPDATED_TOPIC = "account.field_updated";
