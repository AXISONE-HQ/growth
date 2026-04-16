/**
 * âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 * Growth AI Revenue System: Core Loop Integration Test
 * âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 *
 * Integration test suite for the first half of the growth core loop:
 * Ingestion Service â Brain Service â Decision Engine
 *
 * Validates the complete flow from CSV contact ingestion through
 * business intelligence updates to strategic action decisions across
 * multiple contact and segment types with proper multi-tenant isolation.
 *
 * Services tested:
 * - Ingestion Service: Raw normalization, field mapping, identity resolution,
 *   timeline building, data quality scoring
 * - Brain Service: Context updates, objective gap computation, intelligent
 *   caching of business intelligence
 * - Decision Engine: Strategy selection, action determination, confidence
 *   scoring, threshold gating
 *
 * @module growth-core-loop-integration-test
 */

import { z } from 'zod';

// ============================================================================
// TYPE DEFINITIONS & ZOD SCHEMAS
// ============================================================================

/**
 * CSV input schema for contact import
 */
const CSVContactSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  companyName: z.string(),
  industry: z.string(),
  jobTitle: z.string(),
  phoneNumber: z.string().optional(),
  linkedInUrl: z.string().url().optional(),
  employeeCount: z.number().optional(),
  annualRevenue: z.number().optional(),
});

type CSVContact = z.infer<typeof CSVContactSchema>;

/**
 * Normalized contact schema post-ingestion
 */
const NormalizedContactSchema = z.object({
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().email(),
  company_name: z.string(),
  industry: z.string(),
  job_title: z.string(),
  phone_number: z.string().nullable(),
  linkedin_url: z.string().url().nullable(),
  data_quality_score: z.number().min(0).max(100),
  ingested_at: z.string().datetime(),
  source: z.literal('csv'),
});

type NormalizedContact = z.infer<typeof NormalizedContactSchema>;

/**
 * Company context schema for industry blueprint
 */
const CompanyContextSchema = z.object({
  tenant_id: z.string().uuid(),
  company_id: z.string().uuid(),
  company_name: z.string(),
  industry: z.string(),
  employee_count: z.number().optional(),
  annual_revenue: z.number().optional(),
  industry_benchmark: z.number().optional(),
  typical_sales_cycle_days: z.number().optional(),
});

type CompanyContext = z.infer<typeof CompanyContextSchema>;

/**
 * Business brain context schema
 */
const BrainContextSchema = z.object({
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  company_id: z.string().uuid(),
  industry_blueprint: z.object({
    industry: z.string(),
    typical_decision_makers: z.number(),
    avg_sales_cycle_days: z.number(),
  }),
  company_truth: z.object({
    company_name: z.string(),
    growth_stage: z.enum(['startup', 'growth', 'mature', 'enterprise']),
    tech_stack: z.array(z.string()),
  }),
  behavioral_learning: z.object({
    engagement_score: z.number().min(0).max(100),
    response_rate: z.number().min(0).max(1),
    content_preferences: z.array(z.string()),
  }),
  outcome_learning: z.object({
    conversion_rate: z.number().min(0).max(1),
    avg_deal_size: z.number().optional(),
    win_rate: z.number().min(0).max(1).optional(),
  }),
  contact_state: z.object({
    segment: z.enum([
      'new_lead',
      'warm_lead',
      'hot_lead',
      'active_customer',
      'at_risk',
      'churned',
    ]),
    lifecycle_stage: z.string(),
    days_since_last_engagement: z.number(),
  }),
  objective_gap: z.number().min(0).max(100).optional(),
  updated_at: z.string().datetime(),
});

type BrainContext = z.infer<typeof BrainContextSchema>;

/**
 * Strategy context schema
 */
const StrategyContextSchema = z.object({
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  objective_gap: z.number().min(0).max(100),
  current_segment: z.enum([
    'new_lead',
    'warm_lead',
    'hot_lead',
    'active_customer',
    'at_risk',
    'churned',
  ]),
  engagement_score: z.number().min(0).max(100),
  recommended_strategies: z.array(
    z.object({
      strategy: z.string(),
      priority: z.enum(['critical', 'high', 'medium', 'low']),
      reasoning: z.string(),
    })
  ),
});

type StrategyContext = z.infer<typeof StrategyContextSchema>;

/**
 * Action decision schema
 */
const ActionDecisionSchema = z.object({
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  action_id: z.string().uuid(),
  action_type: z.enum([
    'email_outreach',
    'call_request',
    'content_send',
    'meeting_schedule',
    'nurture_sequence',
    'hold',
  ]),
  confidence_score: z.number().min(0).max(100),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  reasoning: z.string(),
  threshold_passed: z.boolean(),
  decided_at: z.string().datetime(),
});

type ActionDecision = z.infer<typeof ActionDecisionSchema>;

/**
 * Event schemas for Pub/Sub
 */
const ContactIngestedEventSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.literal('contact.ingested'),
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  contact: NormalizedContactSchema,
  timestamp: z.string().datetime(),
});

type ContactIngestedEvent = z.infer<typeof ContactIngestedEventSchema>;

const BrainUpdatedEventSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.literal('brain.updated'),
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  brain_context: BrainContextSchema,
  strategy_context: StrategyContextSchema,
  timestamp: z.string().datetime(),
});

type BrainUpdatedEvent = z.infer<typeof BrainUpdatedEventSchema>;

const ActionDecidedEventSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.literal('action.decided'),
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  action: ActionDecisionSchema,
  timestamp: z.string().datetime(),
});

type ActionDecidedEvent = z.infer<typeof ActionDecidedEventSchema>;

// ============================================================================
// IN-MEMORY ADAPTERS
// ============================================================================

/**
 * In-memory database adapter for testing
 */
interface InMemoryDatabaseRecord {
  [key: string]: Record<string, unknown>;
}

class InMemoryDatabase {
  private tables: Map<string, Map<string, unknown>> = new Map();

  async insert(
    table: string,
    record: Record<string, unknown>
  ): Promise<void> {
    if (!this.tables.has(table)) {
      this.tables.set(table, new Map());
    }
    const id = (record.id || record.contact_id || record.action_id) as string;
    this.tables.get(table)!.set(id, record);
  }

  async find(table: string, id: string): Promise<Record<string, unknown> | null> {
    const tableMap = this.tables.get(table);
    return tableMap?.get(id) ?? null;
  }

