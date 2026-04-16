/**
 * Brain Embeddings Service — KAN-31
 *
 * pgvector-powered semantic search for the Business Brain.
 * Uses text-embedding-3-small (OpenAI) for embeddings,
 * stored with strict tenant_id namespacing.
 *
 * Subtasks:
 * - KAN-141: Embeddings table with tenant namespace
 * - KAN-142: Embedding generation pipeline
 * - KAN-143: Similarity search with tenant isolation
 */

import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();
const router = Router();

// ━━ KAN-141: Embeddings Table Schema ━━
// Note: The actual pgvector extension and table creation is handled via Prisma migration.
// Migration SQL (to be run separately):
//
// CREATE EXTENSION IF NOT EXISTS vector;
//
// CREATE TABLE brain_embeddings (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
//   content_type VARCHAR(50) NOT NULL,
//   content_id VARCHAR(255) NOT NULL,
//   content_text TEXT NOT NULL,
//   embedding vector(1536) NOT NULL,
//   metadata JSONB DEFAULT '{}',
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   updated_at TIMESTAMPTZ DEFAULT NOW(),
//   CONSTRAINT unique_tenant_content UNIQUE(tenant_id, content_type, content_id)
// );
//
// CREATE INDEX idx_brain_embeddings_tenant ON brain_embeddings(tenant_id);
// CREATE INDEX idx_brain_embeddings_type ON brain_embeddings(tenant_id, content_type);
// CREATE INDEX idx_brain_embeddings_vector ON brain_embeddings
//   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

// ━━ Zod Schemas ━━

const ContentTypeSchema = z.enum([
  'company_truth',
  'blueprint',
  'contact_context',
  'interaction_summary',
  'outcome_pattern',
  'knowledge_article',
  'product_info',
  'objection_handling',
  'strategy_context',
  'custom',
]);
type ContentType = z.infer<typeof ContentTypeSchema>;

const EmbeddingRequestSchema = z.object({
  contentType: ContentTypeSchema,
  contentId: z.string().min(1),
  contentText: z.string().min(1).max(8000),
  metadata: z.record(z.any()).optional(),
});

const BatchEmbeddingRequestSchema = z.object({
  items: z.array(EmbeddingRequestSchema).min(1).max(100),
});

const SimilaritySearchSchema = z.object({
  query: z.string().min(1).max(2000),
  contentTypes: z.array(ContentTypeSchema).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.7),
  includeContent: z.boolean().default(true),
});

const BulkDeleteSchema = z.object({
  contentType: ContentTypeSchema.optional(),
  contentIds: z.array(z.string()).optional(),
});

// ━━ OpenAI Embedding Client ━━

const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

/**
 * Generate embedding using OpenAI text-embedding-3-small.
 * Uses GCP Secret Manager for API key in production.
 */
async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error: ${response.status} - ${JSON.stringify(error)}`);
  }

  const data = await response.json() as any;
  return {
    embedding: data.data[0].embedding,
    tokenCount: data.usage?.total_tokens || 0,
  };
}

/**
 * Generate embeddings for multiple texts in a single API call.
 * OpenAI supports batch embedding — more efficient than individual calls.
 */
async function generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error: ${response.status} - ${JSON.stringify(error)}`);
  }

  const data = await response.json() as any;
  const totalTokens = data.usage?.total_tokens || 0;
  const tokensPerItem = Math.ceil(totalTokens / texts.length);

  return data.data.map((item: any) => ({
    embedding: item.embedding,
    tokenCount: tokensPerItem,
  }));
}

// ━━ Core Functions ━━

/**
 * Store or update an embedding for a piece of content.
 * Uses UPSERT — if content_id already exists for this tenant+type, it updates.
 */
async function upsertEmbedding(
  tenantId: string,
  contentType: ContentType,
  contentId: string,
  contentText: string,
  metadata: Record<string, any> = {}
): Promise<{ id: string; isNew: boolean }> {
  const { embedding } = await generateEmbedding(contentText);
  const vectorStr = `[${embedding.join(',')}]`;

  const result = await prisma.$queryRaw<{ id: string; is_new: boolean }[]>`
    INSERT INTO brain_embeddings (tenant_id, content_type, content_id, content_text, embedding, metadata, updated_at)
    VALUES (
      ${tenantId}::uuid,
      ${contentType},
      ${contentId},
      ${contentText},
      ${vectorStr}::vector,
      ${JSON.stringify(metadata)}::jsonb,
      NOW()
    )
    ON CONFLICT (tenant_id, content_type, content_id)
    DO UPDATE SET
      content_text = EXCLUDED.content_text,
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id::text, (xmax = 0) as is_new
  `;

  return {
    id: result[0].id,
    isNew: result[0].is_new,
  };
}

