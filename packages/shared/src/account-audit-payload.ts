/**
 * KAN-866 — Account Page Cohort 6: canonical AuditLog payload contract
 * for `account.*` events.
 *
 * The `AuditLog` Prisma model has a slim columnar surface (id, tenantId,
 * actor, actionType, payload Json, reasoning, createdAt). Migration-free
 * is binding for Cohort 6 (per spec §4 + Fred's locked Decision 4), so
 * entityType / entityId / fieldPath / source attribution are shoehorned
 * into the `payload` JSON.
 *
 * **This module is the single source of truth for that payload shape.**
 * Two consumers wired in Cohort 6 + one downstream consumer (KAN-830
 * AIActionCard renderer) all type against this contract:
 *
 *   1. Producer A — `account.field_updated` push subscriber at
 *      `/internal/account-field-updated-subscriber` writes one AuditLog
 *      row per published event with `actionType = "account_field_updated"`.
 *
 *   2. Producer B — the detect-from-website handler (KAN-862) writes
 *      AuditLog rows inline for `account.detect_*` lifecycle events
 *      with `actionType` ∈ {"account_detect_completed",
 *      "account_detect_failed", "account_detect_dead_letter"}.
 *
 *   3. Consumer (KAN-830) — `auditLog.getLastEntry(...)` query +
 *      AIActionCard renderer in /audit UI deserialize the payload field
 *      to render "Last updated by ..." attribution + side-by-side
 *      old/new value diff. Type contract here keeps that consumer +
 *      Cohort 6 producers in lockstep.
 *
 * Wire-format publisher event (`AccountFieldUpdatedEvent` in
 * `account-field-updated.ts`) is a sibling but distinct shape — the
 * subscriber MAPS that wire event into this payload, adding
 * `entityType="AccountProfile"` + the AccountProfile row id.
 */
import { z } from "zod";

import { AccountFieldUpdateSourceEnum } from "./account-field-updated.js";

/**
 * AuditLog `actionType` values used by Cohort 6 producers. Pinned as a
 * Zod enum so any drift between the producer site and the
 * KAN-830/AIActionCard consumer site fails loud at module-load time.
 *
 * `account_field_updated` — emitted per-changed-field on every successful
 * accountRouter mutation (one row per field, one mutation can produce N).
 *
 * `account_detect_completed` / `_failed` / `_dead_letter` — emitted once
 * per scan lifecycle by the detect-from-website handler.
 */
export const AccountAuditActionTypeEnum = z.enum([
  "account_field_updated",
  "account_detect_completed",
  "account_detect_failed",
  "account_detect_dead_letter",
]);
export type AccountAuditActionType = z.infer<typeof AccountAuditActionTypeEnum>;

/**
 * Payload shape stored in `AuditLog.payload` (Json column) for
 * `actionType = "account_field_updated"` rows.
 *
 * Fields with reserved meaning:
 *   - `entityType`: always `"AccountProfile"` for Cohort 6 producers
 *   - `entityId`: the AccountProfile row id (cuid)
 *   - `fieldPath`: dot-notation, e.g. `"primaryPhone"` /
 *     `"weeklyHours.monday.open"` (matches AccountFieldDetection.fieldPath)
 *   - `oldValue` / `newValue`: stringified per the wire-format precedent
 *     (scalars passed as raw strings; objects/arrays JSON.stringify'd)
 *   - `source`: `"human"` (user save) | `"ai_detection"` (proposal accept)
 *   - `userId`: present when source='human'; null when source='ai_detection'
 *   - `detectionId`: present when source='ai_detection' (FK → AccountFieldDetection);
 *     null otherwise
 */
export const AccountFieldUpdatedAuditPayloadSchema = z.object({
  entityType: z.literal("AccountProfile"),
  entityId: z.string().min(1),
  fieldPath: z.string().min(1),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  source: AccountFieldUpdateSourceEnum,
  userId: z.string().nullable(),
  detectionId: z.string().nullable(),
});
export type AccountFieldUpdatedAuditPayload = z.infer<
  typeof AccountFieldUpdatedAuditPayloadSchema
>;

/**
 * Payload for the detect-lifecycle audit rows
 * (account_detect_completed / _failed / _dead_letter). Less granular than
 * the field-update payload — these record the scan outcome rather than
 * per-field changes. Per-field detection acceptance generates separate
 * `account_field_updated` rows downstream.
 *
 * `entityType` stays `"AccountProfile"` to keep the
 * `auditLog.getLastEntry(entityType, entityId, fieldPath?)` query shape
 * uniform across both action types.
 */
export const AccountDetectLifecycleAuditPayloadSchema = z.object({
  entityType: z.literal("AccountProfile"),
  entityId: z.string().min(1),
  jobId: z.string().min(1),
  websiteUrl: z.string().min(1),
  /** Set on completion/failure outcomes; absent in `started` (which Cohort 6 doesn't audit). */
  proposalCount: z.number().int().nonnegative().nullable().optional(),
  /** Set on failure / dead_letter. */
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  /** Cloud Tasks attempt number when the scan finally died. Set on dead_letter. */
  retryCount: z.number().int().positive().nullable().optional(),
});
export type AccountDetectLifecycleAuditPayload = z.infer<
  typeof AccountDetectLifecycleAuditPayloadSchema
>;

/** Union of the two payload shapes — useful for the KAN-830 consumer's
 * type-narrow on `actionType`. */
export type AccountAuditLogPayload =
  | AccountFieldUpdatedAuditPayload
  | AccountDetectLifecycleAuditPayload;

/**
 * Helper for the `account.field_updated` subscriber. Parses + builds the
 * payload from the wire-format event + the AccountProfile row id (which
 * the subscriber looks up from `tenantId`).
 */
export function buildAccountFieldUpdatedAuditPayload(input: {
  accountProfileId: string;
  fieldPath: string;
  oldValue: string | null;
  newValue: string | null;
  source: "human" | "ai_detection";
  userId: string | null;
  detectionId: string | null;
}): AccountFieldUpdatedAuditPayload {
  return AccountFieldUpdatedAuditPayloadSchema.parse({
    entityType: "AccountProfile",
    entityId: input.accountProfileId,
    fieldPath: input.fieldPath,
    oldValue: input.oldValue,
    newValue: input.newValue,
    source: input.source,
    userId: input.userId,
    detectionId: input.detectionId,
  });
}

/**
 * Helper for the detect-from-website handler. Builds the lifecycle audit
 * payload at the point of detect_completed / _failed / _dead_letter
 * publication.
 */
export function buildAccountDetectLifecycleAuditPayload(input: {
  accountProfileId: string;
  jobId: string;
  websiteUrl: string;
  proposalCount?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryCount?: number | null;
}): AccountDetectLifecycleAuditPayload {
  return AccountDetectLifecycleAuditPayloadSchema.parse({
    entityType: "AccountProfile",
    entityId: input.accountProfileId,
    jobId: input.jobId,
    websiteUrl: input.websiteUrl,
    proposalCount: input.proposalCount ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    retryCount: input.retryCount ?? null,
  });
}
