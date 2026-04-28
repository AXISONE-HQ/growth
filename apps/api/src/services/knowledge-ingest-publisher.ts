/**
 * KAN-707 PR A — Knowledge ingestion publisher.
 *
 * Thin publisher for the `knowledge.ingest.requested` topic. Mirrors the
 * `action-decided-publisher.ts` shape but stays small — no event-history
 * table, no idempotency dedup at the publisher level (the worker enforces
 * idempotency via the (tenantId, contentHash) unique constraint on
 * KnowledgeSource per KAN-706 PR #55).
 *
 * Topic name is unprefixed (matches the actual topic name in GCP per
 * KAN-655 / KAN-661 unprefixed convention for new topics).
 */
import { getPubSubClient } from "../../../../packages/api/src/lib/pubsub-client.js";
import type { IngestRequestedEvent } from "@growth/shared";

export const KNOWLEDGE_INGEST_REQUESTED_TOPIC = "knowledge.ingest.requested";

export async function publishIngestRequested(
  event: IngestRequestedEvent,
): Promise<{ messageId: string }> {
  const client = getPubSubClient();
  const data = Buffer.from(JSON.stringify(event));
  const attributes: Record<string, string> = {
    eventType: event.eventType,
    tenantId: event.tenantId,
    ingestionId: event.ingestionId,
    path: event.path,
    version: event.version,
  };
  const messageId = await client.publish(
    KNOWLEDGE_INGEST_REQUESTED_TOPIC,
    data,
    attributes,
  );
  return { messageId };
}
