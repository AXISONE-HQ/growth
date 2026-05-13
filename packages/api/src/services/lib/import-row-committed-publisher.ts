/**
 * KAN-913 — `import.row_committed` Pub/Sub publisher.
 *
 * Template: account-field-updated-publisher.ts (KAN-852, post-KAN-876
 * fix). Small, fire-and-forget, env-flag gated so this Cohort 2.7 PR
 * ships pure code/schema with zero infra coupling.
 *
 * DO NOT model this on knowledge-source-ingest-publisher.ts — that
 * module (KAN-877) uses the raw `client.topic(name).publishMessage()`
 * shape which silently fails on the wrapper interface.
 *
 * Wiring follow-up:
 *   - Terraform: create the `import.row_committed` topic
 *   - Push subscription(s): per-entity filter on attributes.entityType
 *   - Flip IMPORT_EVENTS_ENABLED=true in the Cloud Run service config
 *
 * Until then this module is a no-op at runtime — `publishImportRowCommitted`
 * returns `{ skipped: true }` so call sites still exercise the producer
 * path without paying any Pub/Sub cost or risking 404s.
 *
 * Call discipline (import-commit.ts orchestrator):
 *   - Publish AFTER the per-row $transaction commits (event guarantees
 *     the canonical row exists; in-tx publish would risk leaking events
 *     for rolled-back rows).
 *   - Wrap in `.catch()` at the call site — at-least-once semantics +
 *     fire-and-forget; an event failure should NOT roll back the commit.
 */
import {
  IMPORT_ROW_COMMITTED_TOPIC,
  type ImportRowCommittedEvent,
} from "@growth/shared";
import { getPubSubClient } from "../../lib/pubsub-client.js";

export interface PublishResult {
  /** Pub/Sub-assigned message id. Absent when skipped=true. */
  messageId?: string;
  /** True when the env flag gates the publish and no message was sent. */
  skipped: boolean;
}

/**
 * Returns true when the runtime is configured to publish
 * `import.row_committed` events. Defaults to false in every environment;
 * a follow-up ticket flips this on in PROD after the topic + subscriber
 * are wired. Unit tests toggle the env var directly to exercise both
 * code paths.
 */
export function importEventsEnabled(): boolean {
  return process.env.IMPORT_EVENTS_ENABLED === "true";
}

export async function publishImportRowCommitted(
  event: ImportRowCommittedEvent,
): Promise<PublishResult> {
  if (!importEventsEnabled()) {
    return { skipped: true };
  }
  // KAN-876: call the wrapper's `.publish(topic, data, attributes)` —
  // NOT the raw `@google-cloud/pubsub` `.topic(name).publishMessage()`
  // shape. `getPubSubClient()` returns the PubSubClient interface
  // (declared in services/action-decided-publisher.ts), whose only
  // public method is `publish()`.
  const client = getPubSubClient();
  const data = Buffer.from(JSON.stringify(event));
  // Attribute set is what downstream subscription filters key on —
  // `attributes.entityType="contact"` etc. lets the Brain subscribe
  // per-entity without per-event JSON.parse on the broker side.
  const attributes: Record<string, string> = {
    eventType: event.eventType,
    tenantId: event.tenantId,
    entityType: event.entityType,
    action: event.action,
    importJobId: event.importJobId,
  };
  const messageId = await client.publish(
    IMPORT_ROW_COMMITTED_TOPIC,
    data,
    attributes,
  );
  return { messageId, skipped: false };
}
