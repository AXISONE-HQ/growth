/**
 * KAN-827 — Knowledge source-ingested publisher (pure module).
 *
 * Publishes `knowledge.source_ingested` Pub/Sub events when an admin
 * intake (PDF / paste_text / FAQ Q&A) writes a knowledge_source row with
 * status='queued'. The push subscriber at apps/api/src/subscribers/
 * knowledge-source-ingested-push.ts consumes these and runs the chunking +
 * embedding pipeline.
 *
 * Mirrors the action-decided-publisher.ts pattern (small, fire-and-forget,
 * idempotency enforced downstream by the per-tenant fileChecksum unique key
 * on knowledge_source). Unprefixed topic name per KAN-655 / KAN-661 convention.
 */
import {
  KNOWLEDGE_SOURCE_INGESTED_TOPIC,
  type KnowledgeSourceIngestedEvent,
} from "@growth/shared";
import { getPubSubClient } from "../lib/pubsub-client.js";

export async function publishKnowledgeSourceIngested(
  event: KnowledgeSourceIngestedEvent,
): Promise<{ messageId: string }> {
  const client = getPubSubClient();
  const data = Buffer.from(JSON.stringify(event));
  const attributes: Record<string, string> = {
    eventType: event.eventType,
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    sourceType: event.sourceType,
  };
  const messageId = await client
    .topic(KNOWLEDGE_SOURCE_INGESTED_TOPIC)
    .publishMessage({ data, attributes });
  return { messageId };
}
