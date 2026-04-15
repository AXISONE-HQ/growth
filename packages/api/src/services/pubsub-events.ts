/**
 * Pub/Sub Event Publisher Service
 * KAN-24: Publish contact.ingested events after successful ingestion
 *
 * Subtasks:
 *   KAN-118 — Define contact.ingested event schema
 *   KAN-119 — Publish event after successful ingestion
 *   KAN-120 — Add event logging to audit trail
 *
 * This module provides the event publishing layer for the growth core loop.
 * All inter-service communication flows through Pub/Sub topics.
 *
 * Topics:
 *   contact.ingested  — Fired after contact create/update/resolve with quality score
 *   contact.merged    — Fired after identity resolution merge
 *   contact.scored    — Fired after data quality score update
 *
 * Integration points:
 *   - contacts.ts router calls publishContactIngested after create/update
 *   - identity-resolver.ts calls publishContactMerged after merge
 *   - data-quality.ts calls publishContactScored after scoring
 */

import { PubSub, Topic } from '@google-cloud/pubsub';
import { PrismaClient } from '@prisma/client';

// —— PubSub Client ————————————————————————————————————

const pubsub = new PubSub({
  projectId: process.env.GCP_PROJECT_ID || 'growth-493400',
});

const prisma = new PrismaClient();

// —— Topic Names (KAN-118: Event Schema Definition) ————————

const TOPICS = {
  CONTACT_INGESTED: 'contact.ingested',
  CONTACT_MERGED: 'contact.merged',
  CONTACT_SCORED: 'contact.scored',
} as const;

// —— Event Schema Types (KAN-118) ——————————————————————

/**
 * Base event envelope — all events follow this structure.
 * Consistent schema enables generic subscriber handling.
 */
interface BaseEvent {
  /** Unique event ID (UUID v4) */
  eventId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type — matches topic name */
  eventType: string;
  /** Event schema version for backward compatibility */
  version: '1.0';
  /** Tenant context — always present for multi-tenancy */
  tenantId: string;
  /** Source service that published the event */
  source: string;
}

/**
 * contact.ingested event payload.
 * Published after a contact is created, updated, or resolved via identity resolution.
 * Subscribers: Brain Service (context update), Analytics Pipeline (tracking).
 */
export interface ContactIngestedEvent extends BaseEvent {
  eventType: 'contact.ingested';
  data: {
    contactId: string;
    /** How was this contact ingested? */
    action: 'created' | 'updated' | 'resolved' | 'enriched';
    /** Normalized contact data snapshot at time of ingestion */
    normalizedData: {
      email: string | null;
      phone: string | null;
      firstName: string | null;
      lastName: string | null;
      segment: string | null;
      lifecycleStage: string;
      source: string | null;
      externalIds: Record<string, string>;
    };
    /** Data quality score at time of ingestion */
    dataQualityScore: number;
    /** Quality gate result */
    qualityGate: {
      action: 'proceed' | 'flag' | 'block';
      threshold: number;
    };
    /** Ingestion source for analytics */
    ingestionSource: string;
    /** Fields that changed (for updates/enrichment) */
    changedFields?: string[];
  };
}

/**
 * contact.merged event payload.
 * Published after identity resolution merges two contacts.
 * Subscribers: Brain Service (consolidate context), Analytics Pipeline.
 */
export interface ContactMergedEvent extends BaseEvent {
  eventType: 'contact.merged';
  data: {
    /** The surviving contact */
    primaryContactId: string;
    /** The archived contact */
    secondaryContactId: string;
    /** Fields that were transferred or overridden */
    mergedFields: string[];
    /** Relations transferred count */
    relationsTransferred: {
      contactStates: number;
      decisions: number;
      outcomes: number;
      actions: number;
      conversations: number;
    };
  };
}

/**
 * contact.scored event payload.
 * Published after data quality score is recalculated.
 * Subscribers: Brain Service (score context), Decision Engine (gate check).
 */