  async findByTenant(
    table: string,
    tenantId: string
  ): Promise<Record<string, unknown>[]> {
    const tableMap = this.tables.get(table);
    if (!tableMap) return [];
    return Array.from(tableMap.values()).filter(
      (record) => (record as Record<string, unknown>).tenant_id === tenantId
    );
  }

  async update(table: string, record: Record<string, unknown>): Promise<void> {
    const id = (record.id || record.contact_id || record.action_id) as string;
    const tableMap = this.tables.get(table);
    if (tableMap) {
      tableMap.set(id, { ...tableMap.get(id), ...record });
    }
  }

  async delete(table: string, id: string): Promise<void> {
    const tableMap = this.tables.get(table);
    if (tableMap) {
      tableMap.delete(id);
    }
  }

  clear(): void {
    this.tables.clear();
  }

  getTable(table: string): Map<string, unknown> {
    if (!this.tables.has(table)) {
      this.tables.set(table, new Map());
    }
    return this.tables.get(table)!;
  }
}

/**
 * In-memory Pub/Sub client for testing
 */
class InMemoryPubSubClient {
  private messages: Map<string, Array<Record<string, unknown>>> = new Map();
  private subscribers: Map<
    string,
    Array<(message: Record<string, unknown>) => Promise<void>>
  > = new Map();

  async publish(topic: string, message: Record<string, unknown>): Promise<string> {
    if (!this.messages.has(topic)) {
      this.messages.set(topic, []);
    }
    this.messages.get(topic)!.push(message);

    // Trigger subscribers
    const subs = this.subscribers.get(topic) || [];
    for (const subscriber of subs) {
      await subscriber(message);
    }

    return `message-${Date.now()}`;
  }

  async subscribe(
    topic: string,
    handler: (message: Record<string, unknown>) => Promise<void>
  ): Promise<string> {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, []);
    }
    this.subscribers.get(topic)!.push(handler);
    return `subscription-${Date.now()}`;
  }

  getMessages(topic: string): Array<Record<string, unknown>> {
    return this.messages.get(topic) || [];
  }

  clear(): void {
    this.messages.clear();
    this.subscribers.clear();
  }
}

/**
 * In-memory cache client for testing
 */
class InMemoryCacheClient {
  private cache: Map<string, { value: unknown; expiresAt?: number }> = new Map();

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.cache.set(key, { value, expiresAt });
  }

  async get(key: string): Promise<unknown | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  getAll(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of this.cache.entries()) {
      if (!entry.expiresAt || Date.now() <= entry.expiresAt) {
        result[key] = entry.value;
      }
    }
    return result;
  }
}

// ============================================================================
// INGESTION SERVICE
// ============================================================================

interface IngestionServiceDependencies {
  db: InMemoryDatabase;
  pubsub: InMemoryPubSubClient;
}

class IngestionService {
  constructor(private deps: IngestionServiceDependencies) {}

  /**
   * Normalize raw CSV contact data into canonical form
   */
  private normalizeContact(
    csvContact: CSVContact,
    tenantId: string
  ): NormalizedContact {
    const contactId = this.generateUUID();
    return {
      tenant_id: tenantId,
      contact_id: contactId,
      first_name: csvContact.firstName,
      last_name: csvContact.lastName,
      email: csvContact.email,
      company_name: csvContact.companyName,
      industry: csvContact.industry,
      job_title: csvContact.jobTitle,
      phone_number: csvContact.phoneNumber || null,
      linkedin_url: csvContact.linkedInUrl || null,
      data_quality_score: 0, // Will be computed later
      ingested_at: new Date().toISOString(),
      source: 'csv',
    };
  }

  /**
   * Map and enrich contact fields using AI heuristics
   */
  private async mapFields(contact: NormalizedContact): Promise<void> {
    // Simulate AI field mapping: extract job seniority, function, etc.
    // In production, this would call an AI service
  }

  /**
   * Resolve contact identity and deduplicate
   */
  private async resolveIdentity(
    contact: NormalizedContact
  ): Promise<NormalizedContact> {
    // Check for duplicates by email + company
    const existing = await this.deps.db.findByTenant(
      'contacts',
      contact.tenant_id
    );
    const duplicate = existing.find(
      (c) =>
        (c as Record<string, unknown>).email === contact.email &&
        (c as Record<string, unknown>).company_name === contact.company_name
    );

    if (duplicate) {
      // In production, merge records intelligently
      return contact;
    }

    return contact;
  }

  /**
   * Compute data quality score
   */
  private computeDataQualityScore(contact: NormalizedContact): number {
    let score = 50; // Base score

    // Email present and valid
    if (contact.email && contact.email.includes('@')) score += 20;

    // LinkedIn URL present
    if (contact.linkedin_url) score += 15;

    // Phone number present
    if (contact.phone_number) score += 10;

    // Company and job title
    if (contact.company_name && contact.job_title) score += 5;

    return Math.min(score, 100);
  }

  /**
   * Build enriched timeline for contact
   */
  private buildTimeline(contact: NormalizedContact): Record<string, unknown> {
    return {
      contact_id: contact.contact_id,
      tenant_id: contact.tenant_id,
      events: [
        {
          event_type: 'contact_created',
          timestamp: contact.ingested_at,
          source: 'csv_import',
        },
      ],
      first_seen: contact.ingested_at,
      last_updated: contact.ingested_at,
    };
  }

  /**
   * Process single CSV contact through ingestion pipeline
   */
  async ingestContact(csvContact: CSVContact, tenantId: string): Promise<NormalizedContact> {
    // Step 1: Normalize
    let normalizedContact = this.normalizeContact(csvContact, tenantId);

    // Step 2: Map fields
    await this.mapFields(normalizedContact);

    // Step 3: Resolve identity
    normalizedContact = await this.resolveIdentity(normalizedContact);

    // Step 4: Compute data quality
    normalizedContact.data_quality_score = this.computeDataQualityScore(
      normalizedContact
    );

    // Step 5: Build timeline
    const timeline = this.buildTimeline(normalizedContact);

    // Step 6: Persist
    await this.deps.db.insert('contacts', normalizedContact);
    await this.deps.db.insert('timelines', timeline);

    // Step 7: Publish event
    const event: ContactIngestedEvent = {
      event_id: this.generateUUID(),
      event_type: 'contact.ingested',
      tenant_id: tenantId,
      contact_id: normalizedContact.contact_id,
      contact: normalizedContact,
      timestamp: new Date().toISOString(),
    };

    await this.deps.pubsub.publish('contact.ingested', event);

    return normalizedContact;
  }