/**
 * Batch upsert embeddings — generates all embeddings in one API call.
 */
async function batchUpsertEmbeddings(
  tenantId: string,
  items: Array<{
    contentType: ContentType;
    contentId: string;
    contentText: string;
    metadata?: Record<string, any>;
  }>
): Promise<{ inserted: number; updated: number }> {
  const texts = items.map(item => item.contentText);
  const embeddings = await generateBatchEmbeddings(texts);

  let inserted = 0;
  let updated = 0;

  // Process in a transaction for consistency
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const vectorStr = `[${embeddings[i].embedding.join(',')}]`;
      const meta = JSON.stringify(item.metadata || {});

      const result = await tx.$queryRaw<{ is_new: boolean }[]>`
        INSERT INTO brain_embeddings (tenant_id, content_type, content_id, content_text, embedding, metadata, updated_at)
        VALUES (
          ${tenantId}::uuid,
          ${item.contentType},
          ${item.contentId},
          ${item.contentText},
          ${vectorStr}::vector,
          ${meta}::jsonb,
          NOW()
        )
        ON CONFLICT (tenant_id, content_type, content_id)
        DO UPDATE SET
          content_text = EXCLUDED.content_text,
          embedding = EXCLUDED.embedding,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING (xmax = 0) as is_new
      `;

      if (result[0].is_new) {
        inserted++;
      } else {
        updated++;
      }
    }
  });

  return { inserted, updated };
}

/**
 * KAN-143: Similarity search with strict tenant isolation.
 * Uses cosine distance via pgvector's <=> operator.
 */
async function similaritySearch(
  tenantId: string,
  query: string,
  options: {
    contentTypes?: ContentType[];
    limit?: number;
    threshold?: number;
    includeContent?: boolean;
  } = {}
): Promise<Array<{
  id: string;
  contentType: string;
  contentId: string;
  contentText?: string;
  metadata: Record<string, any>;
  similarity: number;
}>> {
  const { contentTypes, limit = 10, threshold = 0.7, includeContent = true } = options;

  const { embedding } = await generateEmbedding(query);
  const vectorStr = `[${embedding.join(',')}]`;

  // Build content type filter
  let typeFilter = '';
  if (contentTypes && contentTypes.length > 0) {
    const types = contentTypes.map(t => `'${t}'`).join(',');
    typeFilter = `AND content_type IN (${types})`;
  }

  const contentSelect = includeContent ? 'content_text,' : '';

  const results = await prisma.$queryRawUnsafe<any[]>(`
    SELECT
      id::text,
      content_type,
      content_id,
      ${contentSelect}
      metadata,
      1 - (embedding <=> '${vectorStr}'::vector) as similarity
    FROM brain_embeddings
    WHERE tenant_id = '${tenantId}'::uuid
      ${typeFilter}
      AND 1 - (embedding <=> '${vectorStr}'::vector) >= ${threshold}
    ORDER BY embedding <=> '${vectorStr}'::vector
    LIMIT ${limit}
  `);

  return results.map(row => ({
    id: row.id,
    contentType: row.content_type,
    contentId: row.content_id,
    ...(includeContent && { contentText: row.content_text }),
    metadata: row.metadata || {},
    similarity: parseFloat(row.similarity),
  }));
}

/**
 * Delete embeddings by content type and/or content IDs.
 */
async function deleteEmbeddings(
  tenantId: string,
  options: {
    contentType?: ContentType;
    contentIds?: string[];
  } = {}
): Promise<number> {
  const { contentType, contentIds } = options;

  let whereClause = `tenant_id = '${tenantId}'::uuid`;
  if (contentType) {
    whereClause += ` AND content_type = '${contentType}'`;
  }
  if (contentIds && contentIds.length > 0) {
    const ids = contentIds.map(id => `'${id}'`).join(',');
    whereClause += ` AND content_id IN (${ids})`;
  }

  const result = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `DELETE FROM brain_embeddings WHERE ${whereClause} RETURNING COUNT(*) OVER() as count`
  );

  return result.length > 0 ? Number(result[0].count) : 0;
}

/**
 * Get embedding stats for a tenant.
 */