export interface ContactScoredEvent extends BaseEvent {
  eventType: 'contact.scored';
  data: {
    contactId: string;
    previousScore: number;
    newScore: number;
    qualityGate: {
      action: 'proceed' | 'flag' | 'block';
      threshold: number;
    };
    /** Top suggestions for score improvement */
    topSuggestions: string[];
  };
}

type PubSubEvent = ContactIngestedEvent | ContactMergedEvent | ContactScoredEvent;

// —— Topic Cache ———————————————————————————————————————

const topicCache: Map<string, Topic> = new Map();

async function getOrCreateTopic(topicName: string): Promise<Topic> {
  if (topicCache.has(topicName)) {
    return topicCache.get(topicName)!;
  }

  const topic = pubsub.topic(topicName);

  // Check if topic exists, create if not
  const [exists] = await topic.exists();
  if (!exists) {
    await topic.create();
    console.log(`Created Pub/Sub topic: ${topicName}`);
  }

  topicCache.set(topicName, topic);
  return topic;
}

// —— Core Publish Function —————————————————————————————

/**
 * Publish an event to the appropriate Pub/Sub topic.
 * Includes retry logic and audit trail logging (KAN-120).
 */
async function publishEvent(event: PubSubEvent): Promise<string> {
  const topic = await getOrCreateTopic(event.eventType);

  const messageBuffer = Buffer.from(JSON.stringify(event));

  // Pub/Sub attributes for filtering without deserialization
  const attributes: Record<string, string> = {
    eventType: event.eventType,
    tenantId: event.tenantId,
    version: event.version,
    source: event.source,
  };

  try {
    const messageId = await topic.publishMessage({
      data: messageBuffer,
      attributes,
    });

    // KAN-120: Audit trail logging
    await logEventToAudit(event, messageId);

    console.log(
      `Published ${event.eventType} event: ${event.eventId} (messageId: ${messageId})`
    );

    return messageId;
  } catch (error: any) {
    console.error(
      `Failed to publish ${event.eventType} event ${event.eventId}:`,
      error
    );

    // Log failure to audit trail
    await logEventToAudit(event, null, error.message);

    throw error;
  }
}

// —— KAN-120: Audit Trail Logging ——————————————————————

async function logEventToAudit(
  event: PubSubEvent,
  messageId: string | null,
  errorMessage?: string
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: event.tenantId,
        actor: 'system',
        actionType: `pubsub.${event.eventType}`,
        payload: {
          eventId: event.eventId,
          eventType: event.eventType,
          messageId,
          status: errorMessage ? 'failed' : 'published',
          ...(errorMessage && { error: errorMessage }),
          // Include key identifiers but not full payload (audit log storage)
          ...(event.eventType === 'contact.ingested' && {
            contactId: (event as ContactIngestedEvent).data.contactId,
            action: (event as ContactIngestedEvent).data.action,
            dataQualityScore: (event as ContactIngestedEvent).data.dataQualityScore,
          }),
          ...(event.eventType === 'contact.merged' && {
            primaryContactId: (event as ContactMergedEvent).data.primaryContactId,
            secondaryContactId: (event as ContactMergedEvent).data.secondaryContactId,
          }),
          ...(event.eventType === 'contact.scored' && {
            contactId: (event as ContactScoredEvent).data.contactId,
            previousScore: (event as ContactScoredEvent).data.previousScore,
            newScore: (event as ContactScoredEvent).data.newScore,
          }),
        },
        reasoning: errorMessage
          ? `Pub/Sub publish failed: ${errorMessage}`
          : `Published ${event.eventType} event`,
      },
    });
  } catch (auditError) {
    // Never let audit logging failure block the main flow
    console.error('Audit log write failed (non-blocking):', auditError);
  }
}

// —— KAN-119: Publisher Functions ——————————————————————

