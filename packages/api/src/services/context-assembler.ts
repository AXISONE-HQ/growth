/**
 * Context Assembler — KAN-40
 *
 * Decision Engine — DECIDE phase, Pre-step
 * Assembles the full decision context for a contact from Redis cache
 * and Cloud SQL fallback. Must complete in <100ms to meet the
 * Decision Engine's <500ms total budget.
 *
 * Architecture reference:
 *   brain.updated event → Redis cache (pre-assembled)
 *       │
 *   Context Assembler  ← Assemble context in <100ms
 *       │
 *   Objective Gap Analyzer → Strategy Selector → Action Determiner → ...
 *
 * Context budget: 8,000 tokens max for LLM calls.
 * The assembler enforces this by truncating and prioritizing context.
 *
 * Data sources (in priority order):
 *   1. Redis cache (hot path — <10ms)
 *   2. Cloud SQL contact_states (warm fallback — <50ms)
 *   3. Cloud SQL brain_snapshots (cold fallback — <100ms)
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

export const ContextAssemblerInputSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  objectiveId: z.string().optional(),
  maxTokenBudget: z.number().default(8000),
  includeFullBrain: z.boolean().default(false),
});

export const AssembledContextSchema = z.object({
  contactId: z.string(),
  tenantId: z.string(),
  contact: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    lifecycleStage: z.string().optional(),
    segment: z.string().optional(),
    dataQualityScore: z.number().optional(),
    lastInteractionDaysAgo: z.number().optional(),
    totalInteractions: z.number().optional(),
    responseRate: z.number().optional(),
    preferredChannel: z.string().optional(),
    timezone: z.string().optional(),
  }),
  objective: z
    .object({
      objectiveId: z.string(),
      objectiveType: z.string(),
      overallProgress: z.number(),
      overallHealth: z.string(),
      subObjectives: z.array(z.record(z.unknown())).optional(),
      currentStrategy: z.string().optional(),
      confidenceScore: z.number().optional(),
    })
    .nullable(),
  brain: z.object({
    companyTruth: z.record(z.unknown()).optional(),
    blueprintStrategies: z.array(z.string()).optional(),
    strategyWeights: z.record(z.number()).optional(),
    products: z.array(z.string()).optional(),
    tone: z.string().optional(),
    constraints: z.array(z.string()).optional(),
    // KAN-698: top-K Knowledge Center entries retrieved via brain-embeddings
    // similarity search (tenant-scoped). Available to strategy selector,
    // action determiner, and message-composer for grounding.
    knowledge: z
      .array(
        z.object({
          id: z.string(),
          contentType: z.string(),
          contentId: z.string(),
          contentText: z.string().optional(),
          metadata: z.record(z.unknown()),
          similarity: z.number(),
        }),
      )
      .optional(),
  }),
  tenantConfig: z.object({
    planTier: z.string().optional(),
    confidenceThreshold: z.number().optional(),
    allowedChannels: z.array(z.string()).optional(),
    requireHumanApproval: z.boolean().optional(),
    maxDailyAutoActions: z.number().optional(),
    quietHoursStart: z.number().optional(),
    quietHoursEnd: z.number().optional(),
  }),
  recentActions: z.array(
    z.object({
      actionType: z.string(),
      channel: z.string().optional(),
      sentAt: z.string(),
      outcome: z.string().optional(),
    }),
  ),
  metadata: z.object({
    assembledAt: z.string().datetime(),
    source: z.enum(['cache', 'database', 'partial_cache']),
    assemblyTimeMs: z.number(),
    estimatedTokens: z.number(),
    truncated: z.boolean(),
  }),
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ContextAssemblerInput = z.infer<typeof ContextAssemblerInputSchema>;
export type AssembledContext = z.infer<typeof AssembledContextSchema>;

export interface ContextCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface ContextDatabase {
  getContact(contactId: string, tenantId: string): Promise<Record<string, unknown> | null>;
  getContactState(contactId: string, objectiveId: string): Promise<Record<string, unknown> | null>;
  getBrainSnapshot(tenantId: string): Promise<Record<string, unknown> | null>;
  getTenantConfig(tenantId: string): Promise<Record<string, unknown> | null>;
  getRecentActions(contactId: string, limit: number): Promise<Record<string, unknown>[]>;
}

// ─────────────────────────────────────────────
// KAN-698: RAG knowledge retrieval (Knowledge Center via brain-embeddings)
// ─────────────────────────────────────────────

export interface KnowledgeHit {
  id: string;
  contentType: string;
  contentId: string;
  contentText?: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface KnowledgeSearchOptions {
  limit?: number;
  threshold?: number;
}

/**
 * Tenant-scoped knowledge fetcher. Wired at boot (apps/api/src/index.ts) to
 * `brain-embeddings.similaritySearch` via dynamic import so the static TS6059
 * graph does not grow. Tests inject a mock directly.
 */