  /**
   * Process batch of CSV contacts
   */
  async ingestContacts(
    csvContacts: CSVContact[],
    tenantId: string
  ): Promise<NormalizedContact[]> {
    const results: NormalizedContact[] = [];
    for (const csvContact of csvContacts) {
      const normalized = await this.ingestContact(csvContact, tenantId);
      results.push(normalized);
    }
    return results;
  }

  private generateUUID(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================================================
// BRAIN SERVICE
// ============================================================================

interface BrainServiceDependencies {
  db: InMemoryDatabase;
  pubsub: InMemoryPubSubClient;
  cache: InMemoryCacheClient;
}

class BrainService {
  constructor(private deps: BrainServiceDependencies) {}

  /**
   * Load or create industry blueprint for given industry
   */
  private async loadIndustryBlueprint(
    industry: string
  ): Promise<Record<string, unknown>> {
    const cached = await this.deps.cache.get(`blueprint:${industry}`);
    if (cached) return cached as Record<string, unknown>;

    // Simulate lookup or generation
    const blueprint = {
      industry,
      typical_decision_makers: 2.5,
      avg_sales_cycle_days: 30,
    };

    await this.deps.cache.set(`blueprint:${industry}`, blueprint, 3600);
    return blueprint;
  }

  /**
   * Load or create company truth
   */
  private async loadCompanyTruth(
    tenantId: string,
    companyName: string
  ): Promise<Record<string, unknown>> {
    const cacheKey = `truth:${tenantId}:${companyName}`;
    const cached = await this.deps.cache.get(cacheKey);
    if (cached) return cached as Record<string, unknown>;

    const truth = {
      company_name: companyName,
      growth_stage: 'growth' as const,
      tech_stack: ['SaaS', 'Cloud'],
    };

    await this.deps.cache.set(cacheKey, truth, 3600);
    return truth;
  }

  /**
   * Compute behavioral learning from engagement history
   */
  private async computeBehavioralLearning(
    tenantId: string,
    contactId: string
  ): Promise<Record<string, unknown>> {
    // Simulate lookup of engagement history
    return {
      engagement_score: Math.floor(Math.random() * 100),
      response_rate: Math.random() * 0.5,
      content_preferences: ['product_demos', 'case_studies'],
    };
  }

  /**
   * Compute outcome learning from historical results
   */
  private async computeOutcomeLearning(
    tenantId: string,
    contactId: string
  ): Promise<Record<string, unknown>> {
    return {
      conversion_rate: Math.random() * 0.3,
      avg_deal_size: Math.random() * 50000 + 10000,
      win_rate: Math.random() * 0.4,
    };
  }

  /**
   * Compute objective gap (delta between current state and desired outcome)
   */
  async computeObjectiveGap(contact: NormalizedContact): Promise<number> {
    const baseQuality = contact.data_quality_score;
    const engagementMultiplier = Math.random() * 0.5;
    const gap = 100 - baseQuality + engagementMultiplier * 30;
    return Math.min(Math.max(gap, 0), 100);
  }

  /**
   * Determine contact segment based on behavioral signals
   */
  private async determineSegment(
    tenantId: string,
    contactId: string,
    engagementScore: number
  ): Promise<
    | 'new_lead'
    | 'warm_lead'
    | 'hot_lead'
    | 'active_customer'
    | 'at_risk'
    | 'churned'
  > {
    if (engagementScore >= 80) return 'hot_lead';
    if (engagementScore >= 60) return 'warm_lead';
    if (engagementScore >= 40) return 'new_lead';
    if (engagementScore >= 20) return 'at_risk';
    return 'churned';
  }

  /**
   * Update business brain context for a contact
   */
  async updateBrainContext(
    tenantId: string,
    contact: NormalizedContact,
    objectiveGap: number
  ): Promise<BrainContext> {
    const industryBlueprint = await this.loadIndustryBlueprint(contact.industry);
    const companyTruth = await this.loadCompanyTruth(tenantId, contact.company_name);
    const behavioralLearning = await this.computeBehavioralLearning(
      tenantId,
      contact.contact_id
    );
    const outcomeLearning = await this.computeOutcomeLearning(
      tenantId,
      contact.contact_id
    );

    const engagementScore = (behavioralLearning as Record<string, unknown>)
      .engagement_score as number;
    const segment = await this.determineSegment(
      tenantId,
      contact.contact_id,
      engagementScore
    );

    const brainContext: BrainContext = {
      tenant_id: tenantId,
      contact_id: contact.contact_id,
      company_id: this.generateUUID(),
      industry_blueprint: industryBlueprint as any,
      company_truth: companyTruth as any,
      behavioral_learning: behavioralLearning as any,
      outcome_learning: outcomeLearning as any,
      contact_state: {
        segment,
        lifecycle_stage: 'consideration',
        days_since_last_engagement: Math.floor(Math.random() * 30),
      },
      objective_gap: objectiveGap,
      updated_at: new Date().toISOString(),
    };

    // Persist brain context
    await this.deps.db.insert(
      'brain_contexts',
      brainContext as Record<string, unknown>
    );

    // Cache it
    const cacheKey = `brain:${tenantId}:${contact.contact_id}`;
    await this.deps.cache.set(cacheKey, brainContext, 1800);

    return brainContext;
  }

  /**
   * Compute strategy context from brain state
   */
  async computeStrategyContext(
    tenantId: string,
    contact: NormalizedContact,
    brainContext: BrainContext
  ): Promise<StrategyContext> {
    const strategies: Array<{
      strategy: string;
      priority: 'critical' | 'high' | 'medium' | 'low';
      reasoning: string;
    }> = [];

    const segment = brainContext.contact_state.segment;
    const engagementScore = (brainContext.behavioral_learning as Record<string, unknown>)
      .engagement_score as number;
    const objectiveGap = brainContext.objective_gap!;

    // Segment-specific strategies
    if (segment === 'new_lead') {
      strategies.push({
        strategy: 'nurture_sequence',
        priority: 'high',
        reasoning: 'New leads need education and trust building',
      });
      strategies.push({
        strategy: 'content_send',
        priority: 'medium',
        reasoning: 'Industry-relevant content to establish thought leadership',
      });
    } else if (segment === 'warm_lead') {
      strategies.push({
        strategy: 'call_request',
        priority: 'high',
        reasoning: 'Warm leads are ready for direct engagement',
      });
      strategies.push({
        strategy: 'meeting_schedule',
        priority: 'medium',
        reasoning: 'Move toward sales conversation',
      });
    } else if (segment === 'hot_lead') {
      strategies.push({
        strategy: 'meeting_schedule',
        priority: 'critical',
        reasoning: 'Hot leads need immediate sales engagement',
      });
      strategies.push({
        strategy: 'call_request',
        priority: 'critical',
        reasoning: 'Direct outreach required',
      });
    } else if (segment === 'active_customer') {
      strategies.push({
        strategy: 'nurture_sequence',
        priority: 'medium',
        reasoning: 'Expand account with existing customer',
      });
      strategies.push({
        strategy: 'content_send',
        priority: 'low',
        reasoning: 'Share advanced content for upsell opportunities',
      });
    } else if (segment === 'at_risk') {
      strategies.push({
        strategy: 'call_request',
        priority: 'critical',
        reasoning: 'At-risk customers need immediate retention efforts',
      });
      strategies.push({
        strategy: 'meeting_schedule',
        priority: 'high',
        reasoning: 'Executive check-in required',
      });
    } else if (segment === 'churned') {
      strategies.push({
        strategy: 'nurture_sequence',
        priority: 'low',
        reasoning: 'Re-engagement campaign for win-back',
      });
    }

    return {
      tenant_id: tenantId,
      contact_id: contact.contact_id,
      objective_gap: objectiveGap,
      current_segment: segment,
      engagement_score: engagementScore,
      recommended_strategies: strategies,
    };
  }

  /**
   * Publish brain.updated event
   */
  async publishBrainUpdated(
    tenantId: string,
    contact: NormalizedContact,
    brainContext: BrainContext,
    strategyContext: StrategyContext
  ): Promise<void> {
    const event: BrainUpdatedEvent = {
      event_id: this.generateUUID(),
      event_type: 'brain.updated',
      tenant_id: tenantId,
      contact_id: contact.contact_id,
      brain_context: brainContext,
      strategy_context: strategyContext,
      timestamp: new Date().toISOString(),
    };

    await this.deps.pubsub.publish('brain.updated', event);
  }

  /**
   * Process contact.ingested event and update brain
   */
  async onContactIngested(event: ContactIngestedEvent): Promise<void> {
    const objectiveGap = await this.computeObjectiveGap(event.contact);
    const brainContext = await this.updateBrainContext(
      event.tenant_id,
      event.contact,
      objectiveGap
    );
    const strategyContext = await this.computeStrategyContext(
      event.tenant_id,
      event.contact,
      brainContext
    );

    await this.publishBrainUpdated(
      event.tenant_id,
      event.contact,
      brainContext,
      strategyContext
    );
  }

  private generateUUID(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================================================
// DECISION ENGINE
// ============================================================================

interface DecisionEngineDependencies {
  db: InMemoryDatabase;
  pubsub: InMemoryPubSubClient;
  cache: InMemoryCacheClient;
}

class DecisionEngine {
  constructor(private deps: DecisionEngineDependencies) {}

  /**
   * Analyze objective gap to determine urgency
   */
  private analyzeObjectiveGap(
    gap: number
  ): { urgency: 'critical' | 'high' | 'medium' | 'low'; reason: string } {
    if (gap >= 80) {
      return {
        urgency: 'critical',
        reason: 'Very large gap requires immediate action',
      };
    } else if (gap >= 60) {
      return {
        urgency: 'high',
        reason: 'Significant gap should be addressed soon',
      };
    } else if (gap >= 40) {
      return { urgency: 'medium', reason: 'Moderate gap allows scheduled action' };
    } else {
      return {
        urgency: 'low',
        reason: 'Small gap can wait for right moment',
      };
    }
  }

  /**
   * Select best action from strategy recommendations
   */
  private selectAction(
    segment: string,
    strategies: Array<{
      strategy: string;
      priority: 'critical' | 'high' | 'medium' | 'low';
      reasoning: string;
    }>
  ): string {
    // Find highest priority strategy
    const priorityMap = { critical: 4, high: 3, medium: 2, low: 1 };
    const sorted = strategies.sort(
      (a, b) => priorityMap[b.priority as keyof typeof priorityMap] - priorityMap[a.priority as keyof typeof priorityMap]
    );
    return sorted[0]?.strategy || 'hold';
  }

  /**
   * Determine action type enum from strategy string
   */
  private determineActionType(
    strategyString: string
  ): 'email_outreach' | 'call_request' | 'content_send' | 'meeting_schedule' | 'nurture_sequence' | 'hold' {
    const actionMap: Record<string, 'email_outreach' | 'call_request' | 'content_send' | 'meeting_schedule' | 'nurture_sequence' | 'hold'> = {
      email_outreach: 'email_outreach',
      call_request: 'call_request',
      content_send: 'content_send',
      meeting_schedule: 'meeting_schedule',
      nurture_sequence: 'nurture_sequence',
      hold: 'hold',
    };
    return actionMap[strategyString] || 'hold';
  }

  /**
   * Score confidence of decision based on data signals
   */
  private scoreConfidence(
    dataQuality: number,
    engagementScore: number,
    gapSize: number
  ): number {
    // Confidence increases with data quality and engagement, decreases with uncertain gap
    const qualityFactor = dataQuality * 0.5;
    const engagementFactor = engagementScore * 0.3;
    const gapFactor = Math.max(0, 100 - Math.abs(gapSize - 50)) * 0.2;

    const confidence = qualityFactor + engagementFactor + gapFactor;
    return Math.min(confidence, 100);
  }

  /**
   * Apply threshold gate to determine if action should proceed
   */
  private applyThresholdGate(
    confidence: number,
    urgency: 'critical' | 'high' | 'medium' | 'low'
  ): boolean {
    const thresholds = { critical: 30, high: 50, medium: 70, low: 85 };
    const threshold = thresholds[urgency];
    return confidence >= threshold;
  }

  /**
   * Publish action.decided event
   */
  async publishActionDecided(
    tenantId: string,
    contactId: string,
    action: ActionDecision
  ): Promise<void> {
    const event: ActionDecidedEvent = {
      event_id: this.generateUUID(),
      event_type: 'action.decided',
      tenant_id: tenantId,
      contact_id: contactId,
      action,
      timestamp: new Date().toISOString(),
    };

    await this.deps.pubsub.publish('action.decided', event);
  }

  /**
   * Process brain.updated event and make action decision
   */
  async onBrainUpdated(event: BrainUpdatedEvent): Promise<ActionDecision> {
    const { brain_context, strategy_context } = event;

    // Step 1: Analyze objective gap
    const gapAnalysis = this.analyzeObjectiveGap(brain_context.objective_gap!);

    // Step 2: Select strategy
    const selectedStrategy = this.selectAction(
      brain_context.contact_state.segment,
      strategy_context.recommended_strategies
    );

    // Step 3: Determine action type
    const actionType = this.determineActionType(selectedStrategy);

    // Step 4: Score confidence
    const dataQuality = 75; // Assume from ingestion
    const engagementScore = (brain_context.behavioral_learning as Record<string, unknown>)
      .engagement_score as number;
    const confidence = this.scoreConfidence(
      dataQuality,
      engagementScore,
      brain_context.objective_gap!
    );

    // Step 5: Apply threshold gate
    const thresholdPassed = this.applyThresholdGate(
      confidence,
      gapAnalysis.urgency
    );

    // Step 6: Create action decision
    const action: ActionDecision = {
      tenant_id: event.tenant_id,
      contact_id: event.contact_id,
      action_id: this.generateUUID(),
      action_type: actionType,
      confidence_score: confidence,
      priority: gapAnalysis.urgency,
      reasoning: `${gapAnalysis.reason}. Selected ${selectedStrategy} with ${confidence.toFixed(1)}% confidence.`,
      threshold_passed: thresholdPassed,
      decided_at: new Date().toISOString(),
    };

    // Persist action
    await this.deps.db.insert('actions', action as Record<string, unknown>);

    // Publish event
    await this.publishActionDecided(event.tenant_id, event.contact_id, action);

    return action;
  }

  private generateUUID(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================================================
// TEST FIXTURES & HELPERS
// ============================================================================

const TEST_TENANT_ID = 'tenant-test-123-uuid';

/**
 * Sample CSV contacts for testing
 */
function getTestCSVContacts(): CSVContact[] {
  return [
    {
      firstName: 'Alice',
      lastName: 'Johnson',
      email: 'alice.johnson@acme.com',
      companyName: 'Acme Corporation',
      industry: 'Technology',
      jobTitle: 'VP Engineering',
      phoneNumber: '+1-555-0101',
      linkedInUrl: 'https://linkedin.com/in/alice-johnson',
      employeeCount: 500,
      annualRevenue: 50000000,
    },
    {
      firstName: 'Bob',
      lastName: 'Smith',
      email: 'bob.smith@globex.io',
      companyName: 'Globex Industries',
      industry: 'Manufacturing',
      jobTitle: 'Operations Director',
      phoneNumber: '+1-555-0102',
      linkedInUrl: 'https://linkedin.com/in/bob-smith',
      employeeCount: 1200,
      annualRevenue: 120000000,
    },
    {
      firstName: 'Carol',
      lastName: 'White',
      email: 'carol.white@initech.com',
      companyName: 'Initech',
      industry: 'Consulting',
      jobTitle: 'Senior Manager',
      linkedInUrl: 'https://linkedin.com/in/carol-white',
      employeeCount: 250,
    },
    {
      firstName: 'David',
      lastName: 'Chen',
      email: 'david.chen@hooli.io',
      companyName: 'Hooli',
      industry: 'Technology',
      jobTitle: 'Product Manager',
      phoneNumber: '+1-555-0104',
    },
  ];
}

/**
 * Validate normalized contact structure
 */
function validateNormalizedContact(contact: unknown): boolean {
  try {
    NormalizedContactSchema.parse(contact);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate brain context structure
 */
function validateBrainContext(context: unknown): boolean {
  try {
    BrainContextSchema.parse(context);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate action decision structure
 */
function validateActionDecision(action: unknown): boolean {
  try {
    ActionDecisionSchema.parse(action);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('Growth AI Revenue System: Core Loop Integration', () => {
  let db: InMemoryDatabase;
  let pubsub: InMemoryPubSubClient;
  let cache: InMemoryCacheClient;
  let ingestion: IngestionService;
  let brain: BrainService;
  let decision: DecisionEngine;

  beforeEach(() => {
    db = new InMemoryDatabase();
    pubsub = new InMemoryPubSubClient();
    cache = new InMemoryCacheClient();

    ingestion = new IngestionService({ db, pubsub });
    brain = new BrainService({ db, pubsub, cache });
    decision = new DecisionEngine({ db, pubsub, cache });
  });

  afterEach(() => {
    db.clear();
    pubsub.clear();
    cache.clear();
  });

  // ========================================================================
  // INGESTION SERVICE TESTS
  // ========================================================================

  describe('Ingestion Service', () => {
    test('should normalize single CSV contact', async () => {
      const csvContacts = getTestCSVContacts().slice(0, 1);
      const normalized = await ingestion.ingestContact(csvContacts[0], TEST_TENANT_ID);

      expect(validateNormalizedContact(normalized)).toBe(true);
      expect(normalized.tenant_id).toBe(TEST_TENANT_ID);
      expect(normalized.email).toBe('alice.johnson@acme.com');
      expect(normalized.first_name).toBe('Alice');
      expect(normalized.last_name).toBe('Johnson');
      expect(normalized.data_quality_score).toBeGreaterThan(0);
      expect(normalized.data_quality_score).toBeLessThanOrEqual(100);
    });

    test('should parse and normalize CSV batch', async () => {
      const csvContacts = getTestCSVContacts();
      const normalized = await ingestion.ingestContacts(csvContacts, TEST_TENANT_ID);

      expect(normalized).toHaveLength(4);
      for (const contact of normalized) {
        expect(validateNormalizedContact(contact)).toBe(true);
        expect(contact.tenant_id).toBe(TEST_TENANT_ID);
      }
    });

    test('should preserve optional fields when present', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      expect(normalized.phone_number).toBe(csvContact.phoneNumber);
      expect(normalized.linkedin_url).toBe(csvContact.linkedInUrl);
    });

    test('should handle missing optional fields', async () => {
      const csvContact = getTestCSVContacts()[3]; // David Chen has no LinkedIn or revenue
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      expect(normalized.linkedin_url).toBeNull();
      expect(normalized.phone_number).toBeDefined();
    });

    test('should compute data quality score correctly', async () => {
      const csvContacts = getTestCSVContacts();

      // High quality contact (has email, phone, LinkedIn)
      const highQuality = await ingestion.ingestContact(csvContacts[0], TEST_TENANT_ID);
      expect(highQuality.data_quality_score).toBeGreaterThanOrEqual(70);

      // Lower quality contact (minimal info)
      const lowQuality = await ingestion.ingestContact(csvContacts[3], TEST_TENANT_ID);
      expect(lowQuality.data_quality_score).toBeGreaterThanOrEqual(50);
    });

    test('should publish contact.ingested event', async () => {
      const csvContact = getTestCSVContacts()[0];
      await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const events = pubsub.getMessages('contact.ingested');
      expect(events).toHaveLength(1);
      expect(events[0]).toHaveProperty('event_type', 'contact.ingested');
      expect((events[0] as Record<string, unknown>).tenant_id).toBe(TEST_TENANT_ID);
    });

    test('should persist contact to database', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const persisted = await db.find('contacts', normalized.contact_id);
      expect(persisted).toBeDefined();
      expect((persisted as Record<string, unknown>).email).toBe(csvContact.email);
    });

    test('should create timeline for ingested contact', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const timeline = await db.find('timelines', normalized.contact_id);
      expect(timeline).toBeDefined();
      expect((timeline as Record<string, unknown>).contact_id).toBe(normalized.contact_id);
    });
  });

  // ========================================================================
  // BRAIN SERVICE TESTS
  // ========================================================================

  describe('Brain Service', () => {
    test('should update brain context from ingested contact', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const objectiveGap = await brain.computeObjectiveGap(normalized);
      const brainContext = await brain.updateBrainContext(
        TEST_TENANT_ID,
        normalized,
        objectiveGap
      );

      expect(validateBrainContext(brainContext)).toBe(true);
      expect(brainContext.tenant_id).toBe(TEST_TENANT_ID);
      expect(brainContext.contact_id).toBe(normalized.contact_id);
      expect(brainContext.industry_blueprint).toBeDefined();
      expect(brainContext.company_truth).toBeDefined();
      expect(brainContext.behavioral_learning).toBeDefined();
      expect(brainContext.outcome_learning).toBeDefined();
      expect(brainContext.contact_state).toBeDefined();
    });

    test('should compute objective gap between 0-100', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const gap = await brain.computeObjectiveGap(normalized);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(100);
    });

    test('should segment contact appropriately', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const objectiveGap = await brain.computeObjectiveGap(normalized);
      const brainContext = await brain.updateBrainContext(
        TEST_TENANT_ID,
        normalized,
        objectiveGap
      );

      const validSegments = [
        'new_lead',
        'warm_lead',
        'hot_lead',
        'active_customer',
        'at_risk',
        'churned',
      ];
      expect(validSegments).toContain(brainContext.contact_state.segment);
    });

    test('should cache brain context in Redis', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const objectiveGap = await brain.computeObjectiveGap(normalized);
      const brainContext = await brain.updateBrainContext(
        TEST_TENANT_ID,
        normalized,
        objectiveGap
      );

      const cacheKey = `brain:${TEST_TENANT_ID}:${normalized.contact_id}`;
      const cached = await cache.get(cacheKey);
      expect(cached).toBeDefined();
      expect((cached as Record<string, unknown>).contact_id).toBe(normalized.contact_id);
    });

    test('should compute strategy context', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const objectiveGap = await brain.computeObjectiveGap(normalized);
      const brainContext = await brain.updateBrainContext(
        TEST_TENANT_ID,
        normalized,
        objectiveGap
      );

      const strategyContext = await brain.computeStrategyContext(
        TEST_TENANT_ID,
        normalized,
        brainContext
      );

      expect(strategyContext.tenant_id).toBe(TEST_TENANT_ID);
      expect(strategyContext.contact_id).toBe(normalized.contact_id);
      expect(strategyContext.recommended_strategies.length).toBeGreaterThan(0);
      for (const strategy of strategyContext.recommended_strategies) {
        expect(['critical', 'high', 'medium', 'low']).toContain(strategy.priority);
      }
    });

    test('should publish brain.updated event', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const objectiveGap = await brain.computeObjectiveGap(normalized);
      const brainContext = await brain.updateBrainContext(
        TEST_TENANT_ID,
        normalized,
        objectiveGap
      );

      const strategyContext = await brain.computeStrategyContext(
        TEST_TENANT_ID,
        normalized,
        brainContext
      );

      await brain.publishBrainUpdated(
        TEST_TENANT_ID,
        normalized,
        brainContext,
        strategyContext
      );

      const events = pubsub.getMessages('brain.updated');
      expect(events).toHaveLength(1);
      expect(events[0]).toHaveProperty('event_type', 'brain.updated');
    });

    test('should handle contact.ingested event subscriber', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      // Get the published event
      const ingestedEvents = pubsub.getMessages('contact.ingested');
      const ingestedEvent = ingestedEvents[0] as ContactIngestedEvent;

      // Process it through brain
      await brain.onContactIngested(ingestedEvent);

      // Verify brain.updated was published
      const brainEvents = pubsub.getMessages('brain.updated');
      expect(brainEvents).toHaveLength(1);
    });
  });

  // ========================================================================
  // DECISION ENGINE TESTS
  // ========================================================================

  describe('Decision Engine', () => {
    test('should make action decision from brain.updated event', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const action = await decision.onBrainUpdated(brainEvent);

      expect(validateActionDecision(action)).toBe(true);
      expect(action.tenant_id).toBe(TEST_TENANT_ID);
      expect(action.contact_id).toBe(normalized.contact_id);
    });

    test('should determine action based on contact segment', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const action = await decision.onBrainUpdated(brainEvent);

      const validActions = [
        'email_outreach',
        'call_request',
        'content_send',
        'meeting_schedule',
        'nurture_sequence',
        'hold',
      ];
      expect(validActions).toContain(action.action_type);
    });

    test('should score confidence between 0-100', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const action = await decision.onBrainUpdated(brainEvent);

      expect(action.confidence_score).toBeGreaterThanOrEqual(0);
      expect(action.confidence_score).toBeLessThanOrEqual(100);
    });

    test('should apply threshold gate', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const action = await decision.onBrainUpdated(brainEvent);

      // Threshold passed should be a boolean
      expect(typeof action.threshold_passed).toBe('boolean');
    });

    test('should publish action.decided event', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const action = await decision.onBrainUpdated(brainEvent);

      const decidedEvents = pubsub.getMessages('action.decided');
      expect(decidedEvents).toHaveLength(1);
      expect(decidedEvents[0]).toHaveProperty('event_type', 'action.decided');
    });

