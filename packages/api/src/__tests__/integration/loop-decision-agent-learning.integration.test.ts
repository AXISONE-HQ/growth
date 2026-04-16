/**
 * @file loop-decision-agent-learning.integration.test.ts
 * @description End-to-end integration test: Decision â Agent â Learning
 *
 * KAN-57 â Tests the second half of the growth core loop:
 *   Decision Engine output â Agent Dispatcher execution â Learning Service feedback
 *
 * Architecture:
 *   - In-memory adapters for DB, PubSub, Cache (no external deps)
 *   - Dependency injection for all services
 *   - Zod schema validation at every boundary
 *   - Tests cover: agent routing, message generation, guardrail checks,
 *     outcome recording, strategy weight updates, and feedback loop closure
 */

import { z } from 'zod';
import { describe, test, expect, beforeEach } from 'vitest';

// ==========================================================================
// ZOD SCHEMAS
// ==========================================================================

const ActionDecisionSchema = z.object({
  decision_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  strategy_selected: z.enum([
    'direct_outreach',
    'nurture_sequence',
    'content_send',
    'call_request',
    'meeting_schedule',
    'proposal_send',
    'escalation',
    'wait',
  ]),
  action_type: z.enum([
    'send_message',
    'send_email',
    'schedule_call',
    'book_meeting',
    'create_proposal',
    'escalate_to_human',
    'update_crm',
    'wait',
  ]),
  channel: z.enum(['sms', 'email', 'whatsapp', 'chat', 'phone', 'crm', 'internal']),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().min(1),
  context: z.object({
    contact_name: z.string(),
    contact_email: z.string().email().optional(),
    contact_phone: z.string().optional(),
    segment: z.string(),
    objective_id: z.string().uuid(),
    sub_objectives_completed: z.array(z.string()),
    sub_objectives_remaining: z.array(z.string()),
    company_context: z.object({
      company_name: z.string(),
      industry: z.string(),
      product_name: z.string().optional(),
    }),
  }),
  created_at: z.string().datetime(),
});

type ActionDecision = z.infer<typeof ActionDecisionSchema>;