/**
 * Publish a contact.ingested event.
 * Called by contacts.ts (create/update), identity-resolver.ts (resolve),
 * and ingestion pipeline after successful normalization.
 */
export async function publishContactIngested(params: {
  tenantId: string;
  contactId: string;
  action: 'created' | 'updated' | 'resolved' | 'enriched';
  normalizedData: ContactIngestedEvent['data']['normalizedData'];
  dataQualityScore: number;
  qualityGate: ContactIngestedEvent['data']['qualityGate'];
  ingestionSource: string;
  changedFields?: string[];
}): Promise<string> {
  const event: ContactIngestedEvent = {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    eventType: 'contact.ingested',
    version: '1.0',
    tenantId: params.tenantId,
    source: 'ingestion-service',
    data: {
      contactId: params.contactId,
      action: params.action,
      normalizedData: params.normalizedData,
      dataQualityScore: params.dataQualityScore,
      qualityGate: params.qualityGate,
      ingestionSource: params.ingestionSource,
      changedFields: params.changedFields,
    },
  };

  return publishEvent(event);
}

/**
 * Publish a contact.merged event.
 * Called by identity-resolver.ts after successful merge.
 */
export async function publishContactMerged(params: {
  tenantId: string;
  primaryContactId: string;
  secondaryContactId: string;
  mergedFields: string[];
  relationsTransferred: ContactMergedEvent['data']['relationsTransferred'];
}): Promise<string> {
  const event: ContactMergedEvent = {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    eventType: 'contact.merged',
    version: '1.0',
    tenantId: params.tenantId,
    source: 'ingestion-service',
    data: {
      primaryContactId: params.primaryContactId,
      secondaryContactId: params.secondaryContactId,
      mergedFields: params.mergedFields,
      relationsTransferred: params.relationsTransferred,
    },
  };

  return publishEvent(event);
}

/**
 * Publish a contact.scored event.
 * Called by data-quality.ts after score recalculation.
 */
export async function publishContactScored(params: {
  tenantId: string;
  contactId: string;
  previousScore: number;
  newScore: number;
  qualityGate: ContactScoredEvent['data']['qualityGate'];
  topSuggestions: string[];
}): Promise<string> {
  const event: ContactScoredEvent = {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    eventType: 'contact.scored',
    version: '1.0',
    tenantId: params.tenantId,
    source: 'ingestion-service',
    data: {
      contactId: params.contactId,
      previousScore: params.previousScore,
      newScore: params.newScore,
      qualityGate: params.qualityGate,
      topSuggestions: params.topSuggestions,
    },
  };

  return publishEvent(event);
}

// —— Topic Initialization ——————————————————————————————

/**
 * Initialize all Pub/Sub topics at service startup.
 * Call this from the main server bootstrap.
 */
export async function initializePubSubTopics(): Promise<void> {
  console.log('Initializing Pub/Sub topics...');

  for (const topicName of Object.values(TOPICS)) {
    await getOrCreateTopic(topicName);
  }

  console.log(
    `Pub/Sub topics ready: ${Object.values(TOPICS).join(', ')}`
  );
}

// —— Health Check ——————————————————————————————————————

/**
 * Check Pub/Sub connectivity. Used by health check endpoint.
 */
export async function checkPubSubHealth(): Promise<{
  healthy: boolean;
  topics: { name: string; exists: boolean }[];
}> {
  const results: { name: string; exists: boolean }[] = [];

  for (const topicName of Object.values(TOPICS)) {
    try {
      const topic = pubsub.topic(topicName);
      const [exists] = await topic.exists();
      results.push({ name: topicName, exists });
    } catch {
      results.push({ name: topicName, exists: false });
    }
  }

  return {
    healthy: results.every((r) => r.exists),
    topics: results,
  };
}

// —— Exports ——————————————————————————————————————————

export { TOPICS };
export type { BaseEvent, PubSubEvent };