async function getEmbeddingStats(tenantId: string): Promise<{
  totalEmbeddings: number;
  byContentType: Record<string, number>;
  oldestUpdated: string | null;
  newestUpdated: string | null;
}> {
  const stats = await prisma.$queryRaw<any[]>`
    SELECT
      content_type,
      COUNT(*)::int as count,
      MIN(updated_at) as oldest,
      MAX(updated_at) as newest
    FROM brain_embeddings
    WHERE tenant_id = ${tenantId}::uuid
    GROUP BY content_type
    ORDER BY count DESC
  `;

  const byContentType: Record<string, number> = {};
  let totalEmbeddings = 0;
  let oldestUpdated: string | null = null;
  let newestUpdated: string | null = null;

  for (const row of stats) {
    byContentType[row.content_type] = row.count;
    totalEmbeddings += row.count;
    if (!oldestUpdated || row.oldest < oldestUpdated) oldestUpdated = row.oldest;
    if (!newestUpdated || row.newest > newestUpdated) newestUpdated = row.newest;
  }

  return { totalEmbeddings, byContentType, oldestUpdated, newestUpdated };
}

// ━━ Brain Context Assembly ━━

/**
 * Assemble relevant Brain context for the Decision Engine.
 * This is the primary consumer of similarity search — it gathers
 * all relevant context for a contact's current decision.
 */
async function assembleBrainContext(
  tenantId: string,
  query: string,
  options: {
    maxTokens?: number;
    priorityTypes?: ContentType[];
  } = {}
): Promise<{
  context: string;
  sources: Array<{ type: string; id: string; similarity: number }>;
  tokenEstimate: number;
}> {
  const { maxTokens = 6000, priorityTypes } = options;

  // Search with generous limit, then trim to token budget
  const results = await similaritySearch(tenantId, query, {
    contentTypes: priorityTypes,
    limit: 30,
    threshold: 0.6,
    includeContent: true,
  });

  const sources: Array<{ type: string; id: string; similarity: number }> = [];
  const contextParts: string[] = [];
  let estimatedTokens = 0;

  for (const result of results) {
    // Rough token estimate: ~4 chars per token
    const textTokens = Math.ceil((result.contentText || '').length / 4);
    if (estimatedTokens + textTokens > maxTokens) break;

    contextParts.push(
      `[${result.contentType}:${result.contentId}] (relevance: ${(result.similarity * 100).toFixed(1)}%)\n${result.contentText}`
    );
    sources.push({
      type: result.contentType,
      id: result.contentId,
      similarity: result.similarity,
    });
    estimatedTokens += textTokens;
  }

  return {
    context: contextParts.join('\n\n---\n\n'),
    sources,
    tokenEstimate: estimatedTokens,
  };
}

// ━━ Auto-Embed Pipeline ━━

/**
 * Auto-embed Company Truth when it changes.
 * Called by the Company Truth service after updates.
 */
async function embedCompanyTruth(
  tenantId: string,
  category: string,
  data: Record<string, any>
): Promise<void> {
  const contentText = formatCompanyTruthForEmbedding(category, data);
  if (!contentText) return;

  await upsertEmbedding(
    tenantId,
    'company_truth',
    `company_truth_${category}`,
    contentText,
    { category, updatedAt: new Date().toISOString() }
  );
}

/**
 * Format Company Truth data into embeddable text.
 */