export type KnowledgeSearchFn = (
  tenantId: string,
  query: string,
  opts?: KnowledgeSearchOptions,
) => Promise<KnowledgeHit[]>;

let _knowledgeSearch: KnowledgeSearchFn | null = null;
let _autoWireAttempted = false;

export function setKnowledgeSearch(fn: KnowledgeSearchFn | null): void {
  _knowledgeSearch = fn;
  // Tests use this to inject a mock — when they reset to null, allow re-auto-wire.
  if (fn === null) _autoWireAttempted = false;
}

/**
 * Lazy auto-wire to brain-embeddings.similaritySearch. Uses a variable
 * specifier so tsc cannot statically resolve the import — keeps
 * brain-embeddings.ts out of the apps/api static program (no TS6059 growth).
 * Runs once per process lifetime; failure is silent (loadKnowledge returns []).
 */
async function tryAutoWireKnowledgeSearch(): Promise<void> {
  if (_autoWireAttempted) return;
  _autoWireAttempted = true;
  try {
    const spec = './brain-embeddings.js';
    const mod = (await import(spec)) as {
      similaritySearch?: (
        tenantId: string,
        query: string,
        opts?: KnowledgeSearchOptions,
      ) => Promise<KnowledgeHit[]>;
    };
    if (typeof mod.similaritySearch === 'function') {
      const fn = mod.similaritySearch;
      _knowledgeSearch = (tenantId, query, opts) => fn(tenantId, query, opts);
    }
  } catch {
    // Silent — loadKnowledge will return [] until wired.
  }
}

export const DEFAULT_KNOWLEDGE_K = 5;
const DEFAULT_KNOWLEDGE_THRESHOLD = 0.5;

/**
 * Query Knowledge Center for top-K relevant entries. Tenant-scoped — the
 * fetcher must enforce isolation (similaritySearch's WHERE tenant_id filter).
 *
 * Graceful degradation: returns [] if no fetcher is wired or if the search
 * throws. Knowledge is grounding sugar; the pipeline must keep flowing.
 */
export async function loadKnowledge(
  tenantId: string,
  query: string,
  k: number = DEFAULT_KNOWLEDGE_K,
): Promise<KnowledgeHit[]> {
  if (!query.trim()) return [];
  if (!_knowledgeSearch) await tryAutoWireKnowledgeSearch();
  if (!_knowledgeSearch) return [];
  try {
    return await _knowledgeSearch(tenantId, query, {
      limit: k,
      threshold: DEFAULT_KNOWLEDGE_THRESHOLD,
    });
  } catch (err) {
    console.error('[context-assembler] knowledge search failed', err);
    return [];
  }
}

/** Build a compact embedding query from contact + objective context. */
function buildKnowledgeQuery(
  contact: Record<string, unknown> | null,
  contactState: Record<string, unknown> | null,
): string {
  const parts: string[] = [];
  if (contact?.lifecycle_stage) parts.push(`stage: ${contact.lifecycle_stage}`);
  if (contact?.segment) parts.push(`segment: ${contact.segment}`);
  if (contactState?.objective_type) parts.push(`objective: ${contactState.objective_type}`);
  if (contactState?.strategy_current) parts.push(`strategy: ${contactState.strategy_current}`);
  return parts.join(' | ');
}

// ─────────────────────────────────────────────
// Cache Key Builders
// ─────────────────────────────────────────────

const CACHE_PREFIX = 'ctx';
const CACHE_TTL_SECONDS = 300;

export function buildCacheKey(tenantId: string, contactId: string): string {
  return `${CACHE_PREFIX}:${tenantId}:${contactId}`;
}

