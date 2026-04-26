/**
 * Tests for KAN-698 RAG retrieval wired into context-assembler.
 *
 * Coverage:
 *   - loadKnowledge: tenant scope passed correctly to fetcher
 *   - loadKnowledge: default K = 5 (configurable via arg)
 *   - loadKnowledge: empty results don't break — returns []
 *   - loadKnowledge: fetcher throw → returns [] (graceful degradation)
 *   - loadKnowledge: no fetcher wired → returns []
 *   - loadKnowledge: blank query short-circuits to []
 *   - assembleContext: brain.knowledge populated when search hits
 *   - assembleContext: brain.knowledge undefined when search misses
 *   - message-composer: knowledge injected into Haiku prompt
 *   - message-composer: knowledge omitted when array empty
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadKnowledge,
  setKnowledgeSearch,
  assembleContext,
  InMemoryContextCache,
  DEFAULT_KNOWLEDGE_K,
  type ContextDatabase,
  type KnowledgeHit,
  type KnowledgeSearchFn,
} from '../context-assembler.js';
import { composeMessage } from '../message-composer.js';
import { __setLLMClientsForTest } from '../llm-client.js';
import type Anthropic from '@anthropic-ai/sdk';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CONTACT_ID = '22222222-2222-2222-2222-222222222222';
const OBJECTIVE_ID = '33333333-3333-3333-3333-333333333333';

function hit(contentId: string, text: string, sim = 0.85): KnowledgeHit {
  return {
    id: `hit-${contentId}`,
    contentType: 'knowledge_article',
    contentId,
    contentText: text,
    metadata: {},
    similarity: sim,
  };
}

function makeDb(overrides: Partial<ContextDatabase> = {}): ContextDatabase {
  return {
    getContact: vi.fn(async () => ({
      name: 'Test User',
      email: 'test@example.com',
      lifecycle_stage: 'lead',
      segment: 'enterprise',
    })),
    getContactState: vi.fn(async () => ({
      objective_id: OBJECTIVE_ID,
      objective_type: 'demo_booking',
      overall_progress: 50,
      overall_health: 'on_track',
      strategy_current: 'direct',
    })),
    getBrainSnapshot: vi.fn(async () => ({ tone: 'professional' })),
    getTenantConfig: vi.fn(async () => ({ confidence_threshold: 70 })),
    getRecentActions: vi.fn(async () => []),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  setKnowledgeSearch(null);
});

// ─────────────────────────────────────────────
// loadKnowledge — direct contract
// ─────────────────────────────────────────────

describe('loadKnowledge', () => {
  it('passes the exact tenantId through to the fetcher (tenant isolation)', async () => {
    const fetcher: KnowledgeSearchFn = vi.fn(async () => [hit('a', 'fact a')]);
    setKnowledgeSearch(fetcher);

    await loadKnowledge(TENANT_ID, 'q', 5);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(TENANT_ID);
  });

  it('uses default K=5 when not specified, configurable when provided', async () => {
    const fetcher = vi.fn(async () => [] as KnowledgeHit[]);
    setKnowledgeSearch(fetcher);

    await loadKnowledge(TENANT_ID, 'q');
    expect(fetcher.mock.calls[0][2]).toMatchObject({ limit: DEFAULT_KNOWLEDGE_K });

    fetcher.mockClear();
    await loadKnowledge(TENANT_ID, 'q', 3);
    expect(fetcher.mock.calls[0][2]).toMatchObject({ limit: 3 });
  });

  it('returns [] when no fetcher is wired (boot race or not configured)', async () => {
    setKnowledgeSearch(null);
    const out = await loadKnowledge(TENANT_ID, 'q');
    expect(out).toEqual([]);
  });

  it('returns [] when fetcher throws (graceful degradation)', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('pgvector down');
    });
    setKnowledgeSearch(fetcher);

    const out = await loadKnowledge(TENANT_ID, 'q');
    expect(out).toEqual([]);
  });

  it('short-circuits to [] for blank queries (no SQL hit)', async () => {
    const fetcher = vi.fn(async () => [hit('a', 'fact')]);
    setKnowledgeSearch(fetcher);

    const out = await loadKnowledge(TENANT_ID, '   ');
    expect(out).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns hits as-is when fetcher succeeds', async () => {
    const hits = [hit('a', 'fact a'), hit('b', 'fact b')];
    setKnowledgeSearch(async () => hits);

    const out = await loadKnowledge(TENANT_ID, 'q');
    expect(out).toEqual(hits);
  });
});

// ─────────────────────────────────────────────
// assembleContext — knowledge propagates into brain.knowledge
// ─────────────────────────────────────────────

describe('assembleContext brain.knowledge wiring', () => {
  it('populates brain.knowledge when the search returns hits', async () => {
    const hits = [hit('kb1', 'Pricing starts at $99/mo'), hit('kb2', 'Free trial = 14 days')];
    setKnowledgeSearch(vi.fn(async () => hits));

    const out = await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, objectiveId: OBJECTIVE_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb(),
    );

    expect(out.brain.knowledge).toEqual(hits);
  });

  it('omits brain.knowledge when search returns no hits (cleaner serialization)', async () => {
    setKnowledgeSearch(vi.fn(async () => []));

    const out = await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, objectiveId: OBJECTIVE_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb(),
    );

    expect(out.brain.knowledge).toBeUndefined();
  });

  it('passes tenantId to the search (cross-tenant retrieval impossible)', async () => {
    const fetcher = vi.fn(async () => [hit('a', 'fact')]);
    setKnowledgeSearch(fetcher);

    await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, objectiveId: OBJECTIVE_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb(),
    );

    expect(fetcher).toHaveBeenCalled();
    expect(fetcher.mock.calls[0][0]).toBe(TENANT_ID);
  });

  it('builds a query from contact lifecycle + segment + objective + strategy', async () => {
    const fetcher = vi.fn(async () => [] as KnowledgeHit[]);
    setKnowledgeSearch(fetcher);

    await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, objectiveId: OBJECTIVE_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb(),
    );

    const query = fetcher.mock.calls[0][1] as string;
    expect(query).toMatch(/lead/);
    expect(query).toMatch(/enterprise/);
    expect(query).toMatch(/demo_booking/);
    expect(query).toMatch(/direct/);
  });

  it('does not throw when knowledge search fails (assembly still completes)', async () => {
    setKnowledgeSearch(vi.fn(async () => {
      throw new Error('pgvector down');
    }));

    const out = await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, objectiveId: OBJECTIVE_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb(),
    );

    expect(out.brain.knowledge).toBeUndefined();
    expect(out.contactId).toBe(CONTACT_ID);
  });
});

// ─────────────────────────────────────────────
// message-composer — knowledge in the Haiku prompt
// ─────────────────────────────────────────────

function makeAnthropicMock(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } } as unknown as Anthropic;
}

function anthropicJsonResponse(subject: string, body: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ subject, body }),
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function makePrismaForCompose() {
  return {
    contact: {
      findFirst: vi.fn(async () => ({ firstName: 'Alex', lastName: 'Doe', email: 'a@x.com' })),
    },
    brainSnapshot: {
      findFirst: vi.fn(async () => null),
    },
  } as any;
}

describe('message-composer knowledge injection (KAN-698)', () => {
  it('injects knowledge block into the Haiku user prompt when present', async () => {
    const create = vi.fn(async () => anthropicJsonResponse('Hi Alex', 'Body text'));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    await composeMessage(makePrismaForCompose(), {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      decisionId: 'd1',
      instruction: 'follow up on demo',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      knowledge: [hit('p1', 'Pricing starts at $99/mo'), hit('t1', 'Free trial is 14 days')],
    });

    expect(create).toHaveBeenCalledTimes(1);
    const userPrompt = (create.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(userPrompt).toContain('Tenant Knowledge');
    expect(userPrompt).toContain('Pricing starts at $99/mo');
    expect(userPrompt).toContain('Free trial is 14 days');
  });

  it('omits the knowledge block entirely when the array is empty', async () => {
    const create = vi.fn(async () => anthropicJsonResponse('Hi Alex', 'Body'));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    await composeMessage(makePrismaForCompose(), {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      decisionId: 'd1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      knowledge: [],
    });

    const userPrompt = (create.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(userPrompt).not.toContain('Tenant Knowledge');
  });

  it('omits the knowledge block when knowledge is undefined (back-compat)', async () => {
    const create = vi.fn(async () => anthropicJsonResponse('Hi Alex', 'Body'));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    await composeMessage(makePrismaForCompose(), {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      decisionId: 'd1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
    });

    const userPrompt = (create.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(userPrompt).not.toContain('Tenant Knowledge');
  });

  it('skips knowledge entries with empty text (defensive against bad data)', async () => {
    const create = vi.fn(async () => anthropicJsonResponse('Hi Alex', 'Body'));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    await composeMessage(makePrismaForCompose(), {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      decisionId: 'd1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      knowledge: [
        { id: 'a', contentType: 'knowledge_article', contentId: 'a', contentText: '   ', metadata: {}, similarity: 0.9 },
        { id: 'b', contentType: 'knowledge_article', contentId: 'b', contentText: 'Real fact', metadata: {}, similarity: 0.8 },
      ],
    });

    const userPrompt = (create.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(userPrompt).toContain('Real fact');
    // The empty-text entry should not produce an indexed line
    expect(userPrompt).not.toMatch(/1\. \[knowledge_article\]\s*\n/);
  });
});
