/**
 * Brain Events & Redis Cache — KAN-33
 *
 * Publishes brain.updated events to Pub/Sub when Brain content changes,
 * pre-caches assembled Brain context in Redis for Decision Engine retrieval,
 * and handles cache invalidation on Brain changes.
 *
 * Subtasks:
 *   KAN-147: brain.updated event schema
 *   KAN-148: Brain context assembler
 *   KAN-149: Redis pre-cache for Brain context
 *   KAN-150: Cache invalidation on Brain changes
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const router = Router();

// ━━ Redis Client ━━

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });
    redisClient.on('error', (err) => {
      console.error('Redis connection error:', err);
    });
  }
  return redisClient;
}

// ━━ KAN-147: Event Schemas ━━

const BrainUpdateSourceSchema = z.enum([
  'contact_ingested',
  'knowledge_updated',
  'company_truth_updated',
  'outcome_recorded',
  'conversation_completed',
  'manual_refresh',
  'embedding_updated',
  'brain_snapshot_created',
]);
type BrainUpdateSource = z.infer<typeof BrainUpdateSourceSchema>;

const BrainUpdatedEventSchema = z.object({
  eventType: z.literal('brain.updated'),
  tenantId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  source: BrainUpdateSourceSchema,
  timestamp: z.string().datetime(),
  payload: z.object({
    snapshotVersion: z.number().int().optional(),
    objectiveGap: z.record(z.string(), z.any()).optional(),
    strategyContext: z.record(z.string(), z.any()).optional(),
    affectedCategories: z.array(z.string()).optional(),
    contactSegment: z.string().optional(),
    contactLifecycleStage: z.string().optional(),
    confidenceScore: z.number().min(0).max(100).optional(),
  }),
  metadata: z.object({
    correlationId: z.string().uuid(),
    processingTimeMs: z.number().int().optional(),
    cacheInvalidated: z.boolean().default(false),
  }),
});
type BrainUpdatedEvent = z.infer<typeof BrainUpdatedEventSchema>;

// ━━ Brain Context Types ━━

interface BrainContext {
  tenantId: string;
  snapshotVersion: number;
  assembledAt: string;
  companyTruth: CompanyTruth;
  industryBlueprint: IndustryBlueprint;
  behavioralLearning: BehavioralLearning;
  outcomeLearning: OutcomeLearning;
  knowledgeSummary: KnowledgeSummary;
}

interface ContactBrainContext extends BrainContext {
  contactId: string;
  contactState: ContactState;
  contactHistory: ContactHistoryEntry[];
}

interface CompanyTruth {
  products: any[];
  pricing: any;
  positioning: string;
  constraints: any;
  customFields: Record<string, any>;
}

interface IndustryBlueprint {
  vertical: string;
  customerModel: any;
  journeys: any[];
  strategyTemplates: any[];
  kpis: any[];
}

interface BehavioralLearning {
  bestTimeSlots: Record<string, number>;
  bestChannels: Record<string, number>;
  responseRates: Record<string, number>;
  engagementPatterns: any;
}

interface OutcomeLearning {
  strategyWinRates: Record<string, number>;
  channelConversionRates: Record<string, number>;
  segmentPerformance: Record<string, any>;
  avgTimeToConversion: number | null;
}

interface KnowledgeSummary {
  totalEntries: number;
  categoryCounts: Record<string, number>;
  lastUpdated: string | null;
  trainedPercentage: number;
}

interface ContactState {
  objectiveId: string | null;
  subObjectives: any;
  strategyCurrent: string | null;
  confidenceScore: number;
  lifecycleStage: string;
  segment: string | null;
  lastInteractionAt: string | null;
}

interface ContactHistoryEntry {
  type: string;
  channel: string | null;
  timestamp: string;
  outcome: string | null;
  summary: string | null;
}

// ━━ Cache Keys ━━

const CACHE_PREFIX = 'brain:';
const CACHE_TTL = 3600; // 1 hour default
const CONTACT_CACHE_TTL = 1800; // 30 minutes for contact-specific context

function tenantCacheKey(tenantId: string): string {
  return `${CACHE_PREFIX}tenant:${tenantId}`;
}

function contactCacheKey(tenantId: string, contactId: string): string {
  return `${CACHE_PREFIX}contact:${tenantId}:${contactId}`;
}

function tenantVersionKey(tenantId: string): string {
  return `${CACHE_PREFIX}version:${tenantId}`;
}

// ━━ KAN-148: Brain Context Assembler ━━

/**
 * Assemble full tenant-level Brain context from database.
 * This is the cold-cache path — used when Redis cache is empty or stale.
 */