// ─────────────────────────────────────────────
// Token Estimation
// ─────────────────────────────────────────────

function estimateTokens(obj: unknown): number {
  const json = JSON.stringify(obj);
  return Math.ceil(json.length / 3.5);
}

function truncateToTokenBudget(
  context: Partial<AssembledContext>,
  maxTokens: number,
): { truncated: Partial<AssembledContext>; estimatedTokens: number; wasTruncated: boolean } {
  let current = { ...context };
  let tokens = estimateTokens(current);

  if (tokens <= maxTokens) {
    return { truncated: current, estimatedTokens: tokens, wasTruncated: false };
  }

  if (current.recentActions && current.recentActions.length > 5) {
    current = { ...current, recentActions: current.recentActions.slice(0, 5) };
    tokens = estimateTokens(current);
    if (tokens <= maxTokens) {
      return { truncated: current, estimatedTokens: tokens, wasTruncated: true };
    }
  }

  if (current.brain) {
    current = {
      ...current,
      brain: { ...current.brain, products: undefined, constraints: undefined },
    };
    tokens = estimateTokens(current);
    if (tokens <= maxTokens) {
      return { truncated: current, estimatedTokens: tokens, wasTruncated: true };
    }
  }

  if (current.objective?.subObjectives) {
    current = {
      ...current,
      objective: { ...current.objective, subObjectives: undefined },
    };
    tokens = estimateTokens(current);
    if (tokens <= maxTokens) {
      return { truncated: current, estimatedTokens: tokens, wasTruncated: true };
    }
  }

  if (current.recentActions && current.recentActions.length > 2) {
    current = { ...current, recentActions: current.recentActions.slice(0, 2) };
    tokens = estimateTokens(current);
  }

  return { truncated: current, estimatedTokens: tokens, wasTruncated: true };
}

// ─────────────────────────────────────────────
// Assembly Logic
// ─────────────────────────────────────────────

async function assembleFromCache(
  input: ContextAssemblerInput,
  cache: ContextCache,
): Promise<AssembledContext | null> {
  const key = buildCacheKey(input.tenantId, input.contactId);
  const cached = await cache.get(key);
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached);
    return AssembledContextSchema.parse(parsed);
  } catch {
    return null;
  }
}

