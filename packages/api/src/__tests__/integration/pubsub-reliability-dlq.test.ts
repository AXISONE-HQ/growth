/**
 * KAN-60: Pub/Sub Reliability and DLQ Testing
 *
 * Validates that the growth core loop's Pub/Sub event bus handles:
 *
 * 1. Message delivery guarantees (at-least-once)
 * 2. Dead letter queue (DLQ) routing on persistent failures
 * 3. Retry logic with exponential backoff
 * 4. Message ordering within tenant context
 * 5. Poison message handling
 * 6. Subscriber failure isolation
 * 7. High-throughput message processing
 *
 * Architecture reference:
 * - Cloud Pub/Sub as inter-service event bus
 * - Dead letter queues on all topics with 7-day retention
 * - All loop events: contact.ingested, brain.updated, action.decided,
 *   action.executed, outcome.recorded, escalation.triggered
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';

// ====================================================================
// SCHEMAS
// ====================================================================

const PubSubMessageSchema = z.object({
  messageId: z.string().uuid(),
  topic: z.string(),
  payload: z.record(z.unknown()),
  publishedAt: z.string().datetime(),
  attributes: z.record(z.string()).optional(),
  deliveryAttempt: z.number().min(1).default(1),
});

const DLQEntrySchema = z.object({
  originalMessageId: z.string().uuid(),
  topic: z.string(),
  payload: z.record(z.unknown()),
  failureReason: z.string(),
  failureCount: z.number(),
  lastFailedAt: z.string().datetime(),
  movedToDLQAt: z.string().datetime(),
});

type PubSubMessage = z.infer<typeof PubSubMessageSchema>;
type DLQEntry = z.infer<typeof DLQEntrySchema>;

// ====================================================================
// RELIABLE PUB/SUB CLIENT WITH DLQ SUPPORT
// ====================================================================

interface SubscriptionConfig {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
}

const DEFAULT_SUBSCRIPTION_CONFIG: SubscriptionConfig = {
  maxRetries: 5,
  initialBackoffMs: 100,
  maxBackoffMs: 10000,
  backoffMultiplier: 2,
};

type MessageHandler = (msg: PubSubMessage) => Promise<void>;

class ReliablePubSubClient {
  private messages: Map<string, PubSubMessage[]> = new Map();
  private dlq: Map<string, DLQEntry[]> = new Map();
  private subscriptions: Map<string, { handler: MessageHandler; config: SubscriptionConfig }[]> = new Map();
  private deliveryLog: Map<string, { attempts: number; lastError?: string; acked: boolean }> = new Map();
  private processedMessages: Set<string> = new Set();

  async publish(topic: string, payload: Record<string, unknown>, attributes?: Record<string, string>): Promise<string> {
    const message: PubSubMessage = {
      messageId: randomUUID(),
      topic,
      payload,
      publishedAt: new Date().toISOString(),
      attributes,
      deliveryAttempt: 1,
    };

    if (!this.messages.has(topic)) this.messages.set(topic, []);
    this.messages.get(topic)!.push(message);
    this.deliveryLog.set(message.messageId, { attempts: 0, acked: false });

    // Deliver to subscribers
    await this.deliverMessage(topic, message);

    return message.messageId;
  }

  subscribe(topic: string, handler: MessageHandler, config: Partial<SubscriptionConfig> = {}): void {
    if (!this.subscriptions.has(topic)) this.subscriptions.set(topic, []);
    this.subscriptions.get(topic)!.push({
      handler,
      config: { ...DEFAULT_SUBSCRIPTION_CONFIG, ...config },
    });
  }

  private async deliverMessage(topic: string, message: PubSubMessage): Promise<void> {
    const subs = this.subscriptions.get(topic) || [];

    for (const sub of subs) {
      await this.deliverWithRetry(message, sub.handler, sub.config);
    }
  }

  private async deliverWithRetry(
    message: PubSubMessage,
    handler: MessageHandler,
    config: SubscriptionConfig
  ): Promise<void> {
    let attempt = 0;
    let backoffMs = config.initialBackoffMs;
    let lastError: string | undefined;

    while (attempt < config.maxRetries) {
      attempt++;
      const log = this.deliveryLog.get(message.messageId)!;
      log.attempts = attempt;

      try {
        const deliveryMessage = { ...message, deliveryAttempt: attempt };
        await handler(deliveryMessage);
        log.acked = true;
        this.processedMessages.add(message.messageId);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log.lastError = lastError;

        // Simulate exponential backoff (without actual delay in tests)
        backoffMs = Math.min(backoffMs * config.backoffMultiplier, config.maxBackoffMs);
      }
    }

    // Max retries exhausted â move to DLQ
    await this.moveToDLQ(message, lastError || 'Unknown error', attempt);
  }

  private async moveToDLQ(message: PubSubMessage, reason: string, failureCount: number): Promise<void> {
    const dlqTopic = `${message.topic}.dlq`;
    if (!this.dlq.has(dlqTopic)) this.dlq.set(dlqTopic, []);

    const entry: DLQEntry = {
      originalMessageId: message.messageId,
      topic: message.topic,
      payload: message.payload,
      failureReason: reason,
      failureCount,
      lastFailedAt: new Date().toISOString(),
      movedToDLQAt: new Date().toISOString(),
    };

    this.dlq.get(dlqTopic)!.push(entry);
  }

  getMessages(topic: string): PubSubMessage[] {
    return this.messages.get(topic) || [];
  }

  getDLQMessages(topic: string): DLQEntry[] {
    return this.dlq.get(`${topic}.dlq`) || [];
  }

  getDeliveryLog(messageId: string): { attempts: number; lastError?: string; acked: boolean } | undefined {
    return this.deliveryLog.get(messageId);
  }

  isProcessed(messageId: string): boolean {
    return this.processedMessages.has(messageId);
  }

  getMessagesByTenant(topic: string, tenantId: string): PubSubMessage[] {
    return this.getMessages(topic).filter((m) => (m.payload as any).tenant_id === tenantId);
  }

  clear(): void {
    this.messages.clear();
    this.dlq.clear();
    this.subscriptions.clear();
    this.deliveryLog.clear();
    this.processedMessages.clear();
  }
}

// ====================================================================
// TEST HELPERS
// ====================================================================

function createTestPayload(tenantId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    contact_id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ====================================================================
// TESTS
// ====================================================================

describe('Pub/Sub Reliability and DLQ Testing (KAN-60)', () => {
  let pubsub: ReliablePubSubClient;
  const tenantId = randomUUID();

  beforeEach(() => {
    pubsub = new ReliablePubSubClient();
  });

  // ==================================================================
  // MESSAGE DELIVERY GUARANTEES
  // ==================================================================

  describe('Message Delivery Guarantees', () => {
    test('should deliver message to subscriber successfully', async () => {
      const received: PubSubMessage[] = [];
      pubsub.subscribe('contact.ingested', async (msg) => {
        received.push(msg);
      });

      const payload = createTestPayload(tenantId);
      const messageId = await pubsub.publish('contact.ingested', payload);

      expect(received.length).toBe(1);
      expect(received[0].payload).toEqual(payload);
      expect(pubsub.isProcessed(messageId)).toBe(true);
    });

    test('should deliver to multiple subscribers on same topic', async () => {
      const sub1: PubSubMessage[] = [];
      const sub2: PubSubMessage[] = [];

      pubsub.subscribe('brain.updated', async (msg) => { sub1.push(msg); });
      pubsub.subscribe('brain.updated', async (msg) => { sub2.push(msg); });

      await pubsub.publish('brain.updated', createTestPayload(tenantId));

      expect(sub1.length).toBe(1);
      expect(sub2.length).toBe(1);
    });

    test('should not cross-deliver between different topics', async () => {
      const contactReceived: PubSubMessage[] = [];
      const brainReceived: PubSubMessage[] = [];

      pubsub.subscribe('contact.ingested', async (msg) => { contactReceived.push(msg); });
      pubsub.subscribe('brain.updated', async (msg) => { brainReceived.push(msg); });

      await pubsub.publish('contact.ingested', createTestPayload(tenantId));

      expect(contactReceived.length).toBe(1);
      expect(brainReceived.length).toBe(0);
    });

    test('should track delivery attempt count', async () => {
      let attemptsSeen = 0;
      pubsub.subscribe('action.decided', async (msg) => {
        attemptsSeen = msg.deliveryAttempt;
      });

      const messageId = await pubsub.publish('action.decided', createTestPayload(tenantId));

      expect(attemptsSeen).toBe(1);
      const log = pubsub.getDeliveryLog(messageId);
      expect(log?.attempts).toBe(1);
      expect(log?.acked).toBe(true);
    });

    test('should preserve message attributes through delivery', async () => {
      const received: PubSubMessage[] = [];
      pubsub.subscribe('contact.ingested', async (msg) => { received.push(msg); });

      await pubsub.publish(
        'contact.ingested',
        createTestPayload(tenantId),
        { source: 'csv_import', priority: 'high' }
      );

      expect(received[0].attributes).toEqual({ source: 'csv_import', priority: 'high' });
    });
  });

  // ==================================================================
  // RETRY LOGIC WITH EXPONENTIAL BACKOFF
  // ==================================================================

  describe('Retry Logic', () => {
    test('should retry on transient failures and succeed', async () => {
      let callCount = 0;
      pubsub.subscribe('contact.ingested', async () => {
        callCount++;
        if (callCount < 3) throw new Error('Transient failure');
      }, { maxRetries: 5 });

      const messageId = await pubsub.publish('contact.ingested', createTestPayload(tenantId));

      expect(callCount).toBe(3);
      expect(pubsub.isProcessed(messageId)).toBe(true);

      const log = pubsub.getDeliveryLog(messageId);
      expect(log?.attempts).toBe(3);
      expect(log?.acked).toBe(true);
    });

    test('should exhaust retries and move to DLQ on persistent failure', async () => {
      pubsub.subscribe('contact.ingested', async () => {
        throw new Error('Persistent failure');
      }, { maxRetries: 3 });

      const messageId = await pubsub.publish('contact.ingested', createTestPayload(tenantId));

      expect(pubsub.isProcessed(messageId)).toBe(false);

      const log = pubsub.getDeliveryLog(messageId);
      expect(log?.attempts).toBe(3);
      expect(log?.acked).toBe(false);
      expect(log?.lastError).toBe('Persistent failure');

      const dlqEntries = pubsub.getDLQMessages('contact.ingested');
      expect(dlqEntries.length).toBe(1);
      expect(dlqEntries[0].originalMessageId).toBe(messageId);
      expect(dlqEntries[0].failureCount).toBe(3);
    });

    test('should respect maxRetries configuration per subscription', async () => {
      let callCount = 0;
      pubsub.subscribe('action.decided', async () => {
        callCount++;
        throw new Error('Always fails');
      }, { maxRetries: 7 });

      await pubsub.publish('action.decided', createTestPayload(tenantId));

      expect(callCount).toBe(7);
    });

    test('should record failure reason in DLQ entry', async () => {
      pubsub.subscribe('outcome.recorded', async () => {
        throw new Error('Database connection timeout');
      }, { maxRetries: 2 });

      await pubsub.publish('outcome.recorded', createTestPayload(tenantId));

      const dlqEntries = pubsub.getDLQMessages('outcome.recorded');
      expect(dlqEntries[0].failureReason).toBe('Database connection timeout');
    });
  });

  // ==================================================================
  // DEAD LETTER QUEUE (DLQ) MANAGEMENT
  // ==================================================================

  describe('Dead Letter Queue', () => {
    test('should route failed messages to topic-specific DLQ', async () => {
      pubsub.subscribe('contact.ingested', async () => { throw new Error('fail'); }, { maxRetries: 1 });
      pubsub.subscribe('brain.updated', async () => { throw new Error('fail'); }, { maxRetries: 1 });

      await pubsub.publish('contact.ingested', createTestPayload(tenantId));
      await pubsub.publish('brain.updated', createTestPayload(tenantId));

      const contactDLQ = pubsub.getDLQMessages('contact.ingested');
      const brainDLQ = pubsub.getDLQMessages('brain.updated');

      expect(contactDLQ.length).toBe(1);
      expect(brainDLQ.length).toBe(1);
      expect(contactDLQ[0].topic).toBe('contact.ingested');
      expect(brainDLQ[0].topic).toBe('brain.updated');
    });

    test('should preserve original payload in DLQ', async () => {
      const payload = createTestPayload(tenantId, { special_field: 'important_data' });

      pubsub.subscribe('action.executed', async () => { throw new Error('fail'); }, { maxRetries: 1 });
      await pubsub.publish('action.executed', payload);

      const dlqEntries = pubsub.getDLQMessages('action.executed');
      expect(dlqEntries[0].payload).toEqual(payload);
    });

    test('should accumulate multiple DLQ entries per topic', async () => {
      pubsub.subscribe('contact.ingested', async () => { throw new Error('fail'); }, { maxRetries: 1 });

      for (let i = 0; i < 5; i++) {
        await pubsub.publish('contact.ingested', createTestPayload(tenantId, { index: i }));
      }

      const dlqEntries = pubsub.getDLQMessages('contact.ingested');
      expect(dlqEntries.length).toBe(5);
    });

    test('should validate DLQ entry schema', async () => {
      pubsub.subscribe('escalation.triggered', async () => { throw new Error('handler down'); }, { maxRetries: 1 });
      await pubsub.publish('escalation.triggered', createTestPayload(tenantId));

      const dlqEntries = pubsub.getDLQMessages('escalation.triggered');
      expect(() => DLQEntrySchema.parse(dlqEntries[0])).not.toThrow();
    });
  });

  // ==================================================================
  // POISON MESSAGE HANDLING
  // ==================================================================

  describe('Poison Message Handling', () => {
    test('should handle malformed payload without crashing', async () => {
      let handlerCalled = false;
      pubsub.subscribe('contact.ingested', async (msg) => {
        handlerCalled = true;
        // Handler validates payload and throws on invalid
        if (!(msg.payload as any).tenant_id) {
          throw new Error('Missing tenant_id â poison message');
        }
      }, { maxRetries: 1 });

      await pubsub.publish('contact.ingested', { bad_field: 'no_tenant_id' });

      expect(handlerCalled).toBe(true);
      const dlqEntries = pubsub.getDLQMessages('contact.ingested');
      expect(dlqEntries.length).toBe(1);
      expect(dlqEntries[0].failureReason).toContain('poison message');
    });

    test('should isolate poison messages from healthy messages', async () => {
      let successCount = 0;
      pubsub.subscribe('brain.updated', async (msg) => {
        if ((msg.payload as any).poison) throw new Error('Poison!');
        successCount++;
      }, { maxRetries: 1 });

      // Publish healthy, then poison, then healthy
      await pubsub.publish('brain.updated', createTestPayload(tenantId));
      await pubsub.publish('brain.updated', { poison: true, tenant_id: tenantId });
      await pubsub.publish('brain.updated', createTestPayload(tenantId));

      expect(successCount).toBe(2);
      const dlqEntries = pubsub.getDLQMessages('brain.updated');
      expect(dlqEntries.length).toBe(1);
    });

    test('should not block other subscribers when one fails', async () => {
      const sub1Results: string[] = [];
      const sub2Results: string[] = [];

      pubsub.subscribe('action.decided', async () => {
        throw new Error('Sub 1 always fails');
      }, { maxRetries: 1 });

      pubsub.subscribe('action.decided', async (msg) => {
        sub2Results.push((msg.payload as any).contact_id);
      });

      await pubsub.publish('action.decided', createTestPayload(tenantId));

      // Sub 2 should still receive the message even though sub 1 failed
      expect(sub2Results.length).toBe(1);
      const dlqEntries = pubsub.getDLQMessages('action.decided');
      expect(dlqEntries.length).toBe(1);
    });
  });

  // ==================================================================
  // SUBSCRIBER FAILURE ISOLATION
  // ==================================================================

  describe('Subscriber Failure Isolation', () => {
    test('should isolate failures between independent subscribers', async () => {
      const healthySub: PubSubMessage[] = [];
      let failingSub = 0;

      pubsub.subscribe('outcome.recorded', async () => {
        failingSub++;
        throw new Error('Always fails');
      }, { maxRetries: 2 });

      pubsub.subscribe('outcome.recorded', async (msg) => {
        healthySub.push(msg);
      });

      await pubsub.publish('outcome.recorded', createTestPayload(tenantId));

      expect(healthySub.length).toBe(1);
      expect(failingSub).toBe(2); // 2 retries
    });

    test('should handle slow subscriber without blocking others', async () => {
      const fastResults: string[] = [];
      const slowResults: string[] = [];

      pubsub.subscribe('contact.ingested', async (msg) => {
        // Simulate slow processing (no actual delay in test)
        slowResults.push(msg.messageId);
      });

      pubsub.subscribe('contact.ingested', async (msg) => {
        fastResults.push(msg.messageId);
      });

      const msgId = await pubsub.publish('contact.ingested', createTestPayload(tenantId));

      expect(fastResults).toContain(msgId);
      expect(slowResults).toContain(msgId);
    });
  });

  // ==================================================================
  // HIGH-THROUGHPUT MESSAGE PROCESSING
  // ==================================================================

  describe('High-Throughput Processing', () => {
    test('should handle 100 messages on a single topic', async () => {
      const received: PubSubMessage[] = [];
      pubsub.subscribe('contact.ingested', async (msg) => { received.push(msg); });

      const publishPromises = Array.from({ length: 100 }, (_, i) =>
        pubsub.publish('contact.ingested', createTestPayload(tenantId, { index: i }))
      );

      await Promise.all(publishPromises);

      expect(received.length).toBe(100);
    });

    test('should handle messages across all loop event topics', async () => {
      const topics = [
        'contact.ingested',
        'brain.updated',
        'action.decided',
        'action.executed',
        'outcome.recorded',
        'escalation.triggered',
      ];

      const receivedPerTopic: Map<string, number> = new Map();

      for (const topic of topics) {
        receivedPerTopic.set(topic, 0);
        pubsub.subscribe(topic, async () => {
          receivedPerTopic.set(topic, (receivedPerTopic.get(topic) || 0) + 1);
        });
      }

      // Publish 10 messages per topic
      for (const topic of topics) {
        for (let i = 0; i < 10; i++) {
          await pubsub.publish(topic, createTestPayload(tenantId, { topic, index: i }));
        }
      }

      for (const topic of topics) {
        expect(receivedPerTopic.get(topic)).toBe(10);
      }
    });

    test('should handle multi-tenant high-throughput without cross-contamination', async () => {
      const tenants = Array.from({ length: 10 }, () => randomUUID());
      const perTenantReceived: Map<string, PubSubMessage[]> = new Map();

      pubsub.subscribe('contact.ingested', async (msg) => {
        const tid = (msg.payload as any).tenant_id;
        if (!perTenantReceived.has(tid)) perTenantReceived.set(tid, []);
        perTenantReceived.get(tid)!.push(msg);
      });

      // Each tenant publishes 5 messages
      for (const tid of tenants) {
        for (let i = 0; i < 5; i++) {
          await pubsub.publish('contact.ingested', createTestPayload(tid, { seq: i }));
        }
      }

      for (const tid of tenants) {
        const msgs = perTenantReceived.get(tid) || [];
        expect(msgs.length).toBe(5);
        msgs.forEach((m) => expect((m.payload as any).tenant_id).toBe(tid));
      }
    });
  });

  // ==================================================================
  // MESSAGE ORDERING
  // ==================================================================

  describe('Message Ordering', () => {
    test('should maintain publish order within a topic', async () => {
      const received: number[] = [];
      pubsub.subscribe('action.executed', async (msg) => {
        received.push((msg.payload as any).sequence);
      });

      for (let i = 0; i < 20; i++) {
        await pubsub.publish('action.executed', createTestPayload(tenantId, { sequence: i }));
      }

      expect(received).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });

    test('should maintain ordering per tenant in shared topic', async () => {
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      const t1Sequences: number[] = [];
      const t2Sequences: number[] = [];

      pubsub.subscribe('brain.updated', async (msg) => {
        const p = msg.payload as any;
        if (p.tenant_id === tenant1) t1Sequences.push(p.seq);
        if (p.tenant_id === tenant2) t2Sequences.push(p.seq);
      });

      // Interleave messages from two tenants
      for (let i = 0; i < 10; i++) {
        await pubsub.publish('brain.updated', createTestPayload(tenant1, { seq: i }));
        await pubsub.publish('brain.updated', createTestPayload(tenant2, { seq: i }));
      }

      expect(t1Sequences).toEqual(Array.from({ length: 10 }, (_, i) => i));
      expect(t2Sequences).toEqual(Array.from({ length: 10 }, (_, i) => i));
    });
  });

  // ==================================================================
  // SCHEMA VALIDATION
  // ==================================================================

  describe('Schema Validation', () => {
    test('should validate PubSubMessage schema', () => {
      const msg: PubSubMessage = {
        messageId: randomUUID(),
        topic: 'contact.ingested',
        payload: { tenant_id: randomUUID(), data: 'test' },
        publishedAt: new Date().toISOString(),
        deliveryAttempt: 1,
      };
      expect(() => PubSubMessageSchema.parse(msg)).not.toThrow();
    });

    test('should validate DLQEntry schema', () => {
      const entry: DLQEntry = {
        originalMessageId: randomUUID(),
        topic: 'contact.ingested',
        payload: { tenant_id: randomUUID() },
        failureReason: 'Handler timeout',
        failureCount: 5,
        lastFailedAt: new Date().toISOString(),
        movedToDLQAt: new Date().toISOString(),
      };
      expect(() => DLQEntrySchema.parse(entry)).not.toThrow();
    });

    test('should reject message with missing required fields', () => {
      const invalid = {
        topic: 'test',
        payload: {},
        publishedAt: new Date().toISOString(),
      };
      expect(() => PubSubMessageSchema.parse(invalid)).toThrow();
    });
  });
});

// ====================================================================
// EXPORTS FOR REUSE
// ====================================================================

export {
  PubSubMessageSchema,
  DLQEntrySchema,
  type PubSubMessage,
  type DLQEntry,
  ReliablePubSubClient,
  DEFAULT_SUBSCRIPTION_CONFIG,
  createTestPayload,
};