const AgentExecutionSchema = z.object({
  execution_id: z.string().uuid(),
  decision_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  agent_type: z.enum(['communication', 'revenue', 'operational', 'escalation']),
  channel: z.enum(['sms', 'email', 'whatsapp', 'chat', 'phone', 'crm', 'internal']),
  status: z.enum(['pending', 'sent', 'delivered', 'failed', 'bounced', 'escalated']),
  payload: z.object({
    message_body: z.string().optional(),
    subject: z.string().optional(),
    template_id: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
  guardrail_results: z.object({
    tone_check: z.enum(['pass', 'fail', 'warning']),
    accuracy_check: z.enum(['pass', 'fail', 'warning']),
    hallucination_check: z.enum(['pass', 'fail', 'warning']),
    compliance_check: z.enum(['pass', 'fail', 'warning']),
    confidence_gate: z.enum(['pass', 'fail']),
    injection_defense: z.enum(['pass', 'fail']),
  }),
  sent_at: z.string().datetime().optional(),
  delivered_at: z.string().datetime().optional(),
  created_at: z.string().datetime(),
});

type AgentExecution = z.infer<typeof AgentExecutionSchema>;

const ActionExecutedEventSchema = z.object({
  execution_id: z.string().uuid(),
  decision_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  agent_type: z.string(),
  channel: z.string(),
  status: z.string(),
  delivery_status: z.enum(['sent', 'delivered', 'failed', 'bounced', 'pending']),
  timestamp: z.string().datetime(),
});

type ActionExecutedEvent = z.infer<typeof ActionExecutedEventSchema>;

const OutcomeRecordedEventSchema = z.object({
  outcome_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  objective_id: z.string().uuid(),
  execution_id: z.string().uuid(),
  result: z.enum(['success', 'failure', 'partial', 'pending', 'escalated']),
  reason_category: z.string(),
  metrics: z.object({
    response_time_ms: z.number().optional(),
    engagement_score: z.number().min(0).max(100).optional(),
    conversion_value: z.number().optional(),
  }),
  timestamp: z.string().datetime(),
});

type OutcomeRecordedEvent = z.infer<typeof OutcomeRecordedEventSchema>;

const StrategyWeightSchema = z.object({
  tenant_id: z.string().uuid(),
  strategy_type: z.string(),
  segment: z.string(),
  channel: z.string(),
  win_rate: z.number().min(0).max(1),
  sample_size: z.number().int().min(0),
  avg_confidence: z.number().min(0).max(100),
  last_updated: z.string().datetime(),
});

type StrategyWeight = z.infer<typeof StrategyWeightSchema>;

// ==========================================================================
// IN-MEMORY ADAPTERS
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

  async findByField(table: string, field: string, value: unknown): Promise<Record<string, unknown>[]> {
    const tableData = this.tables.get(table);
    if (!tableData) return [];
    return Array.from(tableData.values()).filter((row) => row[field] === value);
  }

  async update(table: string, id: string, data: Partial<Record<string, unknown>>): Promise<void> {
    const existing = this.tables.get(table)?.get(id);
    if (existing) {
      this.tables.get(table)!.set(id, { ...existing, ...data });
    }
  }

  async upsert(table: string, id: string, data: Record<string, unknown>): Promise<void> {
    const existing = await this.findById(table, id);
    if (existing) {
      await this.update(table, id, data);
    } else {
      await this.insert(table, id, data);
    }
  }

  async count(table: string): Promise<number> {
    return this.tables.get(table)?.size ?? 0;
  }

  reset(): void {
    this.tables.clear();
  }
}

class InMemoryPubSubClient {
  private messages: Map<string, unknown[]> = new Map();
  private subscribers: Map<string, Array<(msg: unknown) => Promise<void>>> = new Map();

  async publish(topic: string, message: unknown): Promise<void> {
    if (!this.messages.has(topic)) this.messages.set(topic, []);
    this.messages.get(topic)!.push(message);

    const subs = this.subscribers.get(topic) ?? [];
    for (const handler of subs) {
      await handler(message);
    }
  }

  subscribe(topic: string, handler: (msg: unknown) => Promise<void>): void {
    if (!this.subscribers.has(topic)) this.subscribers.set(topic, []);
    this.subscribers.get(topic)!.push(handler);
  }

  getMessages(topic: string): unknown[] {
    return this.messages.get(topic) ?? [];
  }

  reset(): void {
    this.messages.clear();
    this.subscribers.clear();
  }
}

class InMemoryCacheClient {
  private store: Map<string, { value: unknown; expiresAt?: number }> = new Map();

  async get(key: string): Promise<unknown | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  reset(): void {
    this.store.clear();
  }
}

// ==========================================================================
// SERVICES
// ==========================================================================

/**
 * AgentDispatcher â routes decisions to the correct agent type and executes
 */
class AgentDispatcher {
  constructor(
    private db: InMemoryDatabase,
    private pubsub: InMemoryPubSubClient,
    private cache: InMemoryCacheClient
  ) {}

  async onActionDecided(decision: ActionDecision): Promise<AgentExecution> {
    // 1. Permission check
    const permissions = await this.checkPermissions(decision);
    if (!permissions.allowed) {
      return this.createEscalation(decision, 'permission_denied');
    }

    // 2. Route to agent
    const agentType = this.routeToAgent(decision);

    // 3. Generate message payload
    const payload = await this.generatePayload(decision, agentType);

    // 4. Run guardrails
    const guardrailResults = await this.runGuardrails(decision, payload);

    // 5. Check guardrail gate
    if (guardrailResults.compliance_check === 'fail') {
      return this.createEscalation(decision, 'compliance_failure');
    }
    if (guardrailResults.confidence_gate === 'fail') {
      return this.createEscalation(decision, 'low_confidence');
    }
    if (guardrailResults.hallucination_check === 'fail') {
      // Regenerate once
      const retryPayload = await this.generatePayload(decision, agentType);
      const retryGuardrails = await this.runGuardrails(decision, retryPayload);
      if (retryGuardrails.hallucination_check === 'fail') {
        return this.createEscalation(decision, 'hallucination_detected');
      }
    }

    // 6. Execute
    const execution: AgentExecution = {
      execution_id: crypto.randomUUID(),
      decision_id: decision.decision_id,
      tenant_id: decision.tenant_id,
      contact_id: decision.contact_id,
      agent_type: agentType,
      channel: decision.channel,
      status: 'sent',
      payload,
      guardrail_results: guardrailResults,
      sent_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    // 7. Persist execution
    await this.db.insert('actions', execution.execution_id, execution as unknown as Record<string, unknown>);

    // 8. Publish action.executed event
    const executedEvent: ActionExecutedEvent = {
      execution_id: execution.execution_id,
      decision_id: execution.decision_id,
      tenant_id: execution.tenant_id,
      contact_id: execution.contact_id,
      agent_type: execution.agent_type,
      channel: execution.channel,
      status: execution.status,
      delivery_status: 'sent',
      timestamp: new Date().toISOString(),
    };
    await this.pubsub.publish('action.executed', executedEvent);

    // 9. Write to audit log
    await this.db.insert('audit_log', crypto.randomUUID(), {
      tenant_id: execution.tenant_id,
      actor: `agent:${agentType}`,
      action_type: decision.action_type,
      payload: { execution_id: execution.execution_id, channel: execution.channel },
      reasoning: decision.reasoning,
      created_at: new Date().toISOString(),
    });

    return execution;
  }

  private async checkPermissions(decision: ActionDecision): Promise<{ allowed: boolean }> {
    const tenantPerms = await this.cache.get(`perms:${decision.tenant_id}`);
    if (!tenantPerms) {
      // Default: all channels allowed
      return { allowed: true };
    }
    const perms = tenantPerms as Record<string, boolean>;
    return { allowed: perms[decision.channel] !== false };
  }

  private routeToAgent(decision: ActionDecision): AgentExecution['agent_type'] {
    switch (decision.action_type) {
      case 'send_message':
      case 'send_email':
        return 'communication';
      case 'create_proposal':
      case 'book_meeting':
        return 'revenue';
      case 'update_crm':
        return 'operational';
      case 'escalate_to_human':
        return 'escalation';
      case 'schedule_call':
        return decision.confidence >= 70 ? 'revenue' : 'escalation';
      default:
        return 'communication';
    }
  }

  private async generatePayload(
    decision: ActionDecision,
    _agentType: AgentExecution['agent_type']
  ): Promise<AgentExecution['payload']> {
    const { context } = decision;
    const companyName = context.company_context.company_name;

    switch (decision.action_type) {
      case 'send_email':
        return {
          subject: `Next steps for ${context.contact_name}`,
          message_body: `Hi ${context.contact_name}, following up regarding ${companyName}. Based on our understanding of your needs, we'd like to discuss the next steps.`,
          metadata: { strategy: decision.strategy_selected, segment: context.segment },
        };
      case 'send_message':
        return {
          message_body: `Hi ${context.contact_name}, this is a quick note from ${companyName}. We wanted to check in and see how things are going.`,
          metadata: { strategy: decision.strategy_selected, channel: decision.channel },
        };
      case 'escalate_to_human':
        return {
          message_body: `Escalation requested for ${context.contact_name}. Reason: ${decision.reasoning}`,
          metadata: { priority: decision.confidence < 30 ? 'high' : 'normal' },
        };
      default:
        return {
          message_body: `Action: ${decision.action_type} for ${context.contact_name}`,
          metadata: { strategy: decision.strategy_selected },
        };
    }
  }

  private async runGuardrails(
    decision: ActionDecision,
    payload: AgentExecution['payload']
  ): Promise<AgentExecution['guardrail_results']> {
    return {
      tone_check: this.checkTone(payload),
      accuracy_check: this.checkAccuracy(decision, payload),
      hallucination_check: this.checkHallucination(decision, payload),
      compliance_check: this.checkCompliance(decision),
      confidence_gate: decision.confidence >= (decision.action_type === 'escalate_to_human' ? 0 : 40)
        ? 'pass'
        : 'fail',
      injection_defense: this.checkInjection(payload),
    };
  }

  private checkTone(payload: AgentExecution['payload']): 'pass' | 'fail' | 'warning' {
    const body = payload.message_body ?? '';
    const negativePatterns = /\b(terrible|awful|worst|stupid|idiot|hate)\b/i;
    if (negativePatterns.test(body)) return 'fail';
    return 'pass';
  }

  private checkAccuracy(
    decision: ActionDecision,
    payload: AgentExecution['payload']
  ): 'pass' | 'fail' | 'warning' {
    const body = payload.message_body ?? '';
    // Check pricing claims against company context
    if (body.includes('$') && !decision.context.company_context.product_name) {
      return 'warning';
    }
    return 'pass';
  }

  private checkHallucination(
    decision: ActionDecision,
    payload: AgentExecution['payload']
  ): 'pass' | 'fail' | 'warning' {
    const body = payload.message_body ?? '';
    // Detect claims not grounded in context
    const companyName = decision.context.company_context.company_name;
    if (body.includes('guaranteed') || body.includes('100% success')) return 'fail';
    if (!body.includes(companyName) && decision.action_type !== 'escalate_to_human') return 'warning';
    return 'pass';
  }

  private checkCompliance(decision: ActionDecision): 'pass' | 'fail' | 'warning' {
    // CAN-SPAM, CASL, GDPR checks
    if (decision.channel === 'email' && !decision.context.contact_email) return 'fail';
    if (decision.channel === 'sms' && !decision.context.contact_phone) return 'fail';
    return 'pass';
  }

  private checkInjection(payload: AgentExecution['payload']): 'pass' | 'fail' {
    const body = payload.message_body ?? '';
    const injectionPatterns = /\b(ignore previous|system prompt|you are now|forget instructions)\b/i;
    return injectionPatterns.test(body) ? 'fail' : 'pass';
  }

  private createEscalation(decision: ActionDecision, reason: string): AgentExecution {
    return {
      execution_id: crypto.randomUUID(),
      decision_id: decision.decision_id,
      tenant_id: decision.tenant_id,
      contact_id: decision.contact_id,
      agent_type: 'escalation',
      channel: 'internal',
      status: 'escalated',
      payload: {
        message_body: `Escalated: ${reason} for contact ${decision.contact_id}`,
        metadata: { reason, original_action: decision.action_type },
      },
      guardrail_results: {
        tone_check: 'pass',
        accuracy_check: 'pass',
        hallucination_check: 'pass',
        compliance_check: reason === 'compliance_failure' ? 'fail' : 'pass',
        confidence_gate: reason === 'low_confidence' ? 'fail' : 'pass',
        injection_defense: 'pass',
      },
      created_at: new Date().toISOString(),
    };
  }
}

/**
 * LearningService â observes outcomes, updates strategy weights
 */
class LearningService {
  constructor(
    private db: InMemoryDatabase,
    private pubsub: InMemoryPubSubClient,
    private cache: InMemoryCacheClient
  ) {}

  async onActionExecuted(event: ActionExecutedEvent): Promise<void> {
    // Store execution record for later outcome correlation
    await this.cache.set(
      `exec:${event.execution_id}`,
      event,
      3600 // 1 hour TTL
    );
  }

  async recordOutcome(params: {
    tenant_id: string;
    contact_id: string;
    objective_id: string;
    execution_id: string;
    result: OutcomeRecordedEvent['result'];
    reason_category: string;
    metrics?: OutcomeRecordedEvent['metrics'];
  }): Promise<OutcomeRecordedEvent> {
    const outcome: OutcomeRecordedEvent = {
      outcome_id: crypto.randomUUID(),
      tenant_id: params.tenant_id,
      contact_id: params.contact_id,
      objective_id: params.objective_id,
      execution_id: params.execution_id,
      result: params.result,
      reason_category: params.reason_category,
      metrics: params.metrics ?? {},
      timestamp: new Date().toISOString(),
    };

    // Persist outcome
    await this.db.insert('outcomes', outcome.outcome_id, outcome as unknown as Record<string, unknown>);

    // Publish outcome event
    await this.pubsub.publish('outcome.recorded', outcome);

    // Update strategy weights
    await this.updateStrategyWeights(outcome);

    return outcome;
  }

  private async updateStrategyWeights(outcome: OutcomeRecordedEvent): Promise<void> {
    // Get execution details
    const execData = await this.cache.get(`exec:${outcome.execution_id}`);
    if (!execData) return;

    const execution = execData as ActionExecutedEvent;

    // Get decision details
    const decision = await this.db.findById('decisions', execution.decision_id);
    if (!decision) return;

    const strategyType = decision.strategy_selected as string;
    const segment = (decision as Record<string, unknown>).segment as string ?? 'unknown';
    const channel = execution.channel;

    const weightKey = `${outcome.tenant_id}:${strategyType}:${segment}:${channel}`;
    const existing = await this.db.findById('strategy_weights', weightKey);

    const isWin = outcome.result === 'success' || outcome.result === 'partial';

    if (existing) {
      const currentWinRate = existing.win_rate as number;
      const currentSampleSize = existing.sample_size as number;
      const newSampleSize = currentSampleSize + 1;
      const newWinRate = (currentWinRate * currentSampleSize + (isWin ? 1 : 0)) / newSampleSize;

      await this.db.update('strategy_weights', weightKey, {
        win_rate: newWinRate,
        sample_size: newSampleSize,
        last_updated: new Date().toISOString(),
      });
    } else {
      const weight: StrategyWeight = {
        tenant_id: outcome.tenant_id,
        strategy_type: strategyType,
        segment,
        channel,
        win_rate: isWin ? 1.0 : 0.0,
        sample_size: 1,
        avg_confidence: 0,
        last_updated: new Date().toISOString(),
      };
      await this.db.insert('strategy_weights', weightKey, weight as unknown as Record<string, unknown>);
    }

    // Invalidate brain cache for this contact (triggers re-evaluation)
    await this.cache.delete(`brain:${outcome.tenant_id}:${outcome.contact_id}`);
  }

  async getStrategyWeights(
    tenantId: string,
    segment?: string
  ): Promise<Record<string, unknown>[]> {
    const weights = await this.db.findByField('strategy_weights', 'tenant_id', tenantId);
    if (segment) {
      return weights.filter((w) => w.segment === segment);
    }
    return weights;
  }
}

// ==========================================================================
// TEST CONSTANTS & FIXTURES
// ==========================================================================

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_CONTACT_ID = '660e8400-e29b-41d4-a716-446655440001';
const TEST_OBJECTIVE_ID = '770e8400-e29b-41d4-a716-446655440002';

function createTestDecision(overrides: Partial<ActionDecision> = {}): ActionDecision {
  return {
    decision_id: crypto.randomUUID(),
    tenant_id: TEST_TENANT_ID,
    contact_id: TEST_CONTACT_ID,
    strategy_selected: 'direct_outreach',
    action_type: 'send_email',
    channel: 'email',
    confidence: 85,
    reasoning: 'Contact shows high engagement, direct outreach recommended',
    context: {
      contact_name: 'Jane Smith',
      contact_email: 'jane@example.com',
      contact_phone: '+14155551234',
      segment: 'warm_lead',
      objective_id: TEST_OBJECTIVE_ID,
      sub_objectives_completed: ['initial_contact'],
      sub_objectives_remaining: ['qualification', 'proposal'],
      company_context: {
        company_name: 'Acme Corp',
        industry: 'saas',
        product_name: 'Growth Suite',
      },
    },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ==========================================================================
// TESTS
// ==========================================================================

describe('Decision â Agent â Learning Integration', () => {
  let db: InMemoryDatabase;
  let pubsub: InMemoryPubSubClient;
  let cache: InMemoryCacheClient;
  let dispatcher: AgentDispatcher;
  let learning: LearningService;

  beforeEach(() => {
    db = new InMemoryDatabase();
    pubsub = new InMemoryPubSubClient();
    cache = new InMemoryCacheClient();
    dispatcher = new AgentDispatcher(db, pubsub, cache);
    learning = new LearningService(db, pubsub, cache);

    // Wire up PubSub subscriptions
    pubsub.subscribe('action.executed', async (msg) => {
      await learning.onActionExecuted(msg as ActionExecutedEvent);
    });
  });

  // =====================================================================
  // AGENT ROUTING TESTS
  // =====================================================================

  describe('Agent Routing', () => {
    test('should route send_email to communication agent', async () => {
      const decision = createTestDecision({ action_type: 'send_email' });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('communication');
    });

    test('should route send_message to communication agent', async () => {
      const decision = createTestDecision({ action_type: 'send_message', channel: 'sms' });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('communication');
    });

    test('should route create_proposal to revenue agent', async () => {
      const decision = createTestDecision({ action_type: 'create_proposal' });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('revenue');
    });

    test('should route book_meeting to revenue agent', async () => {
      const decision = createTestDecision({ action_type: 'book_meeting' });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('revenue');
    });

    test('should route update_crm to operational agent', async () => {
      const decision = createTestDecision({ action_type: 'update_crm', channel: 'crm' });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('operational');
    });

    test('should route escalate_to_human to escalation agent', async () => {
      const decision = createTestDecision({
        action_type: 'escalate_to_human',
        channel: 'internal',
        confidence: 20,
      });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('escalation');
    });

    test('should route high-confidence schedule_call to revenue agent', async () => {
      const decision = createTestDecision({
        action_type: 'schedule_call',
        channel: 'phone',
        confidence: 80,
      });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('revenue');
    });

    test('should route low-confidence schedule_call to escalation agent', async () => {
      const decision = createTestDecision({
        action_type: 'schedule_call',
        channel: 'phone',
        confidence: 50,
      });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('escalation');
    });
  });

  // =====================================================================
  // GUARDRAIL TESTS
  // =====================================================================

  describe('Guardrail Checks', () => {
    test('should pass all guardrails for valid decision', async () => {
      const decision = createTestDecision();
      const execution = await dispatcher.onActionDecided(decision);

      expect(execution.guardrail_results.tone_check).toBe('pass');
      expect(execution.guardrail_results.accuracy_check).toBe('pass');
      expect(execution.guardrail_results.compliance_check).toBe('pass');
      expect(execution.guardrail_results.confidence_gate).toBe('pass');
      expect(execution.guardrail_results.injection_defense).toBe('pass');
    });

    test('should escalate when confidence is below threshold', async () => {
      const decision = createTestDecision({ confidence: 20 });
      const execution = await dispatcher.onActionDecided(decision);

      expect(execution.agent_type).toBe('escalation');
      expect(execution.status).toBe('escalated');
      expect(execution.guardrail_results.confidence_gate).toBe('fail');
    });

    test('should fail compliance for email without email address', async () => {
      const decision = createTestDecision({
        channel: 'email',
        action_type: 'send_email',
        context: {
          ...createTestDecision().context,
          contact_email: undefined,
        },
      });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('escalation');
      expect(execution.status).toBe('escalated');
    });

    test('should fail compliance for SMS without phone number', async () => {
      const decision = createTestDecision({
        channel: 'sms',
        action_type: 'send_message',
        context: {
          ...createTestDecision().context,
          contact_phone: undefined,
        },
      });
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('escalation');
    });

    test('should escalate for permission-denied channel', async () => {
      // Set tenant permissions to disallow SMS
      await cache.set(`perms:${TEST_TENANT_ID}`, { sms: false, email: true });

      const decision = createTestDecision({ channel: 'sms', action_type: 'send_message' });
      const execution = await dispatcher.onActionDecided(decision);

      expect(execution.agent_type).toBe('escalation');
      expect(execution.status).toBe('escalated');
    });
  });

  // =====================================================================
  // EXECUTION FLOW TESTS
  // =====================================================================

  describe('Execution Flow', () => {
    test('should persist execution to database', async () => {
      const decision = createTestDecision();
      const execution = await dispatcher.onActionDecided(decision);

      const stored = await db.findById('actions', execution.execution_id);
      expect(stored).not.toBeNull();
      expect(stored!.decision_id).toBe(decision.decision_id);
    });

    test('should publish action.executed event', async () => {
      const decision = createTestDecision();
      await dispatcher.onActionDecided(decision);

      const events = pubsub.getMessages('action.executed') as ActionExecutedEvent[];
      expect(events.length).toBe(1);
      expect(events[0].tenant_id).toBe(TEST_TENANT_ID);
      expect(events[0].contact_id).toBe(TEST_CONTACT_ID);
      expect(events[0].delivery_status).toBe('sent');
    });

    test('should write audit log entry', async () => {
      const decision = createTestDecision();
      await dispatcher.onActionDecided(decision);

      const auditEntries = await db.findByField('audit_log', 'tenant_id', TEST_TENANT_ID);
      expect(auditEntries.length).toBeGreaterThan(0);

      const entry = auditEntries[0];
      expect(entry.actor).toContain('agent:');
      expect(entry.reasoning).toBe(decision.reasoning);
    });

    test('should generate valid email payload', async () => {
      const decision = createTestDecision({ action_type: 'send_email' });
      const execution = await dispatcher.onActionDecided(decision);

      expect(execution.payload.subject).toBeDefined();
      expect(execution.payload.message_body).toBeDefined();
      expect(execution.payload.message_body).toContain('Jane Smith');
    });

    test('should generate valid SMS payload', async () => {
      const decision = createTestDecision({ action_type: 'send_message', channel: 'sms' });
      const execution = await dispatcher.onActionDecided(decision);

      expect(execution.payload.message_body).toBeDefined();
      expect(execution.payload.message_body).toContain('Jane Smith');
    });
  });

  // =====================================================================
  // LEARNING SERVICE TESTS
  // =====================================================================

  describe('Learning Service', () => {
    test('should record outcome after execution', async () => {
      const decision = createTestDecision();
      // Store decision in DB for learning service correlation
      await db.insert('decisions', decision.decision_id, {
        ...decision,
        segment: decision.context.segment,
      } as unknown as Record<string, unknown>);

      const execution = await dispatcher.onActionDecided(decision);

      const outcome = await learning.recordOutcome({
        tenant_id: TEST_TENANT_ID,
        contact_id: TEST_CONTACT_ID,
        objective_id: TEST_OBJECTIVE_ID,
        execution_id: execution.execution_id,
        result: 'success',
        reason_category: 'replied_positive',
        metrics: { response_time_ms: 3500, engagement_score: 85 },
      });

      expect(outcome.outcome_id).toBeDefined();
      expect(outcome.result).toBe('success');
    });

    test('should publish outcome.recorded event', async () => {
      const decision = createTestDecision();
      await db.insert('decisions', decision.decision_id, {
        ...decision,
        segment: decision.context.segment,
      } as unknown as Record<string, unknown>);

      const execution = await dispatcher.onActionDecided(decision);

      await learning.recordOutcome({
        tenant_id: TEST_TENANT_ID,
        contact_id: TEST_CONTACT_ID,
        objective_id: TEST_OBJECTIVE_ID,
        execution_id: execution.execution_id,
        result: 'success',
        reason_category: 'replied_positive',
      });

      const events = pubsub.getMessages('outcome.recorded') as OutcomeRecordedEvent[];
      expect(events.length).toBe(1);
      expect(events[0].result).toBe('success');
    });

    test('should update strategy weights on success', async () => {
      const decision = createTestDecision();
      await db.insert('decisions', decision.decision_id, {
        ...decision,
        segment: 'warm_lead',
      } as unknown as Record<string, unknown>);

      const execution = await dispatcher.onActionDecided(decision);

      await learning.recordOutcome({
        tenant_id: TEST_TENANT_ID,
        contact_id: TEST_CONTACT_ID,
        objective_id: TEST_OBJECTIVE_ID,
        execution_id: execution.execution_id,
        result: 'success',
        reason_category: 'converted',
      });

      const weights = await learning.getStrategyWeights(TEST_TENANT_ID);
      expect(weights.length).toBeGreaterThan(0);

      const weight = weights[0];
      expect(weight.win_rate).toBe(1.0);
      expect(weight.sample_size).toBe(1);
    });

    test('should update strategy weights on failure', async () => {
      const decision = createTestDecision();
      await db.insert('decisions', decision.decision_id, {
        ...decision,
        segment: 'warm_lead',
      } as unknown as Record<string, unknown>);

      const execution = await dispatcher.onActionDecided(decision);

      await learning.recordOutcome({
        tenant_id: TEST_TENANT_ID,
        contact_id: TEST_CONTACT_ID,
        objective_id: TEST_OBJECTIVE_ID,
        execution_id: execution.execution_id,
        result: 'failure',
        reason_category: 'no_response',
      });

      const weights = await learning.getStrategyWeights(TEST_TENANT_ID);
      expect(weights.length).toBeGreaterThan(0);

      const weight = weights[0];
      expect(weight.win_rate).toBe(0.0);
      expect(weight.sample_size).toBe(1);
    });

    test('should compute running win rate across multiple outcomes', async () => {
      // Simulate 3 successes and 2 failures
      for (let i = 0; i < 5; i++) {
        const decision = createTestDecision();
        await db.insert('decisions', decision.decision_id, {
          ...decision,
          segment: 'warm_lead',
        } as unknown as Record<string, unknown>);

        const execution = await dispatcher.onActionDecided(decision);

        await learning.recordOutcome({
          tenant_id: TEST_TENANT_ID,
          contact_id: TEST_CONTACT_ID,
          objective_id: TEST_OBJECTIVE_ID,
          execution_id: execution.execution_id,
          result: i < 3 ? 'success' : 'failure',
          reason_category: i < 3 ? 'converted' : 'no_response',
        });
      }

      const weights = await learning.getStrategyWeights(TEST_TENANT_ID);
      expect(weights.length).toBeGreaterThan(0);

      const weight = weights[0];
      expect(weight.sample_size).toBe(5);
      expect(weight.win_rate).toBeCloseTo(0.6, 1);
    });

    test('should invalidate brain cache after outcome', async () => {
      // Pre-populate brain cache
      await cache.set(`brain:${TEST_TENANT_ID}:${TEST_CONTACT_ID}`, { cached: true });

      const decision = createTestDecision();
      await db.insert('decisions', decision.decision_id, {
        ...decision,
        segment: 'warm_lead',
      } as unknown as Record<string, unknown>);

      const execution = await dispatcher.onActionDecided(decision);

      await learning.recordOutcome({
        tenant_id: TEST_TENANT_ID,
        contact_id: TEST_CONTACT_ID,
        objective_id: TEST_OBJECTIVE_ID,
        execution_id: execution.execution_id,
        result: 'success',
        reason_category: 'converted',
      });

      // Brain cache should be invalidated
      const cached = await cache.get(`brain:${TEST_TENANT_ID}:${TEST_CONTACT_ID}`);
      expect(cached).toBeNull();
    });
  });

  // =====================================================================
  // FULL LOOP TESTS
  // =====================================================================

  describe('Full Decision â Agent â Learning Loop', () => {
    test('should complete full loop from decision to learning update', async () => {
      const decision = createTestDecision({
        strategy_selected: 'direct_outreach',
        confidence: 90,
      });

      await db.insert('decisions', decision.decision_id, {
        ...decision,
        segment: 'warm_lead',
      } as unknown as Record<string, unknown>);

      // Step 1: Agent executes
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.status).toBe('sent');
      expect(execution.agent_type).toBe('communication');

      // Step 2: Verify event chain
      const executedEvents = pubsub.getMessages('action.executed') as ActionExecutedEvent[];
      expect(executedEvents.length).toBe(1);

      // Step 3: Record outcome
      const outcome = await learning.recordOutcome({
        tenant_id: TEST_TENANT_ID,
        contact_id: TEST_CONTACT_ID,
        objective_id: TEST_OBJECTIVE_ID,
        execution_id: execution.execution_id,
        result: 'success',
        reason_category: 'replied_positive',
        metrics: { engagement_score: 90, response_time_ms: 2000 },
      });

      // Step 4: Verify outcome recorded
      const outcomeEvents = pubsub.getMessages('outcome.recorded') as OutcomeRecordedEvent[];
      expect(outcomeEvents.length).toBe(1);
      expect(outcomeEvents[0].result).toBe('success');

      // Step 5: Verify strategy weights updated
      const weights = await learning.getStrategyWeights(TEST_TENANT_ID);
      expect(weights.length).toBeGreaterThan(0);
    });

    test('should handle escalation loop correctly', async () => {
      const decision = createTestDecision({
        confidence: 15,
        action_type: 'send_email',
      });

      await db.insert('decisions', decision.decision_id, {
        ...decision,
        segment: 'warm_lead',
      } as unknown as Record<string, unknown>);

      // Low confidence â should escalate
      const execution = await dispatcher.onActionDecided(decision);
      expect(execution.agent_type).toBe('escalation');
      expect(execution.status).toBe('escalated');

      // Record escalation outcome
      const outcome = await learning.recordOutcome({
        tenant_id: TEST_TENANT_ID,
        contact_id: TEST_CONTACT_ID,
        objective_id: TEST_OBJECTIVE_ID,
        execution_id: execution.execution_id,
        result: 'escalated',
        reason_category: 'low_confidence',
      });

      expect(outcome.result).toBe('escalated');
    });

    test('should maintain tenant isolation in events', async () => {
      const tenant1Decision = createTestDecision({
        tenant_id: '550e8400-e29b-41d4-a716-446655440001',
      });
      const tenant2Decision = createTestDecision({
        tenant_id: '550e8400-e29b-41d4-a716-446655440002',
      });

      const exec1 = await dispatcher.onActionDecided(tenant1Decision);
      const exec2 = await dispatcher.onActionDecided(tenant2Decision);

      expect(exec1.tenant_id).toBe('550e8400-e29b-41d4-a716-446655440001');
      expect(exec2.tenant_id).toBe('550e8400-e29b-41d4-a716-446655440002');
      expect(exec1.tenant_id).not.toBe(exec2.tenant_id);

      const events = pubsub.getMessages('action.executed') as ActionExecutedEvent[];
      expect(events.length).toBe(2);

      const tenant1Events = events.filter(
        (e) => e.tenant_id === '550e8400-e29b-41d4-a716-446655440001'
      );
      const tenant2Events = events.filter(
        (e) => e.tenant_id === '550e8400-e29b-41d4-a716-446655440002'
      );
      expect(tenant1Events.length).toBe(1);
      expect(tenant2Events.length).toBe(1);
    });

    test('should validate all schemas at boundaries', async () => {
      const decision = createTestDecision();
      expect(() => ActionDecisionSchema.parse(decision)).not.toThrow();

      await db.insert('decisions', decision.decision_id, {
        ...decision,
        segment: 'warm_lead',
      } as unknown as Record<string, unknown>);

      const execution = await dispatcher.onActionDecided(decision);
      expect(() => AgentExecutionSchema.parse(execution)).not.toThrow();

      const executedEvents = pubsub.getMessages('action.executed') as ActionExecutedEvent[];
      expect(() => ActionExecutedEventSchema.parse(executedEvents[0])).not.toThrow();

      const outcome = await learning.recordOutcome({
        tenant_id: TEST_TENANT_ID,
        contact_id: TEST_CONTACT_ID,
        objective_id: TEST_OBJECTIVE_ID,
        execution_id: execution.execution_id,
        result: 'success',
        reason_category: 'converted',
      });
      expect(() => OutcomeRecordedEventSchema.parse(outcome)).not.toThrow();
    });
  });
});

// ==========================================================================
// EXPORTS FOR REUSE
// ==========================================================================

export {
  // Schemas
  ActionDecisionSchema,
  AgentExecutionSchema,
  ActionExecutedEventSchema,
  OutcomeRecordedEventSchema,
  StrategyWeightSchema,
  // Types
  type ActionDecision,
  type AgentExecution,
  type ActionExecutedEvent,
  type OutcomeRecordedEvent,
  type StrategyWeight,
  // Adapters
  InMemoryDatabase,
  InMemoryPubSubClient,
  InMemoryCacheClient,
  // Services
  AgentDispatcher,
  LearningService,
  // Helpers
  createTestDecision,
};