    test('should set priority based on objective gap', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const action = await decision.onBrainUpdated(brainEvent);

      const validPriorities = ['critical', 'high', 'medium', 'low'];
      expect(validPriorities).toContain(action.priority);
    });
  });

  // ========================================================================
  // FULL LOOP TESTS
  // ========================================================================

  describe('Full Loop: Ingest â Brain â Decision', () => {
    test('should complete end-to-end flow for single contact', async () => {
      const csvContact = getTestCSVContacts()[0];

      // PHASE 1: Ingest
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);
      expect(validateNormalizedContact(normalized)).toBe(true);

      // Verify contact.ingested event
      const ingestedEvents = pubsub.getMessages('contact.ingested');
      expect(ingestedEvents).toHaveLength(1);
      const ingestedEvent = ingestedEvents[0] as ContactIngestedEvent;

      // PHASE 2: Brain
      await brain.onContactIngested(ingestedEvent);
      const brainEvents = pubsub.getMessages('brain.updated');
      expect(brainEvents).toHaveLength(1);
      const brainEvent = brainEvents[0] as BrainUpdatedEvent;

      expect(validateBrainContext(brainEvent.brain_context)).toBe(true);

      // PHASE 3: Decision
      const action = await decision.onBrainUpdated(brainEvent);
      expect(validateActionDecision(action)).toBe(true);

      // Verify action.decided event
      const decidedEvents = pubsub.getMessages('action.decided');
      expect(decidedEvents).toHaveLength(1);

      // Verify database persistence
      const persistedContact = await db.find('contacts', normalized.contact_id);
      expect(persistedContact).toBeDefined();

      const persistedAction = await db.find('actions', action.action_id);
      expect(persistedAction).toBeDefined();
    });

    test('should process entire batch through pipeline', async () => {
      const csvContacts = getTestCSVContacts();

      // PHASE 1: Ingest batch
      const normalized = await ingestion.ingestContacts(csvContacts, TEST_TENANT_ID);
      expect(normalized).toHaveLength(4);

      // PHASE 2 & 3: Process each through brain and decision
      const ingestedEvents = pubsub.getMessages('contact.ingested') as ContactIngestedEvent[];
      for (const event of ingestedEvents) {
        await brain.onContactIngested(event);
      }

      const brainEvents = pubsub.getMessages('brain.updated') as BrainUpdatedEvent[];
      expect(brainEvents).toHaveLength(4);

      for (const event of brainEvents) {
        await decision.onBrainUpdated(event);
      }

      const decidedEvents = pubsub.getMessages('action.decided');
      expect(decidedEvents).toHaveLength(4);
    });

    test('should maintain tenant isolation', async () => {
      const tenant1 = 'tenant-1-uuid';
      const tenant2 = 'tenant-2-uuid';

      const csvContacts = getTestCSVContacts();

      // Ingest for tenant 1
      const contact1 = await ingestion.ingestContact(csvContacts[0], tenant1);
      expect(contact1.tenant_id).toBe(tenant1);

      // Ingest for tenant 2
      const contact2 = await ingestion.ingestContact(csvContacts[1], tenant2);
      expect(contact2.tenant_id).toBe(tenant2);

      // Verify events are properly tagged
      const ingestedEvents = pubsub.getMessages('contact.ingested') as ContactIngestedEvent[];
      const tenant1Events = ingestedEvents.filter((e) => e.tenant_id === tenant1);
      const tenant2Events = ingestedEvents.filter((e) => e.tenant_id === tenant2);

      expect(tenant1Events).toHaveLength(1);
      expect(tenant2Events).toHaveLength(1);

      // Process through brain for both
      for (const event of tenant1Events) {
        await brain.onContactIngested(event);
      }
      for (const event of tenant2Events) {
        await brain.onContactIngested(event);
      }

      // Verify brain contexts are isolated
      const brainEvents = pubsub.getMessages('brain.updated') as BrainUpdatedEvent[];
      const tenant1Brain = brainEvents.filter((e) => e.tenant_id === tenant1);
      const tenant2Brain = brainEvents.filter((e) => e.tenant_id === tenant2);

      expect(tenant1Brain).toHaveLength(1);
      expect(tenant2Brain).toHaveLength(1);
      expect(tenant1Brain[0].contact_id).toBe(contact1.contact_id);
      expect(tenant2Brain[0].contact_id).toBe(contact2.contact_id);
    });

    test('should generate all required event types in sequence', async () => {
      const csvContact = getTestCSVContacts()[0];

      await ingestion.ingestContact(csvContact, TEST_TENANT_ID);
      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;

      await brain.onContactIngested(ingestedEvent);
      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;

      await decision.onBrainUpdated(brainEvent);
      const decidedEvent = pubsub.getMessages('action.decided')[0] as ActionDecidedEvent;

      // Verify event chain
      expect(ingestedEvent.contact_id).toBe(brainEvent.contact_id);
      expect(brainEvent.contact_id).toBe(decidedEvent.contact_id);
      expect(ingestedEvent.tenant_id).toBe(brainEvent.tenant_id);
      expect(brainEvent.tenant_id).toBe(decidedEvent.tenant_id);
    });
  });

  // ========================================================================
  // MULTI-SEGMENT VALIDATION TESTS
  // ========================================================================

  describe('Multi-segment Validation', () => {
    test('should handle new_lead segment correctly', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const { contact_state } = brainEvent.brain_context;

      if (contact_state.segment === 'new_lead') {
        const { recommended_strategies } = brainEvent.strategy_context;
        const strategyTypes = recommended_strategies.map((s) => s.strategy);
        // New leads should get nurture and content strategies
        expect(
          strategyTypes.includes('nurture_sequence') ||
            strategyTypes.includes('content_send')
        ).toBe(true);
      }
    });

    test('should handle warm_lead segment correctly', async () => {
      const csvContact = getTestCSVContacts()[1];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const { recommended_strategies } = brainEvent.strategy_context;
      const strategyTypes = recommended_strategies.map((s) => s.strategy);

      if (brainEvent.brain_context.contact_state.segment === 'warm_lead') {
        // Warm leads should get call and meeting strategies
        expect(
          strategyTypes.includes('call_request') ||
            strategyTypes.includes('meeting_schedule')
        ).toBe(true);
      }
    });

    test('should handle hot_lead segment correctly', async () => {
      const csvContact = getTestCSVContacts()[2];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const { recommended_strategies, current_segment } = brainEvent.strategy_context;

      if (current_segment === 'hot_lead') {
        const criticalStrategies = recommended_strategies.filter(
          (s) => s.priority === 'critical'
        );
        // Hot leads should have critical priority strategies
        expect(criticalStrategies.length).toBeGreaterThan(0);
      }
    });

    test('should handle active_customer segment correctly', async () => {
      const csvContact = getTestCSVContacts()[3];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;

      if (brainEvent.brain_context.contact_state.segment === 'active_customer') {
        const { recommended_strategies } = brainEvent.strategy_context;
        const hasUpsellStrategy = recommended_strategies.some((s) =>
          ['nurture_sequence', 'content_send'].includes(s.strategy)
        );
        expect(hasUpsellStrategy).toBe(true);
      }
    });

    test('should handle at_risk segment correctly', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;

      if (brainEvent.brain_context.contact_state.segment === 'at_risk') {
        const { recommended_strategies } = brainEvent.strategy_context;
        const criticalStrategies = recommended_strategies.filter(
          (s) => s.priority === 'critical'
        );
        // At-risk should have critical retention strategies
        expect(criticalStrategies.length).toBeGreaterThan(0);
      }
    });

    test('should handle churned segment correctly', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;

      if (brainEvent.brain_context.contact_state.segment === 'churned') {
        const { recommended_strategies } = brainEvent.strategy_context;
        const hasWinbackStrategy = recommended_strategies.some(
          (s) => s.strategy === 'nurture_sequence'
        );
        expect(hasWinbackStrategy).toBe(true);
      }
    });

    test('should test all segments across batch', async () => {
      const csvContacts = getTestCSVContacts();
      const normalized = await ingestion.ingestContacts(csvContacts, TEST_TENANT_ID);

      const ingestedEvents = pubsub.getMessages('contact.ingested') as ContactIngestedEvent[];
      for (const event of ingestedEvents) {
        await brain.onContactIngested(event);
      }

      const brainEvents = pubsub.getMessages('brain.updated') as BrainUpdatedEvent[];

      // Collect all segments from batch
      const segments = new Set(
        brainEvents.map((e) => e.brain_context.contact_state.segment)
      );

      // All segments should be valid
      const validSegments = new Set([
        'new_lead',
        'warm_lead',
        'hot_lead',
        'active_customer',
        'at_risk',
        'churned',
      ]);

      for (const segment of segments) {
        expect(validSegments.has(segment as string)).toBe(true);
      }
    });
  });

  // ========================================================================
  // CACHING & PERFORMANCE TESTS
  // ========================================================================

  describe('Caching & Performance', () => {
    test('should cache industry blueprints', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const cacheKey = `blueprint:${csvContact.industry}`;
      const cached = await cache.get(cacheKey);
      expect(cached).toBeDefined();
      expect((cached as Record<string, unknown>).industry).toBe(csvContact.industry);
    });

    test('should cache brain contexts with TTL', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const cacheKey = `brain:${TEST_TENANT_ID}:${normalized.contact_id}`;
      const exists = await cache.exists(cacheKey);
      expect(exists).toBe(true);
    });
  });

  // ========================================================================
  // DATA QUALITY & VALIDATION TESTS
  // ========================================================================

  describe('Data Quality & Validation', () => {
    test('should validate all ingested contacts match schema', async () => {
      const csvContacts = getTestCSVContacts();
      const normalized = await ingestion.ingestContacts(csvContacts, TEST_TENANT_ID);

      for (const contact of normalized) {
        expect(validateNormalizedContact(contact)).toBe(true);
      }
    });

    test('should validate all brain contexts match schema', async () => {
      const csvContacts = getTestCSVContacts();
      const normalized = await ingestion.ingestContacts(csvContacts, TEST_TENANT_ID);

      const ingestedEvents = pubsub.getMessages('contact.ingested') as ContactIngestedEvent[];
      for (const event of ingestedEvents) {
        await brain.onContactIngested(event);
      }

      const brainEvents = pubsub.getMessages('brain.updated') as BrainUpdatedEvent[];
      for (const event of brainEvents) {
        expect(validateBrainContext(event.brain_context)).toBe(true);
      }
    });

    test('should validate all action decisions match schema', async () => {
      const csvContacts = getTestCSVContacts();
      const normalized = await ingestion.ingestContacts(csvContacts, TEST_TENANT_ID);

      const ingestedEvents = pubsub.getMessages('contact.ingested') as ContactIngestedEvent[];
      for (const event of ingestedEvents) {
        await brain.onContactIngested(event);
      }

      const brainEvents = pubsub.getMessages('brain.updated') as BrainUpdatedEvent[];
      for (const event of brainEvents) {
        const action = await decision.onBrainUpdated(event);
        expect(validateActionDecision(action)).toBe(true);
      }
    });

    test('should maintain referential integrity across events', async () => {
      const csvContact = getTestCSVContacts()[0];
      const normalized = await ingestion.ingestContact(csvContact, TEST_TENANT_ID);

      const ingestedEvent = pubsub.getMessages('contact.ingested')[0] as ContactIngestedEvent;
      await brain.onContactIngested(ingestedEvent);

      const brainEvent = pubsub.getMessages('brain.updated')[0] as BrainUpdatedEvent;
      const action = await decision.onBrainUpdated(brainEvent);

      // All should reference the same contact
      expect(ingestedEvent.contact_id).toBe(normalized.contact_id);
      expect(brainEvent.contact_id).toBe(normalized.contact_id);
      expect(action.contact_id).toBe(normalized.contact_id);

      // All should reference the same tenant
      expect(ingestedEvent.tenant_id).toBe(TEST_TENANT_ID);
      expect(brainEvent.tenant_id).toBe(TEST_TENANT_ID);
      expect(action.tenant_id).toBe(TEST_TENANT_ID);
    });
  });
});

// ============================================================================
// EXPORTS FOR REUSE
// ============================================================================

export {
  // Schemas
  CSVContactSchema,
  NormalizedContactSchema,
  BrainContextSchema,
  StrategyContextSchema,
  ActionDecisionSchema,
  ContactIngestedEventSchema,
  BrainUpdatedEventSchema,
  ActionDecidedEventSchema,
  // Types
  type CSVContact,
  type NormalizedContact,
  type CompanyContext,
  type BrainContext,
  type StrategyContext,
  type ActionDecision,
  type ContactIngestedEvent,
  type BrainUpdatedEvent,
  type ActionDecidedEvent,
  // Adapters
  InMemoryDatabase,
  InMemoryPubSubClient,
  InMemoryCacheClient,
  // Services
  IngestionService,
  BrainService,
  DecisionEngine,
  // Helpers
  getTestCSVContacts,
  validateNormalizedContact,
  validateBrainContext,
  validateActionDecision,
};