function formatCompanyTruthForEmbedding(
  category: string,
  data: Record<string, any>
): string {
  switch (category) {
    case 'products':
      if (Array.isArray(data.items)) {
        return data.items.map((p: any) =>
          `Product: ${p.name}. ${p.description || ''} Category: ${p.category || 'N/A'}. Price: ${p.price || 'N/A'}.`
        ).join('\n');
      }
      return JSON.stringify(data);

    case 'pricing':
      if (Array.isArray(data.tiers)) {
        return data.tiers.map((t: any) =>
          `Pricing tier: ${t.name}. ${t.description || ''} Price: ${t.price}/${t.billingCycle || 'month'}. Features: ${(t.features || []).join(', ')}.`
        ).join('\n');
      }
      return JSON.stringify(data);

    case 'positioning':
      const parts: string[] = [];
      if (data.tagline) parts.push(`Tagline: ${data.tagline}`);
      if (data.valueProposition) parts.push(`Value proposition: ${data.valueProposition}`);
      if (data.targetAudience) parts.push(`Target audience: ${data.targetAudience}`);
      if (data.differentiators) parts.push(`Differentiators: ${data.differentiators.join(', ')}`);
      if (data.competitors) parts.push(`Competitors: ${data.competitors.join(', ')}`);
      return parts.join('\n') || JSON.stringify(data);

    case 'constraints':
      const cParts: string[] = [];
      if (data.noContact) cParts.push(`Do not contact: ${data.noContact.join(', ')}`);
      if (data.regulatoryNotes) cParts.push(`Regulatory: ${data.regulatoryNotes}`);
      if (data.brandGuidelines) cParts.push(`Brand guidelines: ${data.brandGuidelines}`);
      if (data.approvalRequired) cParts.push(`Approval required for: ${data.approvalRequired.join(', ')}`);
      return cParts.join('\n') || JSON.stringify(data);

    case 'team':
      if (Array.isArray(data.members)) {
        return data.members.map((m: any) =>
          `Team member: ${m.name}, ${m.role}. ${m.responsibilities || ''}`
        ).join('\n');
      }
      return JSON.stringify(data);

    case 'process':
      if (Array.isArray(data.steps)) {
        return data.steps.map((s: any, i: number) =>
          `Step ${i + 1}: ${s.name}. ${s.description || ''}`
        ).join('\n');
      }
      return JSON.stringify(data);

    default:
      return typeof data === 'string' ? data : JSON.stringify(data);
  }
}

/**
 * Auto-embed contact interaction summary.
 * Called after agent executions to build behavioral context.
 */
async function embedInteraction(
  tenantId: string,
  contactId: string,
  interactionSummary: string,
  metadata: Record<string, any> = {}
): Promise<void> {
  const contentId = `interaction_${contactId}_${Date.now()}`;

  await upsertEmbedding(
    tenantId,
    'interaction_summary',
    contentId,
    interactionSummary,
    { contactId, ...metadata }
  );
}

/**
 * Auto-embed Blueprint content at tenant creation.
 */
async function embedBlueprint(
  tenantId: string,
  blueprintId: string,
  sections: Array<{ key: string; content: string }>
): Promise<void> {
  const items = sections.map(section => ({
    contentType: 'blueprint' as ContentType,
    contentId: `blueprint_${blueprintId}_${section.key}`,
    contentText: section.content,
    metadata: { blueprintId, section: section.key },
  }));

  await batchUpsertEmbeddings(tenantId, items);
}

// ━━ API Routes ━━

/**
 * POST /brain-embeddings/embed
 * Generate and store an embedding for content.
 */
router.post('/brain-embeddings/embed', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { contentType, contentId, contentText, metadata } = EmbeddingRequestSchema.parse(req.body);

    const result = await upsertEmbedding(tenantId, contentType, contentId, contentText, metadata);

    return res.json({
      status: result.isNew ? 'created' : 'updated',
      id: result.id,
      contentType,
      contentId,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Embed error:', error);
    return res.status(500).json({ error: 'Failed to generate embedding', details: error.message });
  }
});

/**
 * POST /brain-embeddings/batch
 * Batch generate and store embeddings.
 */
router.post('/brain-embeddings/batch', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { items } = BatchEmbeddingRequestSchema.parse(req.body);

    const result = await batchUpsertEmbeddings(tenantId, items);

    return res.json({
      status: 'processed',
      inserted: result.inserted,
      updated: result.updated,
      total: items.length,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Batch embed error:', error);
    return res.status(500).json({ error: 'Failed to batch embed', details: error.message });
  }
});

/**
 * POST /brain-embeddings/search
 * KAN-143: Similarity search with tenant isolation.
 */
router.post('/brain-embeddings/search', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { query, contentTypes, limit, threshold, includeContent } =
      SimilaritySearchSchema.parse(req.body);

    const results = await similaritySearch(tenantId, query, {
      contentTypes,
      limit,
      threshold,
      includeContent,
    });

    return res.json({
      results,
      count: results.length,
      query: query.substring(0, 100),
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Search error:', error);
    return res.status(500).json({ error: 'Failed to search', details: error.message });
  }
});

/**
 * POST /brain-embeddings/assemble-context
 * Assemble Brain context for Decision Engine consumption.
 */