async function assembleTenantBrainContext(tenantId: string): Promise<BrainContext> {
  const startTime = Date.now();

  // Parallel fetch all Brain components
  const [
    snapshotResult,
    tenantResult,
    knowledgeStats,
    strategyWeights,
    behavioralData,
  ] = await Promise.all([
    // Latest brain snapshot
    prisma.$queryRawUnsafe<any[]>(`
      SELECT id::text, version, company_truth, behavioral_model, outcome_model, created_at
      FROM brain_snapshots
      WHERE tenant_id = '${tenantId}'::uuid
      ORDER BY version DESC
      LIMIT 1
    `),
    // Tenant + blueprint info
    prisma.$queryRawUnsafe<any[]>(`
      SELECT t.id::text, t.plan_tier, t.ai_permissions, t.confidence_threshold,
             b.vertical, b.customer_model, b.journeys, b.strategy_templates, b.kpis
      FROM tenants t
      LEFT JOIN blueprints b ON t.blueprint_id = b.id
      WHERE t.id = '${tenantId}'::uuid
    `),
    // Knowledge base stats
    prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE ai_trained = true)::int as trained,
        jsonb_object_agg(category, cat_count) as category_counts,
        MAX(updated_at) as last_updated
      FROM (
        SELECT category, COUNT(*)::int as cat_count, MAX(updated_at) as updated_at, bool_and(ai_trained) as ai_trained
        FROM knowledge_base
        WHERE tenant_id = '${tenantId}'::uuid AND is_active = true
        GROUP BY category
      ) sub
    `),
    // Strategy weights (outcome learning)
    prisma.$queryRawUnsafe<any[]>(`
      SELECT strategy_type, segment, win_rate, sample_size
      FROM strategy_weights
      WHERE tenant_id = '${tenantId}'::uuid
      ORDER BY updated_at DESC
    `),
    // Behavioral learning aggregates
    prisma.$queryRawUnsafe<any[]>(`
      SELECT
        jsonb_object_agg(COALESCE(channel, 'unknown'), response_count) as channel_responses,
        jsonb_object_agg(COALESCE(time_slot, 'unknown'), engagement_count) as time_engagement
      FROM (
        SELECT channel, COUNT(*) as response_count, NULL as time_slot, NULL as engagement_count
        FROM actions
        WHERE tenant_id = '${tenantId}'::uuid AND status = 'delivered'
        GROUP BY channel
        UNION ALL
        SELECT NULL, NULL, EXTRACT(HOUR FROM sent_at)::text, COUNT(*)
        FROM actions
        WHERE tenant_id = '${tenantId}'::uuid AND status = 'delivered'
        GROUP BY EXTRACT(HOUR FROM sent_at)
      ) sub
    `).catch(() => [{}]),
  ]);

  const snapshot = snapshotResult[0] || {};
  const tenant = tenantResult[0] || {};
  const kStats = knowledgeStats[0] || {};

  // Assemble strategy win rates
  const strategyWinRates: Record<string, number> = {};
  const channelConversionRates: Record<string, number> = {};
  for (const sw of strategyWeights) {
    const key = sw.segment ? `${sw.strategy_type}:${sw.segment}` : sw.strategy_type;
    strategyWinRates[key] = sw.win_rate;
  }

  // Assemble behavioral learning
  const behavioral = behavioralData[0] || {};
  const bestTimeSlots: Record<string, number> = {};
  const bestChannels: Record<string, number> = {};

  if (behavioral.time_engagement) {
    for (const [hour, count] of Object.entries(behavioral.time_engagement)) {
      bestTimeSlots[hour] = count as number;
    }
  }
  if (behavioral.channel_responses) {
    for (const [channel, count] of Object.entries(behavioral.channel_responses)) {
      bestChannels[channel] = count as number;
    }
  }

  const totalEntries = kStats.total || 0;
  const trainedEntries = kStats.trained || 0;

  const context: BrainContext = {
    tenantId,
    snapshotVersion: snapshot.version || 0,
    assembledAt: new Date().toISOString(),
    companyTruth: {
      products: snapshot.company_truth?.products || [],
      pricing: snapshot.company_truth?.pricing || {},
      positioning: snapshot.company_truth?.positioning || '',
      constraints: snapshot.company_truth?.constraints || {},
      customFields: snapshot.company_truth?.customFields || {},
    },
    industryBlueprint: {
      vertical: tenant.vertical || 'general',
      customerModel: tenant.customer_model || {},
      journeys: tenant.journeys || [],
      strategyTemplates: tenant.strategy_templates || [],
      kpis: tenant.kpis || [],
    },
    behavioralLearning: {
      bestTimeSlots,
      bestChannels,
      responseRates: {},
      engagementPatterns: behavioral,
    },
    outcomeLearning: {
      strategyWinRates,
      channelConversionRates,
      segmentPerformance: {},
      avgTimeToConversion: null,
    },
    knowledgeSummary: {
      totalEntries,
      categoryCounts: kStats.category_counts || {},
      lastUpdated: kStats.last_updated?.toISOString?.() || kStats.last_updated || null,
      trainedPercentage: totalEntries > 0 ? Math.round((trainedEntries / totalEntries) * 100) : 0,
    },
  };

  const elapsed = Date.now() - startTime;
  console.log(`Brain context assembled for tenant ${tenantId} in ${elapsed}ms`);

  return context;
}

/**
 * Assemble contact-specific Brain context.
 * Extends tenant context with contact state and recent history.
 */
async function assembleContactBrainContext(
  tenantId: string,
  contactId: string
): Promise<ContactBrainContext> {
  // Get tenant context (from cache or assemble)
  const tenantContext = await getCachedTenantContext(tenantId);

  // Fetch contact-specific data in parallel
  const [contactStateResult, historyResult] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(`
      SELECT cs.objective_id::text, cs.sub_objectives, cs.strategy_current,
             cs.confidence_score, c.lifecycle_stage, c.segment,
             c.email, c.phone, c.data_quality_score
      FROM contacts c
      LEFT JOIN contact_states cs ON cs.contact_id = c.id
      WHERE c.id = '${contactId}'::uuid AND c.tenant_id = '${tenantId}'::uuid
      LIMIT 1
    `),
    prisma.$queryRawUnsafe<any[]>(`
      SELECT a.agent_type as type, a.channel, a.sent_at as timestamp,
             a.status as outcome, d.reasoning as summary
      FROM actions a
      LEFT JOIN decisions d ON a.decision_id = d.id
      WHERE a.tenant_id = '${tenantId}'::uuid
        AND EXISTS (
          SELECT 1 FROM decisions dd
          WHERE dd.id = a.decision_id AND dd.contact_id = '${contactId}'::uuid
        )
      ORDER BY a.sent_at DESC
      LIMIT 20
    `),
  ]);

  const cs = contactStateResult[0] || {};

  const contactContext: ContactBrainContext = {
    ...tenantContext,
    contactId,
    contactState: {
      objectiveId: cs.objective_id || null,
      subObjectives: cs.sub_objectives || {},
      strategyCurrent: cs.strategy_current || null,
      confidenceScore: cs.confidence_score || 0,
      lifecycleStage: cs.lifecycle_stage || 'unknown',
      segment: cs.segment || null,
      lastInteractionAt: null,
    },
    contactHistory: historyResult.map((h: any) => ({
      type: h.type || 'unknown',
      channel: h.channel || null,
      timestamp: h.timestamp?.toISOString?.() || h.timestamp || '',
      outcome: h.outcome || null,
      summary: h.summary || null,
    })),
  };

  // Set last interaction from history
  if (contactContext.contactHistory.length > 0) {
    contactContext.contactState.lastInteractionAt = contactContext.contactHistory[0].timestamp;
  }

  return contactContext;
}

// ━━ KAN-149: Redis Pre-Cache ━━

/**
 * Get tenant Brain context from Redis cache, or assemble and cache it.
 */
async function getCachedTenantContext(tenantId: string): Promise<BrainContext> {
  const redis = getRedis();
  const key = tenantCacheKey(tenantId);

  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as BrainContext;
    }
  } catch (err) {
    console.warn('Redis read failed, assembling from DB:', err);
  }

  // Cache miss — assemble from DB
  const context = await assembleTenantBrainContext(tenantId);

  // Cache it
  try {
    await redis.setex(key, CACHE_TTL, JSON.stringify(context));
    await redis.set(tenantVersionKey(tenantId), String(context.snapshotVersion));
  } catch (err) {
    console.warn('Redis write failed:', err);
  }

  return context;
}

/**
 * Get contact Brain context from Redis cache, or assemble and cache it.
 */
async function getCachedContactContext(
  tenantId: string,
  contactId: string
): Promise<ContactBrainContext> {
  const redis = getRedis();
  const key = contactCacheKey(tenantId, contactId);

  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as ContactBrainContext;
    }
  } catch (err) {
    console.warn('Redis read failed for contact context:', err);
  }

  // Cache miss
  const context = await assembleContactBrainContext(tenantId, contactId);

  try {
    await redis.setex(key, CONTACT_CACHE_TTL, JSON.stringify(context));
  } catch (err) {
    console.warn('Redis write failed for contact context:', err);
  }

  return context;
}

/**
 * Pre-warm tenant Brain cache. Called after brain changes
 * to ensure Decision Engine always hits warm cache.
 */
async function prewarmTenantCache(tenantId: string): Promise<void> {
  const context = await assembleTenantBrainContext(tenantId);
  const redis = getRedis();

  try {
    await redis.setex(tenantCacheKey(tenantId), CACHE_TTL, JSON.stringify(context));
    await redis.set(tenantVersionKey(tenantId), String(context.snapshotVersion));
  } catch (err) {
    console.warn('Redis prewarm failed:', err);
  }
}

// ━━ KAN-150: Cache Invalidation ━━

/**
 * Invalidate tenant Brain cache. Called when Brain content changes.
 */
async function invalidateTenantCache(tenantId: string): Promise<void> {
  const redis = getRedis();

  try {
    await redis.del(tenantCacheKey(tenantId));
    console.log(`Brain cache invalidated for tenant ${tenantId}`);
  } catch (err) {
    console.warn('Redis invalidation failed:', err);
  }
}

/**
 * Invalidate contact-specific Brain cache.
 */
async function invalidateContactCache(tenantId: string, contactId: string): Promise<void> {
  const redis = getRedis();

  try {
    await redis.del(contactCacheKey(tenantId, contactId));
  } catch (err) {
    console.warn('Redis contact invalidation failed:', err);
  }
}

/**
 * Invalidate all contact caches for a tenant.
 * Used when tenant-level Brain data changes (company truth, knowledge, etc).
 */
async function invalidateAllContactCaches(tenantId: string): Promise<number> {
  const redis = getRedis();
  let deleted = 0;

  try {
    const pattern = `${CACHE_PREFIX}contact:${tenantId}:*`;
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');

    console.log(`Invalidated ${deleted} contact caches for tenant ${tenantId}`);
  } catch (err) {
    console.warn('Redis bulk contact invalidation failed:', err);
  }

  return deleted;
}

// ━━ Pub/Sub Event Publishing ━━

/**
 * Publish brain.updated event to Pub/Sub.
 * In production, this publishes to Google Cloud Pub/Sub.
 * MVP: logs the event and triggers direct subscribers.
 */
async function publishBrainUpdatedEvent(event: BrainUpdatedEvent): Promise<void> {
  // Validate event schema
  const validated = BrainUpdatedEventSchema.parse(event);

  // Log for audit trail
  console.log(`[brain.updated] tenant=${validated.tenantId} source=${validated.source}` +
    (validated.contactId ? ` contact=${validated.contactId}` : ''));

  // MVP: Direct in-process event dispatch
  // Phase 2: Replace with actual Pub/Sub publish
  try {
    // Store event in audit log
    await prisma.$queryRawUnsafe(`
      INSERT INTO audit_log (tenant_id, actor, action_type, payload, reasoning, created_at)
      VALUES (
        '${validated.tenantId}'::uuid,
        'brain_service',
        'brain.updated',
        '${JSON.stringify(validated).replace(/'/g, "''")}'::jsonb,
        'Brain updated from ${validated.source}',
        NOW()
      )
    `).catch((err: any) => {
      // Audit log table may not exist yet — don't fail
      console.warn('Audit log write skipped:', err.message);
    });

    // In production: publish to Pub/Sub topic
    // const pubsub = new PubSub();
    // const topic = pubsub.topic('brain.updated');
    // await topic.publishMessage({ json: validated });

  } catch (error) {
    console.error('Failed to publish brain.updated event:', error);
    // Don't throw — event publishing is best-effort
  }
}

/**
 * Generate a correlation ID for event tracing.
 */
function generateCorrelationId(): string {
  return crypto.randomUUID();
}

// ━━ Orchestrator: Handle Brain Change ━━

/**
 * Main orchestrator called when Brain content changes.
 * 1. Invalidates relevant caches
 * 2. Pre-warms tenant cache
 * 3. Publishes brain.updated event
 */
async function handleBrainChange(
  tenantId: string,
  source: BrainUpdateSource,
  options: {
    contactId?: string;
    affectedCategories?: string[];
    snapshotVersion?: number;
    objectiveGap?: Record<string, any>;
    strategyContext?: Record<string, any>;
  } = {}
): Promise<void> {
  const startTime = Date.now();
  const correlationId = generateCorrelationId();

  try {
    // Step 1: Invalidate caches
    await invalidateTenantCache(tenantId);

    if (options.contactId) {
      await invalidateContactCache(tenantId, options.contactId);
    } else {
      // Tenant-level change — invalidate all contact caches
      await invalidateAllContactCaches(tenantId);
    }

    // Step 2: Pre-warm tenant cache
    await prewarmTenantCache(tenantId);

    const processingTimeMs = Date.now() - startTime;

    // Step 3: Publish event
    const event: BrainUpdatedEvent = {
      eventType: 'brain.updated',
      tenantId,
      contactId: options.contactId,
      source,
      timestamp: new Date().toISOString(),
      payload: {
        snapshotVersion: options.snapshotVersion,
        objectiveGap: options.objectiveGap,
        strategyContext: options.strategyContext,
        affectedCategories: options.affectedCategories,
      },
      metadata: {
        correlationId,
        processingTimeMs,
        cacheInvalidated: true,
      },
    };

    await publishBrainUpdatedEvent(event);

    console.log(`Brain change processed for tenant ${tenantId} in ${processingTimeMs}ms`);
  } catch (error) {
    console.error('handleBrainChange error:', error);
    // Don't throw — Brain change handling is best-effort
  }
}

// ━━ API Routes ━━

/**
 * GET /brain/context/:tenantId
 * Get assembled Brain context for a tenant (from cache or fresh).
 * Used by Decision Engine for fast context retrieval.
 */
router.get('/brain/context/:tenantId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.params.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const startTime = Date.now();
    const context = await getCachedTenantContext(tenantId);
    const elapsed = Date.now() - startTime;

    return res.json({
      context,
      meta: {
        retrievalTimeMs: elapsed,
        fromCache: elapsed < 50, // Heuristic: <50ms = cache hit
      },
    });
  } catch (error: any) {
    console.error('Get brain context error:', error);
    return res.status(500).json({ error: 'Failed to get brain context', details: error.message });
  }
});

/**
 * GET /brain/context/:tenantId/contact/:contactId
 * Get contact-specific Brain context (tenant + contact state + history).
 * Primary endpoint for Decision Engine per-contact decisions.
 */
router.get('/brain/context/:tenantId/contact/:contactId', async (req: Request, res: Response) => {
  try {
    const { tenantId, contactId } = req.params;
    if (!tenantId || !contactId) {
      return res.status(400).json({ error: 'tenantId and contactId required' });
    }

    const startTime = Date.now();
    const context = await getCachedContactContext(tenantId, contactId);
    const elapsed = Date.now() - startTime;

    return res.json({
      context,
      meta: {
        retrievalTimeMs: elapsed,
        fromCache: elapsed < 50,
      },
    });
  } catch (error: any) {
    console.error('Get contact brain context error:', error);
    return res.status(500).json({ error: 'Failed to get contact brain context', details: error.message });
  }
});

/**
 * POST /brain/refresh/:tenantId
 * Force refresh Brain cache for a tenant.
 * Invalidates cache, reassembles, and publishes event.
 */
router.post('/brain/refresh/:tenantId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.params.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const startTime = Date.now();
    await handleBrainChange(tenantId, 'manual_refresh');
    const elapsed = Date.now() - startTime;

    return res.json({
      status: 'refreshed',
      processingTimeMs: elapsed,
    });
  } catch (error: any) {
    console.error('Brain refresh error:', error);
    return res.status(500).json({ error: 'Failed to refresh brain', details: error.message });
  }
});

/**
 * POST /brain/notify
 * Receive brain change notifications from other services.
 * Called by Ingestion Service, Knowledge Center, etc.
 */
router.post('/brain/notify', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      tenantId: z.string().uuid(),
      source: BrainUpdateSourceSchema,
      contactId: z.string().uuid().optional(),
      affectedCategories: z.array(z.string()).optional(),
    });

    const data = schema.parse(req.body);

    await handleBrainChange(data.tenantId, data.source, {
      contactId: data.contactId,
      affectedCategories: data.affectedCategories,
    });

    return res.json({ status: 'acknowledged' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Brain notify error:', error);
    return res.status(500).json({ error: 'Failed to process notification', details: error.message });
  }
});

/**
 * GET /brain/cache/stats
 * Get Brain cache statistics for monitoring.
 */
router.get('/brain/cache/stats', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const redis = getRedis();
    const tenantCached = await redis.exists(tenantCacheKey(tenantId));
    const version = await redis.get(tenantVersionKey(tenantId));

    // Count contact caches
    let contactCacheCount = 0;
    let cursor = '0';
    const pattern = `${CACHE_PREFIX}contact:${tenantId}:*`;
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      contactCacheCount += keys.length;
    } while (cursor !== '0');

    // Get TTL
    const ttl = tenantCached ? await redis.ttl(tenantCacheKey(tenantId)) : -1;

    return res.json({
      tenantCached: tenantCached === 1,
      snapshotVersion: version ? parseInt(version) : null,
      contactCacheCount,
      tenantCacheTtlSeconds: ttl,
      cachePrefix: CACHE_PREFIX,
    });
  } catch (error: any) {
    console.error('Cache stats error:', error);
    return res.status(500).json({ error: 'Failed to get cache stats', details: error.message });
  }
});

/**
 * DELETE /brain/cache/:tenantId
 * Manually purge all Brain caches for a tenant.
 */
router.delete('/brain/cache/:tenantId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.params.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    await invalidateTenantCache(tenantId);
    const contactsInvalidated = await invalidateAllContactCaches(tenantId);

    const redis = getRedis();
    await redis.del(tenantVersionKey(tenantId));

    return res.json({
      status: 'purged',
      contactCachesInvalidated: contactsInvalidated,
    });
  } catch (error: any) {
    console.error('Cache purge error:', error);
    return res.status(500).json({ error: 'Failed to purge cache', details: error.message });
  }
});

// ━━ Cleanup ━━

async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

export default router;
export {
  // Context assembly
  assembleTenantBrainContext,
  assembleContactBrainContext,
  // Cache operations
  getCachedTenantContext,
  getCachedContactContext,
  prewarmTenantCache,
  // Cache invalidation
  invalidateTenantCache,
  invalidateContactCache,
  invalidateAllContactCaches,
  // Event publishing
  publishBrainUpdatedEvent,
  handleBrainChange,
  // Cleanup
  closeRedis,
  getRedis,
};
export {
  BrainUpdatedEventSchema,
  BrainUpdateSourceSchema,
};
export type {
  BrainUpdatedEvent,
  BrainUpdateSource,
  BrainContext,
  ContactBrainContext,
  CompanyTruth,
  IndustryBlueprint,
  BehavioralLearning,
  OutcomeLearning,
  KnowledgeSummary,
  ContactState,
  ContactHistoryEntry,
};
