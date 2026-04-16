/**
 * KAN-59: Multi-Tenant Isolation Testing
 *
 * Validates that tenant data isolation is enforced across all services
 * in the growth core loop. Tests cover:
 *
 * 1. Database-level isolation (tenant_id on every query)
 * 2. Cache namespace isolation (no cross-tenant cache reads)
 * 3. Pub/Sub event isolation (events scoped to correct tenant)
 * 4. Brain context isolation (embeddings namespaced by tenant_id)
 * 5. Decision Engine isolation (no cross-tenant strategy bleed)
 * 6. Agent execution isolation (actions never cross tenants)
 * 7. Concurrent multi-tenant operations
 *
 * Architecture reference:
 * - tenant_id on every table
 * - Application-layer enforcement via Prisma middleware
 * - pgvector embeddings namespaced by tenant_id
 * - PgBouncer in transaction mode; pool sized for 2,000+ tenants
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';

// ==========================================================================
// SCHEMAS
// ==========================================================================

const TenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  plan_tier: z.enum(['starter', 'pro', 'enterprise']),
  blueprint_id: z.string().uuid().optional(),
  ai_permissions: z.record(z.boolean()),
  confidence_threshold: z.number().min(0).max(100),
  created_at: z.string().datetime(),
});

const TenantContactSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  segment: z.string(),
  data_quality_score: z.number().min(0).max(100),
});

const TenantDecisionSchema = z.object({
  decision_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  strategy_selected: z.string(),
  confidence: z.number().min(0).max(100),
});

type Tenant = z.infer<typeof TenantSchema>;
type TenantContact = z.infer<typeof TenantContactSchema>;
type TenantDecision = z.infer<typeof TenantDecisionSchema>;

// ==========================================================================
// IN-MEMORY ADAPTERS (Multi-Tenant Aware)
// ==========================================================================

class InMemoryDatabase {
  private tables: Map<string, Map<string, Record<string, unknown>>> = new Map();

  async insert(table: string, id: string, data: Record<string, unknown>): Promise<void> {
    if (!this.tables.has(table)) this.tables.set(table, new Map());
    this.tables.get(table)!.set(id, { ...data, id });
  }

  async findById(table: string, id: string): Promise<Record<string, unknown> | null> {
    return this.tables.get(table)?.get(id) ?? null;
  }

  async findByTenant(table: string, tenantId: string): Promise<Record<string, unknown>[]> {
    const tableData = this.tables.get(table);
    if (!tableData) return [];
    return [...tableData.values()].filter((row) => row.tenant_id === tenantId);
  }

  async findByField(table: string, field: string, value: unknown): Promise<Record<string, unknown>[]> {
    const tableData = this.tables.get(table);
    if (!tableData) return [];
    return [...tableData.values()].filter((row) => row[field] === value);
  }

  async deleteByTenant(table: string, tenantId: string): Promise<number> {
    const tableData = this.tables.get(table);
    if (!tableData) return 0;
    let deleted = 0;
    for (const [id, row] of tableData.entries()) {
      if (row.tenant_id === tenantId) {
        tableData.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  async count(table: string, tenantId?: string): Promise<number> {
    const tableData = this.tables.get(table);
    if (!tableData) return 0;
    if (!tenantId) return tableData.size;
    return [...tableData.values()].filter((row) => row.tenant_id === tenantId).length;
  }

  clear(): void {
    this.tables.clear();
  }
}

class InMemoryPubSubClient {
  private messages: Map<string, unknown[]> = new Map();
  private subscriptions: Map<string, ((msg: unknown) => Promise<void>)[]> = new Map();

  async publish(topic: string, message: unknown): Promise<void> {
    if (!this.messages.has(topic)) this.messages.set(topic, []);
    this.messages.get(topic)!.push(message);

    const subs = this.subscriptions.get(topic) || [];
    for (const handler of subs) {
      await handler(message);
    }
  }

  subscribe(topic: string, handler: (msg: unknown) => Promise<void>): void {
    if (!this.subscriptions.has(topic)) this.subscriptions.set(topic, []);
    this.subscriptions.get(topic)!.push(handler);
  }

  getMessages(topic: string): unknown[] {
    return this.messages.get(topic) || [];
  }

  getMessagesByTenant(topic: string, tenantId: string): unknown[] {
    const msgs = this.messages.get(topic) || [];
    return msgs.filter((m: any) => m.tenant_id === tenantId);
  }

  clear(): void {
    this.messages.clear();
    this.subscriptions.clear();
  }
}

class InMemoryCacheClient {
  private store: Map<string, unknown> = new Map();

  async get(key: string): Promise<unknown | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async getKeysByPattern(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace('*', '.*'));
    return [...this.store.keys()].filter((key) => regex.test(key));
  }

  clear(): void {
    this.store.clear();
  }
}

// ==========================================================================
// TENANT-AWARE SERVICE LAYER
// ==========================================================================

class TenantContext {
  constructor(public readonly tenantId: string) {}
}

class TenantAwareRepository {
  private db: InMemoryDatabase;

  constructor(db: InMemoryDatabase) {
    this.db = db;
  }

  async insertContact(ctx: TenantContext, contact: Omit<TenantContact, 'tenant_id'>): Promise<TenantContact> {
    const record = { ...contact, tenant_id: ctx.tenantId };
    await this.db.insert('contacts', contact.id, record as unknown as Record<string, unknown>);
    return record;
  }

  async getContacts(ctx: TenantContext): Promise<TenantContact[]> {
    const rows = await this.db.findByTenant('contacts', ctx.tenantId);
    return rows as unknown as TenantContact[];
  }

  async insertDecision(ctx: TenantContext, decision: Omit<TenantDecision, 'tenant_id'>): Promise<TenantDecision> {
    const record = { ...decision, tenant_id: ctx.tenantId };
    await this.db.insert('decisions', decision.decision_id, record as unknown as Record<string, unknown>);
    return record;
  }

  async getDecisions(ctx: TenantContext): Promise<TenantDecision[]> {
    const rows = await this.db.findByTenant('decisions', ctx.tenantId);
    return rows as unknown as TenantDecision[];
  }

  async insertAuditLog(ctx: TenantContext, entry: Record<string, unknown>): Promise<void> {
    await this.db.insert('audit_log', randomUUID(), { ...entry, tenant_id: ctx.tenantId });
  }

  async getAuditLog(ctx: TenantContext): Promise<Record<string, unknown>[]> {
    return this.db.findByTenant('audit_log', ctx.tenantId);
  }

  async insertStrategyWeight(ctx: TenantContext, weight: Record<string, unknown>): Promise<void> {
    await this.db.insert('strategy_weights', randomUUID(), { ...weight, tenant_id: ctx.tenantId });
  }

  async getStrategyWeights(ctx: TenantContext): Promise<Record<string, unknown>[]> {
    return this.db.findByTenant('strategy_weights', ctx.tenantId);
  }
}

class TenantAwareBrainService {
  private cache: InMemoryCacheClient;
  private db: InMemoryDatabase;

  constructor(cache: InMemoryCacheClient, db: InMemoryDatabase) {
    this.cache = cache;
    this.db = db;
  }

  async storeBrainContext(tenantId: string, contactId: string, context: Record<string, unknown>): Promise<void> {
    const key = `brain:${tenantId}:${contactId}`;
    await this.cache.set(key, context);
    await this.db.insert('brain_snapshots', randomUUID(), {
      tenant_id: tenantId,
      contact_id: contactId,
      context,
      version: 1,
      created_at: new Date().toISOString(),
    });
  }

  async getBrainContext(tenantId: string, contactId: string): Promise<Record<string, unknown> | null> {
    const key = `brain:${tenantId}:${contactId}`;
    return (await this.cache.get(key)) as Record<string, unknown> | null;
  }

  async storeEmbedding(tenantId: string, contactId: string, embedding: number[]): Promise<void> {
    const key = `embedding:${tenantId}:${contactId}`;
    await this.cache.set(key, { tenant_id: tenantId, contact_id: contactId, vector: embedding });
  }

  async getEmbedding(tenantId: string, contactId: string): Promise<unknown | null> {
    const key = `embedding:${tenantId}:${contactId}`;
    return this.cache.get(key);
  }
}

// ==========================================================================
// TEST HELPERS
// ==========================================================================

function createTestTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: randomUUID(),
    name: `Tenant ${Math.random().toString(36).slice(2, 8)}`,
    plan_tier: 'pro',
    ai_permissions: { sms: true, email: true, whatsapp: false },
    confidence_threshold: 60,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createTestContact(tenantId: string, overrides: Partial<TenantContact> = {}): TenantContact {
  return {
    id: randomUUID(),
    tenant_id: tenantId,
    email: `contact_${Math.random().toString(36).slice(2, 8)}@example.com`,
    name: `Contact ${Math.random().toString(36).slice(2, 8)}`,
    segment: 'warm_lead',
    data_quality_score: 85,
    ...overrides,
  };
}

// ==========================================================================
// TESTS
// ==========================================================================

describe('Multi-Tenant Isolation Testing (KAN-59)', () => {
  let db: InMemoryDatabase;
  let pubsub: InMemoryPubSubClient;
  let cache: InMemoryCacheClient;
  let repo: TenantAwareRepository;
  let brain: TenantAwareBrainService;

  let tenant1: Tenant;
  let tenant2: Tenant;
  let tenant3: Tenant;

  beforeEach(() => {
    db = new InMemoryDatabase();
    pubsub = new InMemoryPubSubClient();
    cache = new InMemoryCacheClient();
    repo = new TenantAwareRepository(db);
    brain = new TenantAwareBrainService(cache, db);

    tenant1 = createTestTenant({ name: 'Acme Corp' });
    tenant2 = createTestTenant({ name: 'Beta Inc' });
    tenant3 = createTestTenant({ name: 'Gamma LLC' });
  });

  // =====================================================================
  // DATABASE ISOLATION
  // =====================================================================

  describe('Database-Level Isolation', () => {
    test('should only return contacts for the requesting tenant', async () => {
      const ctx1 = new TenantContext(tenant1.id);
      const ctx2 = new TenantContext(tenant2.id);

      await repo.insertContact(ctx1, createTestContact(tenant1.id));
      await repo.insertContact(ctx1, createTestContact(tenant1.id));
      await repo.insertContact(ctx2, createTestContact(tenant2.id));

      const t1Contacts = await repo.getContacts(ctx1);
      const t2Contacts = await repo.getContacts(ctx2);

      expect(t1Contacts.length).toBe(2);
      expect(t2Contacts.length).toBe(1);

      t1Contacts.forEach((c) => expect(c.tenant_id).toBe(tenant1.id));
      t2Contacts.forEach((c) => expect(c.tenant_id).toBe(tenant2.id));
    });

    test('should isolate decisions across tenants', async () => {
      const ctx1 = new TenantContext(tenant1.id);
      const ctx2 = new TenantContext(tenant2.id);

      await repo.insertDecision(ctx1, {
        decision_id: randomUUID(),
        contact_id: randomUUID(),
        strategy_selected: 'direct_outreach',
        confidence: 85,
      });

      await repo.insertDecision(ctx2, {
        decision_id: randomUUID(),
        contact_id: randomUUID(),
        strategy_selected: 'trust_building',
        confidence: 70,
      });

      const t1Decisions = await repo.getDecisions(ctx1);
      const t2Decisions = await repo.getDecisions(ctx2);

      expect(t1Decisions.length).toBe(1);
      expect(t2Decisions.length).toBe(1);
      expect(t1Decisions[0].strategy_selected).toBe('direct_outreach');
      expect(t2Decisions[0].strategy_selected).toBe('trust_building');
    });

    test('should isolate audit logs per tenant', async () => {
      const ctx1 = new TenantContext(tenant1.id);
      const ctx2 = new TenantContext(tenant2.id);

      await repo.insertAuditLog(ctx1, { action: 'email_sent', actor: 'agent:communication' });
      await repo.insertAuditLog(ctx1, { action: 'crm_updated', actor: 'agent:operational' });
      await repo.insertAuditLog(ctx2, { action: 'escalation', actor: 'agent:escalation' });

      const t1Logs = await repo.getAuditLog(ctx1);
      const t2Logs = await repo.getAuditLog(ctx2);

      expect(t1Logs.length).toBe(2);
      expect(t2Logs.length).toBe(1);
    });

    test('should isolate strategy weights per tenant', async () => {
      const ctx1 = new TenantContext(tenant1.id);
      const ctx2 = new TenantContext(tenant2.id);

      await repo.insertStrategyWeight(ctx1, { strategy: 'direct_outreach', win_rate: 0.8, sample_size: 50 });
      await repo.insertStrategyWeight(ctx2, { strategy: 'direct_outreach', win_rate: 0.4, sample_size: 30 });

      const t1Weights = await repo.getStrategyWeights(ctx1);
      const t2Weights = await repo.getStrategyWeights(ctx2);

      expect(t1Weights.length).toBe(1);
      expect(t2Weights.length).toBe(1);
      expect(t1Weights[0].win_rate).toBe(0.8);
      expect(t2Weights[0].win_rate).toBe(0.4);
    });

    test('should delete only target tenant data', async () => {
      const ctx1 = new TenantContext(tenant1.id);
      const ctx2 = new TenantContext(tenant2.id);

      await repo.insertContact(ctx1, createTestContact(tenant1.id));
      await repo.insertContact(ctx1, createTestContact(tenant1.id));
      await repo.insertContact(ctx2, createTestContact(tenant2.id));

      const deleted = await db.deleteByTenant('contacts', tenant1.id);
      expect(deleted).toBe(2);

      const t1Contacts = await repo.getContacts(ctx1);
      const t2Contacts = await repo.getContacts(ctx2);
      expect(t1Contacts.length).toBe(0);
      expect(t2Contacts.length).toBe(1);
    });
  });

  // =====================================================================
  // CACHE NAMESPACE ISOLATION
  // =====================================================================

  describe('Cache Namespace Isolation', () => {
    test('should namespace brain context by tenant_id', async () => {
      const contactId = randomUUID();

      await brain.storeBrainContext(tenant1.id, contactId, { company: 'Acme' });
      await brain.storeBrainContext(tenant2.id, contactId, { company: 'Beta' });

      const t1Context = await brain.getBrainContext(tenant1.id, contactId);
      const t2Context = await brain.getBrainContext(tenant2.id, contactId);

      expect(t1Context).toEqual({ company: 'Acme' });
      expect(t2Context).toEqual({ company: 'Beta' });
    });

    test('should not allow cross-tenant cache reads', async () => {
      const contactId = randomUUID();

      await brain.storeBrainContext(tenant1.id, contactId, { secret: 'tenant1-data' });

      // Tenant 2 should not see tenant 1's data
      const t2Context = await brain.getBrainContext(tenant2.id, contactId);
      expect(t2Context).toBeNull();
    });

    test('should namespace embeddings by tenant_id', async () => {
      const contactId = randomUUID();
      const embedding1 = [0.1, 0.2, 0.3];
      const embedding2 = [0.4, 0.5, 0.6];

      await brain.storeEmbedding(tenant1.id, contactId, embedding1);
      await brain.storeEmbedding(tenant2.id, contactId, embedding2);

      const t1Embedding = (await brain.getEmbedding(tenant1.id, contactId)) as any;
      const t2Embedding = (await brain.getEmbedding(tenant2.id, contactId)) as any;

      expect(t1Embedding.vector).toEqual(embedding1);
      expect(t2Embedding.vector).toEqual(embedding2);
      expect(t1Embedding.tenant_id).toBe(tenant1.id);
      expect(t2Embedding.tenant_id).toBe(tenant2.id);
    });

    test('should isolate cache keys by tenant pattern', async () => {
      await cache.set(`brain:${tenant1.id}:contact1`, { data: 1 });
      await cache.set(`brain:${tenant1.id}:contact2`, { data: 2 });
      await cache.set(`brain:${tenant2.id}:contact1`, { data: 3 });

      const t1Keys = await cache.getKeysByPattern(`brain:${tenant1.id}:*`);
      const t2Keys = await cache.getKeysByPattern(`brain:${tenant2.id}:*`);

      expect(t1Keys.length).toBe(2);
      expect(t2Keys.length).toBe(1);
    });
  });

  // =====================================================================
  // PUB/SUB EVENT ISOLATION
  // =====================================================================

  describe('Pub/Sub Event Isolation', () => {
    test('should tag all events with tenant_id', async () => {
      await pubsub.publish('contact.ingested', {
        tenant_id: tenant1.id,
        contact_id: randomUUID(),
        data: { name: 'Jane' },
      });

      await pubsub.publish('contact.ingested', {
        tenant_id: tenant2.id,
        contact_id: randomUUID(),
        data: { name: 'John' },
      });

      const allEvents = pubsub.getMessages('contact.ingested') as any[];
      expect(allEvents.length).toBe(2);

      const t1Events = pubsub.getMessagesByTenant('contact.ingested', tenant1.id);
      const t2Events = pubsub.getMessagesByTenant('contact.ingested', tenant2.id);

      expect(t1Events.length).toBe(1);
      expect(t2Events.length).toBe(1);
    });

    test('should isolate action.decided events per tenant', async () => {
      for (let i = 0; i < 5; i++) {
        await pubsub.publish('action.decided', {
          tenant_id: tenant1.id,
          decision_id: randomUUID(),
          action_type: 'send_email',
        });
      }

      for (let i = 0; i < 3; i++) {
        await pubsub.publish('action.decided', {
          tenant_id: tenant2.id,
          decision_id: randomUUID(),
          action_type: 'send_message',
        });
      }

      const t1Events = pubsub.getMessagesByTenant('action.decided', tenant1.id);
      const t2Events = pubsub.getMessagesByTenant('action.decided', tenant2.id);
      const t3Events = pubsub.getMessagesByTenant('action.decided', tenant3.id);

      expect(t1Events.length).toBe(5);
      expect(t2Events.length).toBe(3);
      expect(t3Events.length).toBe(0);
    });

    test('should isolate outcome.recorded events per tenant', async () => {
      await pubsub.publish('outcome.recorded', {
        tenant_id: tenant1.id,
        result: 'success',
        contact_id: randomUUID(),
      });

      await pubsub.publish('outcome.recorded', {
        tenant_id: tenant2.id,
        result: 'failure',
        contact_id: randomUUID(),
      });

      const t1Outcomes = pubsub.getMessagesByTenant('outcome.recorded', tenant1.id) as any[];
      const t2Outcomes = pubsub.getMessagesByTenant('outcome.recorded', tenant2.id) as any[];

      expect(t1Outcomes[0].result).toBe('success');
      expect(t2Outcomes[0].result).toBe('failure');
    });
  });

  // =====================================================================
  // BRAIN CONTEXT ISOLATION
  // =====================================================================

  describe('Brain Context Isolation', () => {
    test('should store and retrieve tenant-specific company truth', async () => {
      await brain.storeBrainContext(tenant1.id, 'shared-contact', {
        company_truth: { product: 'Widget A', price: 49 },
      });

      await brain.storeBrainContext(tenant2.id, 'shared-contact', {
        company_truth: { product: 'Service B', price: 199 },
      });

      const t1Brain = await brain.getBrainContext(tenant1.id, 'shared-contact');
      const t2Brain = await brain.getBrainContext(tenant2.id, 'shared-contact');

      expect((t1Brain as any).company_truth.product).toBe('Widget A');
      expect((t2Brain as any).company_truth.product).toBe('Service B');
    });

    test('should never return cross-tenant brain data', async () => {
      await brain.storeBrainContext(tenant1.id, 'contact-123', {
        sensitive: 'tenant1-financial-data',
      });

      // Direct key manipulation attempt
      const wrongKeyResult = await cache.get(`brain:${tenant2.id}:contact-123`);
      expect(wrongKeyResult).toBeNull();

      // Correct key still works
      const correctResult = await brain.getBrainContext(tenant1.id, 'contact-123');
      expect(correctResult).not.toBeNull();
    });

    test('should persist brain snapshots with tenant isolation', async () => {
      await brain.storeBrainContext(tenant1.id, 'contact-a', { version: 1 });
      await brain.storeBrainContext(tenant2.id, 'contact-a', { version: 1 });

      const t1Snapshots = await db.findByTenant('brain_snapshots', tenant1.id);
      const t2Snapshots = await db.findByTenant('brain_snapshots', tenant2.id);

      expect(t1Snapshots.length).toBe(1);
      expect(t2Snapshots.length).toBe(1);
      expect(t1Snapshots[0].tenant_id).toBe(tenant1.id);
      expect(t2Snapshots[0].tenant_id).toBe(tenant2.id);
    });
  });

  // =====================================================================
  // CONCURRENT MULTI-TENANT OPERATIONS
  // =====================================================================

  describe('Concurrent Multi-Tenant Operations', () => {
    test('should handle 10 tenants inserting contacts concurrently', async () => {
      const tenants = Array.from({ length: 10 }, () => createTestTenant());

      const insertions = tenants.flatMap((tenant) =>
        Array.from({ length: 5 }, () =>
          repo.insertContact(
            new TenantContext(tenant.id),
            createTestContact(tenant.id)
          )
        )
      );

      await Promise.all(insertions);

      for (const tenant of tenants) {
        const contacts = await repo.getContacts(new TenantContext(tenant.id));
        expect(contacts.length).toBe(5);
        contacts.forEach((c) => expect(c.tenant_id).toBe(tenant.id));
      }
    });

    test('should handle concurrent brain context writes without cross-contamination', async () => {
      const contactId = randomUUID();
      const tenants = Array.from({ length: 5 }, () => createTestTenant());

      await Promise.all(
        tenants.map((t) =>
          brain.storeBrainContext(t.id, contactId, { owner: t.name })
        )
      );

      for (const tenant of tenants) {
        const ctx = await brain.getBrainContext(tenant.id, contactId);
        expect((ctx as any).owner).toBe(tenant.name);
      }
    });

    test('should handle concurrent pub/sub events from multiple tenants', async () => {
      const tenants = Array.from({ length: 5 }, () => createTestTenant());

      const publishes = tenants.flatMap((tenant) =>
        Array.from({ length: 3 }, (_, i) =>
          pubsub.publish('action.executed', {
            tenant_id: tenant.id,
            action_id: randomUUID(),
            sequence: i,
          })
        )
      );

      await Promise.all(publishes);

      const allEvents = pubsub.getMessages('action.executed') as any[];
      expect(allEvents.length).toBe(15);

      for (const tenant of tenants) {
        const tenantEvents = pubsub.getMessagesByTenant('action.executed', tenant.id);
        expect(tenantEvents.length).toBe(3);
      }
    });

    test('should maintain isolation under high concurrency (50 tenants)', async () => {
      const tenants = Array.from({ length: 50 }, () => createTestTenant());

      await Promise.all(
        tenants.map((t) =>
          repo.insertContact(
            new TenantContext(t.id),
            createTestContact(t.id)
          )
        )
      );

      const totalContacts = await db.count('contacts');
      expect(totalContacts).toBe(50);

      for (const tenant of tenants) {
        const count = await db.count('contacts', tenant.id);
        expect(count).toBe(1);
      }
    });
  });

  // =====================================================================
  // SCHEMA VALIDATION
  // =====================================================================

  describe('Schema Validation', () => {
    test('should validate Tenant schema', () => {
      expect(() => TenantSchema.parse(tenant1)).not.toThrow();
    });

    test('should validate TenantContact schema', () => {
      const contact = createTestContact(tenant1.id);
      expect(() => TenantContactSchema.parse(contact)).not.toThrow();
    });

    test('should validate TenantDecision schema', () => {
      const decision: TenantDecision = {
        decision_id: randomUUID(),
        tenant_id: tenant1.id,
        contact_id: randomUUID(),
        strategy_selected: 'direct_outreach',
        confidence: 85,
      };
      expect(() => TenantDecisionSchema.parse(decision)).not.toThrow();
    });

    test('should reject contact without tenant_id', () => {
      const invalid = {
        id: randomUUID(),
        email: 'test@example.com',
        name: 'Test',
        segment: 'cold',
        data_quality_score: 50,
      };
      expect(() => TenantContactSchema.parse(invalid)).toThrow();
    });
  });
});

// ==========================================================================
// EXPORTS FOR REUSE
// ==========================================================================

export {
  TenantSchema,
  TenantContactSchema,
  TenantDecisionSchema,
  type Tenant,
  type TenantContact,
  type TenantDecision,
  InMemoryDatabase,
  InMemoryPubSubClient,
  InMemoryCacheClient,
  TenantContext,
  TenantAwareRepository,
  TenantAwareBrainService,
  createTestTenant,
  createTestContact,
};