async function assembleFromDatabase(
  input: ContextAssemblerInput,
  db: ContextDatabase,
): Promise<Partial<AssembledContext>> {
  const [contact, contactState, brain, tenantConfig, recentActions] =
    await Promise.all([
      db.getContact(input.contactId, input.tenantId),
      input.objectiveId
        ? db.getContactState(input.contactId, input.objectiveId)
        : Promise.resolve(null),
      db.getBrainSnapshot(input.tenantId),
      db.getTenantConfig(input.tenantId),
      db.getRecentActions(input.contactId, 10),
    ]);

  // KAN-698: Knowledge query runs after the parallel batch so we can build
  // the embedding query from contact + objective context. Off the critical
  // path token-budget-wise — graceful degradation returns [] on any failure.
  const knowledgeQuery = buildKnowledgeQuery(contact, contactState);
  const knowledge = await loadKnowledge(input.tenantId, knowledgeQuery);

  return {
    contactId: input.contactId,
    tenantId: input.tenantId,
    contact: {
      name: (contact?.name as string) ?? undefined,
      email: (contact?.email as string) ?? undefined,
      phone: (contact?.phone as string) ?? undefined,
      lifecycleStage: (contact?.lifecycle_stage as string) ?? undefined,
      segment: (contact?.segment as string) ?? undefined,
      dataQualityScore: (contact?.data_quality_score as number) ?? undefined,
      lastInteractionDaysAgo: contact?.last_interaction_at
        ? Math.floor(
            (Date.now() - new Date(contact.last_interaction_at as string).getTime()) /
              (1000 * 60 * 60 * 24),
          )
        : undefined,
      totalInteractions: (contact?.total_interactions as number) ?? undefined,
      responseRate: (contact?.response_rate as number) ?? undefined,
      preferredChannel: (contact?.preferred_channel as string) ?? undefined,
      timezone: (contact?.timezone as string) ?? undefined,
    },
    objective: contactState
      ? {
          objectiveId: (contactState.objective_id as string) ?? input.objectiveId ?? '',
          objectiveType: (contactState.objective_type as string) ?? 'unknown',
          overallProgress: (contactState.overall_progress as number) ?? 0,
          overallHealth: (contactState.overall_health as string) ?? 'unknown',
          subObjectives: (contactState.sub_objectives as Record<string, unknown>[]) ?? undefined,
          currentStrategy: (contactState.strategy_current as string) ?? undefined,
          confidenceScore: (contactState.confidence_score as number) ?? undefined,
        }
      : null,
    brain: {
      companyTruth: (brain?.company_truth as Record<string, unknown>) ?? undefined,
      blueprintStrategies: (brain?.blueprint_strategies as string[]) ?? undefined,
      strategyWeights: (brain?.strategy_weights as Record<string, number>) ?? undefined,
      tone: (brain?.tone as string) ?? undefined,
      constraints: (brain?.constraints as string[]) ?? undefined,
      knowledge: knowledge.length > 0 ? knowledge : undefined,
    },
    tenantConfig: {
      planTier: (tenantConfig?.plan_tier as string) ?? undefined,
      confidenceThreshold: (tenantConfig?.confidence_threshold as number) ?? 70,
      allowedChannels: (tenantConfig?.allowed_channels as string[]) ?? undefined,
      requireHumanApproval: (tenantConfig?.require_human_approval as boolean) ?? false,
      maxDailyAutoActions: (tenantConfig?.max_daily_auto_actions as number) ?? undefined,
      quietHoursStart: (tenantConfig?.quiet_hours_start as number) ?? undefined,
      quietHoursEnd: (tenantConfig?.quiet_hours_end as number) ?? undefined,
    },
    recentActions: recentActions.map((a) => ({
      actionType: (a.action_type as string) ?? 'unknown',
      channel: (a.channel as string) ?? undefined,
      sentAt: (a.sent_at as string) ?? new Date().toISOString(),
      outcome: (a.outcome as string) ?? undefined,
    })),
  };
}

// ─────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────

export async function assembleContext(
  input: ContextAssemblerInput,
  cache: ContextCache,
  db: ContextDatabase,
): Promise<AssembledContext> {
  const parsed = ContextAssemblerInputSchema.parse(input);
  const startTime = Date.now();

  const cached = await assembleFromCache(parsed, cache);
  if (cached) {
    return {
      ...cached,
      metadata: {
        ...cached.metadata,
        assembledAt: new Date().toISOString(),
        source: 'cache',
        assemblyTimeMs: Date.now() - startTime,
      },
    };
  }

  const raw = await assembleFromDatabase(parsed, db);

  const { truncated, estimatedTokens, wasTruncated } = truncateToTokenBudget(
    raw,
    parsed.maxTokenBudget,
  );

  const assemblyTimeMs = Date.now() - startTime;

  const result: AssembledContext = AssembledContextSchema.parse({
    ...truncated,
    metadata: {
      assembledAt: new Date().toISOString(),
      source: 'database',
      assemblyTimeMs,
      estimatedTokens,
      truncated: wasTruncated,
    },
  });

  try {
    const cacheKey = buildCacheKey(parsed.tenantId, parsed.contactId);
    await cache.set(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
  } catch (err) {
    console.warn('[ContextAssembler] Cache write failed:', err);
  }

  return result;
}

// ─────────────────────────────────────────────
// In-Memory Cache (for testing / local dev)
// ─────────────────────────────────────────────

export class InMemoryContextCache implements ContextCache {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  clear(): void {
    this.store.clear();
  }
}

// ─────────────────────────────────────────────
// API Route Handlers
// ─────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createContextAssemblerRouter(
  cache: ContextCache,
  db: ContextDatabase,
): Router {
  const router = Router();

  router.post('/assemble-context', async (req: Request, res: Response) => {
    try {
      const input = ContextAssemblerInputSchema.parse(req.body);
      const result = await assembleContext(input, cache, db);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[ContextAssembler] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Context assembly failed',
      });
    }
  });

  return router;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  estimateTokens,
  truncateToTokenBudget,
  assembleFromDatabase,
  CACHE_TTL_SECONDS,
};
