/**
 * KAN-852 — Account Page Cohort 1 publisher (pure module).
 *
 * Publishes `account.field_updated` Pub/Sub events from every successful
 * accountRouter update mutation. Mirrors knowledge-source-ingest-publisher.ts
 * (small, fire-and-forget, idempotency enforced downstream) plus a feature
 * flag so Cohort 1 ships pure code/schema with zero infra coupling.
 *
 * Cohort 6 ownership:
 *   - Terraform topic creation (`account.field_updated`)
 *   - Push subscription pointing at the AuditLog write subscriber
 *   - Flip ACCOUNT_EVENTS_ENABLED=true in the Cloud Run service config
 *
 * Until then this module is a no-op at runtime — the publisher function
 * returns `{ skipped: true }` so callers can still observe the call site
 * for telemetry without paying any Pub/Sub cost or risking 404s on a
 * non-existent topic.
 */
import {
  ACCOUNT_FIELD_UPDATED_TOPIC,
  type AccountFieldUpdatedEvent,
} from "@growth/shared";
import { getPubSubClient } from "../lib/pubsub-client.js";

export interface PublishResult {
  /** Pub/Sub-assigned message id. Absent when skipped=true. */
  messageId?: string;
  /** True when the env flag gates the publish and no message was sent. */
  skipped: boolean;
}

/**
 * Returns true when the runtime is configured to publish account.* events.
 * Defaults to false in every environment; Cohort 6 flips this on in PROD
 * after the topic + subscriber are wired. Unit tests toggle the env var
 * directly to exercise both code paths.
 */
export function accountEventsEnabled(): boolean {
  return process.env.ACCOUNT_EVENTS_ENABLED === "true";
}

export async function publishAccountFieldUpdated(
  event: AccountFieldUpdatedEvent,
): Promise<PublishResult> {
  if (!accountEventsEnabled()) {
    return { skipped: true };
  }
  // KAN-876: must call the wrapper's `.publish(topic, data, attributes)`
  // method — NOT the raw `@google-cloud/pubsub` `.topic(name).publishMessage()`
  // shape. `getPubSubClient()` returns the PubSubClient interface (declared
  // in `services/action-decided-publisher.ts`), whose only public method is
  // `publish()`. Before this fix, the publisher silently failed with a
  // TypeError (`client.topic is not a function`) on every save, swallowed
  // by the `.catch(() => {})` wrapper at the router call site. Live since
  // KAN-852 deploy; only surfaced when ACCOUNT_EVENTS_ENABLED flipped at
  // KAN-866 close-out and Cowork drove an authed save end-to-end.
  //
  // KAN-877 follow-up: `knowledge-source-ingest-publisher.ts` ships the
  // same bug shape (same wrong client API). Verify + fix separately.
  const client = getPubSubClient();
  const data = Buffer.from(JSON.stringify(event));
  const attributes: Record<string, string> = {
    eventType: event.eventType,
    tenantId: event.tenantId,
    fieldPath: event.fieldPath,
    source: event.source,
  };
  const messageId = await client.publish(
    ACCOUNT_FIELD_UPDATED_TOPIC,
    data,
    attributes,
  );
  return { messageId, skipped: false };
}
