/**
 * KAN-913 — Ingestion Cohort 2.7. `import.row_committed` Pub/Sub event.
 *
 * Published by `runCommit` (packages/api/src/services/import-commit.ts)
 * after each successful per-row $transaction commit. One event per
 * committed row — downstream consumers (Brain, lead-router, etc.) can
 * filter on the `entityType` attribute to subscribe per-entity without
 * needing 4 separate topics.
 *
 * Single fan-out topic per the Phase 1 decision: simpler infra,
 * downstream routing happens at the subscription filter (gcloud
 * `--message-filter='attributes.entityType="contact"'`). If volume
 * warrants per-entity split later, file a follow-up — the topic name
 * + payload shape stay stable, the subscription rewires.
 *
 * Naming convention: `<noun>.<verb_past>` — matches `lead.received`
 * (KAN-741), `knowledge.source_ingested` (KAN-827), and
 * `account.field_updated` (KAN-852).
 *
 * Env-flag gating (KAN-852 pattern): the publisher is hard-gated
 * behind `IMPORT_EVENTS_ENABLED` (default false) so this PR ships
 * pure code/schema with zero infra coupling. The topic + push
 * subscription land in a follow-up Terraform ticket; flip the flag
 * to `true` in the Cloud Run service config once wired.
 */
import { z } from "zod";

// ─────────────────────────────────────────────
// Entity-type taxonomy — which canonical table got the write
// ─────────────────────────────────────────────

/** One of the 4 Cohort 2 entity targets. Mirrors `DedupEntityType` on
 *  the staging side. */
export const ImportEntityTypeEnum = z.enum([
  "contact",
  "company",
  "deal",
  "order",
]);
export type ImportEntityType = z.infer<typeof ImportEntityTypeEnum>;

// ─────────────────────────────────────────────
// Action taxonomy — what runCommit did to the canonical row
// ─────────────────────────────────────────────

/** `inserted` — new canonical row written from staging.sourceRowData.
 *  `updated`  — existing canonical row updated (honoring KAN-911
 *               matchDecision.userChoice.chosenCandidateId). */
export const ImportCommitActionEnum = z.enum(["inserted", "updated"]);
export type ImportCommitAction = z.infer<typeof ImportCommitActionEnum>;

// ─────────────────────────────────────────────
// Event payload schema
// ─────────────────────────────────────────────

/**
 * `import.row_committed` event payload. Emitted once per row that
 * survives the runCommit per-row $transaction (canonical write +
 * staging status update + audit log entry). Skipped rows and rows
 * that landed in commitErrors do NOT emit events — only successful
 * commits.
 *
 * `entityId` is the canonical entity id (Contact / Company / Deal /
 * Order). Consumers join this back to the canonical tables via
 * (tenantId, entityId).
 *
 * `stagingRowId` and `sourceRowIndex` are kept for forensic linkage
 * back to the originating staging row.
 */
export const ImportRowCommittedEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal("import.row_committed"),
  version: z.literal("1.0"),
  publishedAt: z.string().datetime(),
  tenantId: z.string().uuid(),
  importJobId: z.string().min(1),
  entityType: ImportEntityTypeEnum,
  entityId: z.string().min(1),
  action: ImportCommitActionEnum,
  stagingRowId: z.string().min(1),
  sourceRowIndex: z.number().int().nonnegative(),
  /** Attribution. Mirrors AuditLog.actor — `user:<id>` or `system`. */
  actor: z.string().min(1),
  committedAt: z.string().datetime(),
});
export type ImportRowCommittedEvent = z.infer<
  typeof ImportRowCommittedEventSchema
>;

/**
 * Builder — keeps eventType + version literals in lockstep across all
 * call sites. Producers MUST call this rather than constructing the
 * object inline; mirrors `buildAccountFieldUpdatedEvent` (KAN-852).
 */
export function buildImportRowCommittedEvent(input: {
  eventId: string;
  tenantId: string;
  importJobId: string;
  entityType: ImportEntityType;
  entityId: string;
  action: ImportCommitAction;
  stagingRowId: string;
  sourceRowIndex: number;
  actor: string;
  committedAt: string;
}): ImportRowCommittedEvent {
  return ImportRowCommittedEventSchema.parse({
    eventId: input.eventId,
    eventType: "import.row_committed",
    version: "1.0",
    publishedAt: new Date().toISOString(),
    tenantId: input.tenantId,
    importJobId: input.importJobId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    stagingRowId: input.stagingRowId,
    sourceRowIndex: input.sourceRowIndex,
    actor: input.actor,
    committedAt: input.committedAt,
  });
}

// ─────────────────────────────────────────────
// Topic name (single source of truth)
// ─────────────────────────────────────────────

/**
 * Pub/Sub topic name for the `import.row_committed` event. Follow-up
 * ticket owns the Terraform topic creation + per-entity push
 * subscriptions; the publisher in this cohort hard-gates the actual
 * publish call behind `IMPORT_EVENTS_ENABLED` (default false) so the
 * absence of the topic in PROD doesn't surface as 404s.
 */
export const IMPORT_ROW_COMMITTED_TOPIC = "import.row_committed";