router.post('/brain-embeddings/assemble-context', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { query, maxTokens, priorityTypes } = z.object({
      query: z.string().min(1),
      maxTokens: z.number().int().min(500).max(8000).default(6000),
      priorityTypes: z.array(ContentTypeSchema).optional(),
    }).parse(req.body);

    const result = await assembleBrainContext(tenantId, query, {
      maxTokens,
      priorityTypes,
    });

    return res.json({
      context: result.context,
      sources: result.sources,
      tokenEstimate: result.tokenEstimate,
      sourceCount: result.sources.length,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Assemble context error:', error);
    return res.status(500).json({ error: 'Failed to assemble context', details: error.message });
  }
});

/**
 * GET /brain-embeddings/stats
 * Get embedding statistics for the tenant.
 */
router.get('/brain-embeddings/stats', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const stats = await getEmbeddingStats(tenantId);

    return res.json(stats);
  } catch (error: any) {
    console.error('Stats error:', error);
    return res.status(500).json({ error: 'Failed to get stats', details: error.message });
  }
});

/**
 * DELETE /brain-embeddings
 * Delete embeddings by content type and/or IDs.
 */
router.delete('/brain-embeddings', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { contentType, contentIds } = BulkDeleteSchema.parse(req.body);

    if (!contentType && !contentIds) {
      return res.status(400).json({ error: 'Must specify contentType and/or contentIds' });
    }

    const deleted = await deleteEmbeddings(tenantId, { contentType, contentIds });

    return res.json({
      status: 'deleted',
      count: deleted,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Delete error:', error);
    return res.status(500).json({ error: 'Failed to delete', details: error.message });
  }
});

/**
 * GET /brain-embeddings/:contentType/:contentId
 * Get a specific embedding record (without the vector itself).
 */
router.get('/brain-embeddings/:contentType/:contentId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const contentType = ContentTypeSchema.parse(req.params.contentType);
    const { contentId } = req.params;

    const result = await prisma.$queryRaw<any[]>`
      SELECT
        id::text,
        content_type,
        content_id,
        content_text,
        metadata,
        created_at,
        updated_at
      FROM brain_embeddings
      WHERE tenant_id = ${tenantId}::uuid
        AND content_type = ${contentType}
        AND content_id = ${contentId}
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: 'Embedding not found' });
    }

    return res.json({
      id: result[0].id,
      contentType: result[0].content_type,
      contentId: result[0].content_id,
      contentText: result[0].content_text,
      metadata: result[0].metadata,
      createdAt: result[0].created_at,
      updatedAt: result[0].updated_at,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid content type', details: error.errors });
    }
    console.error('Get embedding error:', error);
    return res.status(500).json({ error: 'Failed to get embedding', details: error.message });
  }
});

/**
 * POST /brain-embeddings/rebuild
 * Rebuild all embeddings for a tenant (admin operation).
 * Triggers re-embedding of all Company Truth data.
 */
router.post('/brain-embeddings/rebuild', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { contentTypes } = z.object({
      contentTypes: z.array(ContentTypeSchema).optional(),
    }).parse(req.body);

    // Get the current Brain snapshot for Company Truth
    const snapshot = await prisma.brainSnapshot.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { version: 'desc' },
    });

    if (!snapshot) {
      return res.status(404).json({ error: 'No active Brain snapshot found' });
    }

    const companyTruth = (snapshot as any).companyTruth || {};
    let rebuilt = 0;

    // Rebuild Company Truth embeddings
    if (!contentTypes || contentTypes.includes('company_truth')) {
      for (const [category, data] of Object.entries(companyTruth)) {
        if (data && typeof data === 'object') {
          await embedCompanyTruth(tenantId, category, data as Record<string, any>);
          rebuilt++;
        }
      }
    }

    return res.json({
      status: 'rebuilt',
      categoriesProcessed: rebuilt,
      message: `Rebuilt ${rebuilt} embedding categories for tenant.`,
    });
  } catch (error: any) {
    console.error('Rebuild error:', error);
    return res.status(500).json({ error: 'Failed to rebuild', details: error.message });
  }
});

export default router;
export {
  generateEmbedding,
  generateBatchEmbeddings,
  upsertEmbedding,
  batchUpsertEmbeddings,
  similaritySearch,
  deleteEmbeddings,
  getEmbeddingStats,
  assembleBrainContext,
  embedCompanyTruth,
  embedInteraction,
  embedBlueprint,
  formatCompanyTruthForEmbedding,
};
export {
  ContentTypeSchema,
  EmbeddingRequestSchema,
  BatchEmbeddingRequestSchema,
  SimilaritySearchSchema,
};
export type { ContentType, EmbeddingResult };
