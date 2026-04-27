/**
 * Tests for KAN-703 — pipeline-aware context loading + Knowledge per-pipeline filtering.
 *
 * Coverage matches the AC:
 *   - Pipeline state loading happy path (Pipeline + Stage + active MicroObjectives + KnowledgeFilters bundle)
 *   - Empty pipeline (currentPipelineId=null) graceful fallback to tenant-scoped behavior
 *   - Per-pipeline knowledge filter — whitelist by category, include rule (must match), exclude rule (must not match)
 *   - Stale stage reference (currentStageId points at a removed Stage row) — pipeline still loads, stage=null
 *   - microObjectiveProgress JSONB shape propagates from Contact through to BrainContext
 *   - message-composer prompt: includes pipeline block when present, omits cleanly when absent
 *   - message-composer prompt: outstanding micro-objectives (incomplete) listed; completed ones suppressed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyKnowledgeFilter,
  assembleContext,
  InMemoryContextCache,
  setKnowledgeSearch,
  type ContextDatabase,
  type KnowledgeHit,
  type PipelineStateBundle,
} from '../context-assembler.js';
import { composeMessage } from '../message-composer.js';
import { __setLLMClientsForTest } from '../llm-client.js';
import type Anthropic from '@anthropic-ai/sdk';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CONTACT_ID = '22222222-2222-2222-2222-222222222222';
const PIPELINE_ID = 'pipe-1';
const STAGE_ID = 'stage-1';

function hit(id: string, text: string, category: string, extra: Record<string, unknown> = {}): KnowledgeHit {
  return {
    id: `hit-${id}`,
    contentType: 'knowledge_article',
    contentId: id,
    contentText: text,
    metadata: { category, ...extra },
    similarity: 0.85,
  };
}

function bundle(overrides: Partial<PipelineStateBundle> = {}): PipelineStateBundle {
  return {
    pipeline: {
      id: PIPELINE_ID,
      name: 'Enterprise Sales',
      objectiveType: 'send_quote',
      objectiveDescription: 'Move qualified leads to a signed quote',
      targets: [
        { metric: 'quotes_sent', value: 25, period: 'monthly', currentProgress: 4 },
      ],
    },
    stage: {
      id: STAGE_ID,
      name: 'Discovery',
      order: 1,
      isInitial: true,
      isTerminal: false,
      entryActions: [],
      transitionRules: [],
      autoApproveMatrix: {},
    },
    microObjectives: [
      { id: 'mo-1', name: 'Understand intent', completionCriteria: { type: 'intent_extracted' }, order: 1 },
      { id: 'mo-2', name: 'Identify timeframe', completionCriteria: { type: 'buying_timeframe_extracted' }, order: 2 },
    ],
    knowledgeFilters: [],
    ...overrides,
  };
}

function makeDb(opts: {
  contact?: Record<string, unknown>;
  pipelineState?: PipelineStateBundle | null;
  pipelineStateThrows?: boolean;
} = {}): ContextDatabase {
  return {
    getContact: vi.fn(async () => opts.contact ?? {
      name: 'Alex',
      email: 'alex@example.com',
      lifecycle_stage: 'qualified',
      segment: 'enterprise',
      current_pipeline_id: PIPELINE_ID,
      current_stage_id: STAGE_ID,
      micro_objective_progress: { 'mo-2': { completed: true, completedAt: '2026-04-25', evidence: 'replied' } },
    }),
    getContactState: vi.fn(async () => null),
    getBrainSnapshot: vi.fn(async () => ({})),
    getTenantConfig: vi.fn(async () => ({ confidence_threshold: 70 })),
    getRecentActions: vi.fn(async () => []),
    getPipelineState: opts.pipelineState === null
      ? undefined
      : vi.fn(async () => {
          if (opts.pipelineStateThrows) throw new Error('pgvector down or whatever');
          return opts.pipelineState ?? bundle();
        }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  setKnowledgeSearch(null);
});

// ─────────────────────────────────────────────
// applyKnowledgeFilter — whitelist + include + exclude semantics
// ─────────────────────────────────────────────

describe('applyKnowledgeFilter', () => {
  const hits = [
    hit('a', 'Pricing $99/mo', 'products', { tag: 'in_stock' }),
    hit('b', 'Old SKU notice', 'products', { discontinued: true }),
    hit('c', '60-day shipping', 'shipping'),
    hit('d', 'Holiday warranty', 'warranty'),
  ];

  it('empty filter list = pass-through', () => {
    expect(applyKnowledgeFilter(hits, [])).toEqual(hits);
  });

  it('whitelist by category — drops categories with no filter row', () => {
    const out = applyKnowledgeFilter(hits, [
      { knowledgeCategory: 'products', includeRule: {}, excludeRule: {} },
    ]);
    expect(out.map((h) => h.contentId).sort()).toEqual(['a', 'b']);
  });

  it('includeRule must match (AND of key=value)', () => {
    const out = applyKnowledgeFilter(hits, [
      { knowledgeCategory: 'products', includeRule: { tag: 'in_stock' }, excludeRule: {} },
    ]);
    expect(out.map((h) => h.contentId)).toEqual(['a']);
  });

  it('excludeRule blocks matching entries (OR of key=value)', () => {
    const out = applyKnowledgeFilter(hits, [
      { knowledgeCategory: 'products', includeRule: {}, excludeRule: { discontinued: true } },
    ]);
    expect(out.map((h) => h.contentId)).toEqual(['a']);
  });

  it('include + exclude combine — must match include AND not match exclude', () => {
    const out = applyKnowledgeFilter(hits, [
      { knowledgeCategory: 'products', includeRule: { tag: 'in_stock' }, excludeRule: { discontinued: true } },
    ]);
    expect(out.map((h) => h.contentId)).toEqual(['a']);
  });

  it('multiple category whitelist — categories union, not intersection', () => {
    const out = applyKnowledgeFilter(hits, [
      { knowledgeCategory: 'shipping', includeRule: {}, excludeRule: {} },
      { knowledgeCategory: 'warranty', includeRule: {}, excludeRule: {} },
    ]);
    expect(out.map((h) => h.contentId).sort()).toEqual(['c', 'd']);
  });

  it('hits without metadata.category are dropped (defensive — no category = unfilterable)', () => {
    const noCategoryHit: KnowledgeHit = {
      id: 'no-cat', contentType: 'knowledge_article', contentId: 'no-cat',
      contentText: 'orphan', metadata: {}, similarity: 0.7,
    };
    const out = applyKnowledgeFilter([noCategoryHit, ...hits], [
      { knowledgeCategory: 'products', includeRule: {}, excludeRule: {} },
    ]);
    expect(out.find((h) => h.contentId === 'no-cat')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// assembleContext — pipeline state propagates through to brain
// ─────────────────────────────────────────────

describe('assembleContext pipeline-aware loading', () => {
  it('populates brain.pipeline / stage / microObjectives / microObjectiveProgress when pipeline assigned', async () => {
    setKnowledgeSearch(vi.fn(async () => []));
    const out = await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb(),
    );
    expect(out.brain.pipeline?.name).toBe('Enterprise Sales');
    expect(out.brain.pipeline?.objectiveType).toBe('send_quote');
    expect(out.brain.stage?.name).toBe('Discovery');
    expect(out.brain.stage?.isInitial).toBe(true);
    expect(out.brain.microObjectives).toHaveLength(2);
    expect(out.brain.microObjectives?.map((m) => m.name).sort()).toEqual(['Identify timeframe', 'Understand intent']);
    expect(out.brain.microObjectiveProgress).toEqual({
      'mo-2': { completed: true, completedAt: '2026-04-25', evidence: 'replied' },
    });
  });

  it('legacy contact (currentPipelineId=null) — pipeline fields undefined, no failure', async () => {
    setKnowledgeSearch(vi.fn(async () => []));
    const out = await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb({
        contact: {
          name: 'Legacy User',
          email: 'legacy@example.com',
          current_pipeline_id: null,
          current_stage_id: null,
        },
      }),
    );
    expect(out.brain.pipeline).toBeUndefined();
    expect(out.brain.stage).toBeUndefined();
    expect(out.brain.microObjectives).toBeUndefined();
    expect(out.brain.microObjectiveProgress).toBeUndefined();
    expect(out.contactId).toBe(CONTACT_ID);
  });

  it('stale stage reference — pipeline loads, stage=null, no throw', async () => {
    setKnowledgeSearch(vi.fn(async () => []));
    const out = await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb({ pipelineState: bundle({ stage: null }) }),
    );
    expect(out.brain.pipeline).toBeDefined();
    expect(out.brain.stage).toBeUndefined();
  });

  it('getPipelineState throwing degrades gracefully — pipeline fields undefined, assembly completes', async () => {
    setKnowledgeSearch(vi.fn(async () => []));
    const out = await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb({ pipelineStateThrows: true }),
    );
    expect(out.brain.pipeline).toBeUndefined();
    expect(out.contactId).toBe(CONTACT_ID);
  });

  it('KnowledgeFilter on pipeline filters retrieved hits by category', async () => {
    const allHits = [
      hit('a', 'Pricing fact', 'products'),
      hit('b', 'Shipping info', 'shipping'),
    ];
    setKnowledgeSearch(vi.fn(async () => allHits));

    const out = await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb({
        pipelineState: bundle({
          knowledgeFilters: [
            { knowledgeCategory: 'products', includeRule: {}, excludeRule: {} },
          ],
        }),
      }),
    );
    expect(out.brain.knowledge?.map((h) => h.contentId)).toEqual(['a']);
  });

  it('pipeline + stage signals reach the embedding query', async () => {
    const fetcher = vi.fn(async () => [] as KnowledgeHit[]);
    setKnowledgeSearch(fetcher);

    await assembleContext(
      { contactId: CONTACT_ID, tenantId: TENANT_ID, maxTokenBudget: 8000, includeFullBrain: false },
      new InMemoryContextCache(),
      makeDb(),
    );
    const query = fetcher.mock.calls[0][1] as string;
    expect(query).toMatch(/pipeline:\s*send_quote/);
    expect(query).toMatch(/pipeline_stage:\s*Discovery/);
  });
});

// ─────────────────────────────────────────────
// message-composer — pipeline block in the Haiku prompt
// ─────────────────────────────────────────────

function makeAnthropicMock(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } } as unknown as Anthropic;
}

function anthropicJsonResponse(subject: string, body: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ subject, body }) }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function makePrismaForCompose() {
  return {
    contact: {
      findFirst: vi.fn(async () => ({ firstName: 'Alex', lastName: 'Doe', email: 'a@x.com' })),
    },
    brainSnapshot: { findFirst: vi.fn(async () => null) },
  } as any;
}

describe('message-composer pipeline-aware prompt (KAN-703)', () => {
  it('renders Pipeline + Stage + outstanding micro-objectives when present', async () => {
    const create = vi.fn(async () => anthropicJsonResponse('Hi Alex', 'Body'));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    await composeMessage(makePrismaForCompose(), {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      decisionId: 'd1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      pipeline: { name: 'Enterprise Sales', objectiveType: 'send_quote', objectiveDescription: 'Move to signed quote' },
      stage: { name: 'Discovery', isInitial: true, isTerminal: false },
      microObjectives: [
        { id: 'mo-1', name: 'Understand intent' },
        { id: 'mo-2', name: 'Identify timeframe' },
      ],
      microObjectiveProgress: { 'mo-2': { completed: true } },
    });

    const userPrompt = (create.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(userPrompt).toContain('Pipeline Context');
    expect(userPrompt).toContain('Pipeline: Enterprise Sales (objective: send_quote — Move to signed quote)');
    expect(userPrompt).toContain('Stage: Discovery (initial)');
    // Outstanding only — completed mo-2 should NOT appear
    expect(userPrompt).toMatch(/Outstanding micro-objectives:\s*Understand intent/);
    expect(userPrompt).not.toMatch(/Identify timeframe/);
  });

  it('omits Pipeline block entirely when no pipeline context provided (back-compat)', async () => {
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
    expect(userPrompt).not.toContain('Pipeline Context');
  });

  it('all micro-objectives complete → "Outstanding" line is suppressed', async () => {
    const create = vi.fn(async () => anthropicJsonResponse('Hi Alex', 'Body'));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    await composeMessage(makePrismaForCompose(), {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      decisionId: 'd1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      pipeline: { name: 'Enterprise Sales', objectiveType: 'send_quote' },
      stage: { name: 'Discovery' },
      microObjectives: [
        { id: 'mo-1', name: 'Understand intent' },
        { id: 'mo-2', name: 'Identify timeframe' },
      ],
      microObjectiveProgress: {
        'mo-1': { completed: true },
        'mo-2': { completed: true },
      },
    });

    const userPrompt = (create.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(userPrompt).toContain('Pipeline Context');
    expect(userPrompt).not.toMatch(/Outstanding micro-objectives/);
  });
});
