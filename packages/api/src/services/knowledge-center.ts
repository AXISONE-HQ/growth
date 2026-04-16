/**
 * Knowledge Center CRUD API — KAN-32
 *
 * Provides CRUD operations for the Knowledge Center, organized into 6 categories:
 * - Company Info: business details, hours, locations, contact info
 * - Products: product catalog, features, specifications
 * - Warranty: warranty policies, terms, claim procedures
 * - Shipping: shipping methods, rates, delivery timelines
 * - Financing: payment options, financing plans, credit terms
 * - FAQs: frequently asked questions and answers
 *
 * Each entry uses field-value storage with AI Trained status tracking.
 * Changes trigger Brain embedding updates via the embeddings pipeline.
 *
 * Subtasks:
 *   KAN-144: knowledge_base table and Prisma model
 *   KAN-145: CRUD endpoints for all 6 categories
 *   KAN-146: Trigger Brain embedding update on knowledge change
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();

// ━━ Schemas ━━

const KnowledgeCategorySchema = z.enum([
  'company_info',
  'products',
  'warranty',
  'shipping',
  'financing',
  'faqs',
]);
type KnowledgeCategory = z.infer<typeof KnowledgeCategorySchema>;

const KnowledgeEntrySchema = z.object({
  category: KnowledgeCategorySchema,
  title: z.string().min(1).max(500),
  fields: z.record(z.string(), z.any()),
  tags: z.array(z.string()).optional().default([]),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

const UpdateKnowledgeEntrySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  fields: z.record(z.string(), z.any()).optional(),
  tags: z.array(z.string()).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const BulkCreateSchema = z.object({
  category: KnowledgeCategorySchema,
  entries: z.array(z.object({
    title: z.string().min(1).max(500),
    fields: z.record(z.string(), z.any()),
    tags: z.array(z.string()).optional().default([]),
    sortOrder: z.number().int().optional().default(0),
  })),
});

const FAQEntrySchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

// ━━ SQL Schema (KAN-144) ━━
// Run this migration to create the knowledge_base table:
/*
CREATE TABLE knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category VARCHAR(50) NOT NULL,
  title VARCHAR(500) NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  ai_trained BOOLEAN DEFAULT false,
  ai_trained_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_category CHECK (
    category IN ('company_info', 'products', 'warranty', 'shipping', 'financing', 'faqs')
  )
);

CREATE INDEX idx_knowledge_base_tenant ON knowledge_base(tenant_id);
CREATE INDEX idx_knowledge_base_category ON knowledge_base(tenant_id, category);
CREATE INDEX idx_knowledge_base_active ON knowledge_base(tenant_id, is_active) WHERE is_active = true;
CREATE INDEX idx_knowledge_base_tags ON knowledge_base USING GIN(tags);
CREATE INDEX idx_knowledge_base_ai ON knowledge_base(tenant_id, ai_trained) WHERE ai_trained = false;
*/

// ━━ Types ━━

interface KnowledgeEntry {
  id: string;
  tenantId: string;
  category: string;
  title: string;
  fields: Record<string, any>;
  tags: string[];
  sortOrder: number;
  isActive: boolean;
  aiTrained: boolean;
  aiTrainedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ━━ Core CRUD Functions ━━

/**
 * Create a new knowledge entry.
 */
async function createEntry(
  tenantId: string,
  data: z.infer<typeof KnowledgeEntrySchema>
): Promise<KnowledgeEntry> {
  const result = await prisma.$queryRawUnsafe<any[]>(`
    INSERT INTO knowledge_base (tenant_id, category, title, fields, tags, sort_order, is_active)
    VALUES ('${tenantId}'::uuid, '${data.category}', $1, $2::jsonb, $3::text[], ${data.sortOrder}, ${data.isActive})
    RETURNING
      id::text, tenant_id, category, title, fields, tags, sort_order,
      is_active, ai_trained, ai_trained_at, created_at, updated_at
  `, data.title, JSON.stringify(data.fields), data.tags);

  return mapRow(result[0]);
}

/**
 * Get a single knowledge entry by ID.
 */
async function getEntry(
  tenantId: string,
  entryId: string
): Promise<KnowledgeEntry | null> {
  const result = await prisma.$queryRawUnsafe<any[]>(`
    SELECT id::text, tenant_id, category, title, fields, tags, sort_order,
           is_active, ai_trained, ai_trained_at, created_at, updated_at
    FROM knowledge_base
    WHERE tenant_id = '${tenantId}'::uuid AND id = '${entryId}'::uuid
  `);

  return result.length > 0 ? mapRow(result[0]) : null;
}

/**
 * List knowledge entries by category with optional filters.
 */
async function listEntries(
  tenantId: string,
  options: {
    category?: KnowledgeCategory;
    activeOnly?: boolean;
    untrainedOnly?: boolean;
    tag?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ entries: KnowledgeEntry[]; total: number }> {
  const {
    category,
    activeOnly = false,
    untrainedOnly = false,
    tag,
    search,
    limit = 50,
    offset = 0,
  } = options;

  let whereClause = `tenant_id = '${tenantId}'::uuid`;
  if (category) whereClause += ` AND category = '${category}'`;
  if (activeOnly) whereClause += ` AND is_active = true`;
  if (untrainedOnly) whereClause += ` AND ai_trained = false`;
  if (tag) whereClause += ` AND '${tag}' = ANY(tags)`;
  if (search) {
    const escaped = search.replace(/'/g, "''");
    whereClause += ` AND (title ILIKE '%${escaped}%' OR fields::text ILIKE '%${escaped}%')`;
  }

  const countResult = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int as total FROM knowledge_base WHERE ${whereClause}`
  );

  const entries = await prisma.$queryRawUnsafe<any[]>(`
    SELECT id::text, tenant_id, category, title, fields, tags, sort_order,
           is_active, ai_trained, ai_trained_at, created_at, updated_at
    FROM knowledge_base
    WHERE ${whereClause}
    ORDER BY sort_order ASC, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    entries: entries.map(mapRow),
    total: countResult[0]?.total || 0,
  };
}

/**
 * Update a knowledge entry. Resets ai_trained to false on content changes.
 */
async function updateEntry(
  tenantId: string,
  entryId: string,
  data: z.infer<typeof UpdateKnowledgeEntrySchema>
): Promise<KnowledgeEntry | null> {
  const setClauses: string[] = ['updated_at = NOW()'];

  // Content changes reset AI trained status
  let contentChanged = false;

  if (data.title !== undefined) {
    setClauses.push(`title = '${data.title.replace(/'/g, "''")}'`);
    contentChanged = true;
  }
  if (data.fields !== undefined) {
    setClauses.push(`fields = '${JSON.stringify(data.fields)}'::jsonb`);
    contentChanged = true;
  }
  if (data.tags !== undefined) {
    setClauses.push(`tags = ARRAY[${data.tags.map(t => `'${t}'`).join(',')}]::text[]`);
  }
  if (data.sortOrder !== undefined) {
    setClauses.push(`sort_order = ${data.sortOrder}`);
  }
  if (data.isActive !== undefined) {
    setClauses.push(`is_active = ${data.isActive}`);
  }

  // Reset AI trained status when content changes
  if (contentChanged) {
    setClauses.push('ai_trained = false');
    setClauses.push('ai_trained_at = NULL');
  }

  const result = await prisma.$queryRawUnsafe<any[]>(`
    UPDATE knowledge_base
    SET ${setClauses.join(', ')}
    WHERE tenant_id = '${tenantId}'::uuid AND id = '${entryId}'::uuid
    RETURNING id::text, tenant_id, category, title, fields, tags, sort_order,
              is_active, ai_trained, ai_trained_at, created_at, updated_at
  `);

  if (result.length === 0) return null;

  const entry = mapRow(result[0]);

  // KAN-146: Trigger embedding update on content change
  if (contentChanged) {
    await triggerEmbeddingUpdate(tenantId, entry);
  }

  return entry;
}

/**
 * Delete a knowledge entry (hard delete).
 */
async function deleteEntry(
  tenantId: string,
  entryId: string
): Promise<boolean> {
  const result = await prisma.$queryRawUnsafe<any[]>(`
    DELETE FROM knowledge_base
    WHERE tenant_id = '${tenantId}'::uuid AND id = '${entryId}'::uuid
    RETURNING id::text
  `);

  if (result.length > 0) {
    // Delete associated embeddings
    await deleteEntryEmbeddings(tenantId, entryId);
  }

  return result.length > 0;
}

/**
 * Bulk create entries for a category.
 */
async function bulkCreate(
  tenantId: string,
  data: z.infer<typeof BulkCreateSchema>
): Promise<KnowledgeEntry[]> {
  const entries: KnowledgeEntry[] = [];

  for (const entry of data.entries) {
    const created = await createEntry(tenantId, {
      category: data.category,
      title: entry.title,
      fields: entry.fields,
      tags: entry.tags,
      sortOrder: entry.sortOrder,
      isActive: true,
    });
    entries.push(created);
  }

  // Trigger bulk embedding update
  await triggerCategoryEmbeddingUpdate(tenantId, data.category);

  return entries;
}

/**
 * Get category summary stats for a tenant.
 */
async function getCategorySummary(
  tenantId: string
): Promise<Record<string, { total: number; active: number; trained: number }>> {
  const stats = await prisma.$queryRaw<any[]>`
    SELECT
      category,
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE is_active = true)::int as active,
      COUNT(*) FILTER (WHERE ai_trained = true)::int as trained
    FROM knowledge_base
    WHERE tenant_id = ${tenantId}::uuid
    GROUP BY category
    ORDER BY category
  `;

  const summary: Record<string, { total: number; active: number; trained: number }> = {};
  const allCategories: KnowledgeCategory[] = [
    'company_info', 'products', 'warranty', 'shipping', 'financing', 'faqs',
  ];

  // Initialize all categories
  for (const cat of allCategories) {
    summary[cat] = { total: 0, active: 0, trained: 0 };
  }

  // Populate from DB
  for (const row of stats) {
    summary[row.category] = {
      total: row.total,
      active: row.active,
      trained: row.trained,
    };
  }

  return summary;
}

/**
 * Mark entries as AI trained after embedding generation.
 */
async function markAsTrained(
  tenantId: string,
  entryIds: string[]
): Promise<number> {
  if (entryIds.length === 0) return 0;

  const ids = entryIds.map(id => `'${id}'::uuid`).join(',');
  const result = await prisma.$queryRawUnsafe<any[]>(`
    UPDATE knowledge_base
    SET ai_trained = true, ai_trained_at = NOW(), updated_at = NOW()
    WHERE tenant_id = '${tenantId}'::uuid AND id IN (${ids})
    RETURNING id
  `);

  return result.length;
}

// ━━ KAN-146: Embedding Integration ━━

/**
 * Trigger Brain embedding update when knowledge changes.
 * Formats the entry for embedding and calls the embeddings pipeline.
 */
async function triggerEmbeddingUpdate(
  tenantId: string,
  entry: KnowledgeEntry
): Promise<void> {
  try {
    const contentText = formatKnowledgeForEmbedding(entry);
    if (!contentText) return;

    // Import dynamically to avoid circular deps
    const { upsertEmbedding } = await import('./brain-embeddings');

    await upsertEmbedding(
      tenantId,
      'knowledge_base',
      `kb_${entry.category}_${entry.id}`,
      contentText,
      {
        category: entry.category,
        entryId: entry.id,
        title: entry.title,
        tags: entry.tags,
        updatedAt: new Date().toISOString(),
      }
    );

    // Mark as trained
    await markAsTrained(tenantId, [entry.id]);
  } catch (error) {
    console.error('Knowledge embedding update failed:', error);
    // Don't fail the CRUD operation — embedding is async/best-effort
  }
}

/**
 * Trigger embedding update for all entries in a category.
 */
async function triggerCategoryEmbeddingUpdate(
  tenantId: string,
  category: KnowledgeCategory
): Promise<void> {
  try {
    const { entries } = await listEntries(tenantId, {
      category,
      activeOnly: true,
      limit: 1000,
    });

    const { batchUpsertEmbeddings } = await import('./brain-embeddings');

    const items = entries
      .map(entry => {
        const text = formatKnowledgeForEmbedding(entry);
        if (!text) return null;
        return {
          contentType: 'knowledge_base' as const,
          contentId: `kb_${entry.category}_${entry.id}`,
          contentText: text,
          metadata: {
            category: entry.category,
            entryId: entry.id,
            title: entry.title,
            tags: entry.tags,
            updatedAt: new Date().toISOString(),
          },
        };
      })
      .filter(Boolean) as any[];

    if (items.length > 0) {
      await batchUpsertEmbeddings(tenantId, items);
      await markAsTrained(tenantId, entries.map(e => e.id));
    }
  } catch (error) {
    console.error('Category embedding update failed:', error);
  }
}

/**
 * Delete embeddings for a removed entry.
 */
async function deleteEntryEmbeddings(
  tenantId: string,
  entryId: string
): Promise<void> {
  try {
    const { deleteEmbeddings } = await import('./brain-embeddings');
    await deleteEmbeddings(tenantId, {
      contentType: 'knowledge_base',
      contentIds: [`kb_company_info_${entryId}`, `kb_products_${entryId}`,
                    `kb_warranty_${entryId}`, `kb_shipping_${entryId}`,
                    `kb_financing_${entryId}`, `kb_faqs_${entryId}`],
    });
  } catch (error) {
    console.error('Delete embedding failed:', error);
  }
}

/**
 * Format a knowledge entry into embeddable text.
 */
function formatKnowledgeForEmbedding(entry: KnowledgeEntry): string {
  const parts: string[] = [`[${entry.category}] ${entry.title}`];

  switch (entry.category) {
    case 'company_info': {
      const f = entry.fields;
      if (f.businessName) parts.push(`Business: ${f.businessName}`);
      if (f.description) parts.push(`Description: ${f.description}`);
      if (f.industry) parts.push(`Industry: ${f.industry}`);
      if (f.address) parts.push(`Address: ${f.address}`);
      if (f.phone) parts.push(`Phone: ${f.phone}`);
      if (f.email) parts.push(`Email: ${f.email}`);
      if (f.website) parts.push(`Website: ${f.website}`);
      if (f.hours) parts.push(`Hours: ${f.hours}`);
      if (f.yearFounded) parts.push(`Founded: ${f.yearFounded}`);
      break;
    }
    case 'products': {
      const f = entry.fields;
      if (f.name) parts.push(`Product: ${f.name}`);
      if (f.description) parts.push(`Description: ${f.description}`);
      if (f.price) parts.push(`Price: ${f.price}`);
      if (f.sku) parts.push(`SKU: ${f.sku}`);
      if (f.category) parts.push(`Category: ${f.category}`);
      if (f.features) parts.push(`Features: ${Array.isArray(f.features) ? f.features.join(', ') : f.features}`);
      if (f.specifications) parts.push(`Specs: ${JSON.stringify(f.specifications)}`);
      break;
    }
    case 'warranty': {
      const f = entry.fields;
      if (f.policyName) parts.push(`Policy: ${f.policyName}`);
      if (f.duration) parts.push(`Duration: ${f.duration}`);
      if (f.coverage) parts.push(`Coverage: ${f.coverage}`);
      if (f.exclusions) parts.push(`Exclusions: ${f.exclusions}`);
      if (f.claimProcess) parts.push(`Claim process: ${f.claimProcess}`);
      if (f.contactInfo) parts.push(`Contact: ${f.contactInfo}`);
      break;
    }
    case 'shipping': {
      const f = entry.fields;
      if (f.method) parts.push(`Method: ${f.method}`);
      if (f.rate) parts.push(`Rate: ${f.rate}`);
      if (f.estimatedDays) parts.push(`Estimated delivery: ${f.estimatedDays} days`);
      if (f.freeShippingThreshold) parts.push(`Free shipping over: ${f.freeShippingThreshold}`);
      if (f.restrictions) parts.push(`Restrictions: ${f.restrictions}`);
      if (f.carrier) parts.push(`Carrier: ${f.carrier}`);
      if (f.trackingAvailable) parts.push(`Tracking: available`);
      break;
    }
    case 'financing': {
      const f = entry.fields;
      if (f.planName) parts.push(`Plan: ${f.planName}`);
      if (f.interestRate) parts.push(`Interest rate: ${f.interestRate}`);
      if (f.termLength) parts.push(`Term: ${f.termLength}`);
      if (f.minAmount) parts.push(`Min amount: ${f.minAmount}`);
      if (f.maxAmount) parts.push(`Max amount: ${f.maxAmount}`);
      if (f.requirements) parts.push(`Requirements: ${f.requirements}`);
      if (f.provider) parts.push(`Provider: ${f.provider}`);
      break;
    }
    case 'faqs': {
      const f = entry.fields;
      if (f.question) parts.push(`Q: ${f.question}`);
      if (f.answer) parts.push(`A: ${f.answer}`);
      if (f.relatedTopics) parts.push(`Related: ${Array.isArray(f.relatedTopics) ? f.relatedTopics.join(', ') : f.relatedTopics}`);
      break;
    }
    default:
      parts.push(JSON.stringify(entry.fields));
  }

  if (entry.tags.length > 0) {
    parts.push(`Tags: ${entry.tags.join(', ')}`);
  }

  return parts.join('\n');
}

// ━━ Helper ━━

function mapRow(row: any): KnowledgeEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    category: row.category,
    title: row.title,
    fields: row.fields || {},
    tags: row.tags || [],
    sortOrder: row.sort_order,
    isActive: row.is_active,
    aiTrained: row.ai_trained,
    aiTrainedAt: row.ai_trained_at?.toISOString?.() || row.ai_trained_at || null,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

// ━━ API Routes (KAN-145) ━━

/**
 * GET /knowledge-center/summary
 * Get category summary stats.
 */
router.get('/knowledge-center/summary', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const summary = await getCategorySummary(tenantId);
    return res.json({ categories: summary });
  } catch (error: any) {
    console.error('Get summary error:', error);
    return res.status(500).json({ error: 'Failed to get summary', details: error.message });
  }
});

/**
 * GET /knowledge-center/:category
 * List entries for a category.
 */
router.get('/knowledge-center/:category', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const category = KnowledgeCategorySchema.parse(req.params.category);
    const { active_only, untrained_only, tag, search, limit, offset } = req.query;

    const result = await listEntries(tenantId, {
      category,
      activeOnly: active_only === 'true',
      untrainedOnly: untrained_only === 'true',
      tag: tag as string,
      search: search as string,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });

    return res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid category', details: error.errors });
    }
    console.error('List entries error:', error);
    return res.status(500).json({ error: 'Failed to list entries', details: error.message });
  }
});

/**
 * GET /knowledge-center/:category/:id
 * Get a single entry.
 */
router.get('/knowledge-center/:category/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const entry = await getEntry(tenantId, req.params.id);
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    return res.json(entry);
  } catch (error: any) {
    console.error('Get entry error:', error);
    return res.status(500).json({ error: 'Failed to get entry', details: error.message });
  }
});

/**
 * POST /knowledge-center/:category
 * Create a new entry.
 */
router.post('/knowledge-center/:category', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const category = KnowledgeCategorySchema.parse(req.params.category);
    const data = KnowledgeEntrySchema.parse({ ...req.body, category });

    const entry = await createEntry(tenantId, data);

    // Trigger embedding for new entry
    await triggerEmbeddingUpdate(tenantId, entry);

    return res.status(201).json(entry);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Create entry error:', error);
    return res.status(500).json({ error: 'Failed to create entry', details: error.message });
  }
});

/**
 * POST /knowledge-center/:category/bulk
 * Bulk create entries.
 */
router.post('/knowledge-center/:category/bulk', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const category = KnowledgeCategorySchema.parse(req.params.category);
    const data = BulkCreateSchema.parse({ category, entries: req.body.entries });

    const entries = await bulkCreate(tenantId, data);

    return res.status(201).json({
      created: entries.length,
      entries,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Bulk create error:', error);
    return res.status(500).json({ error: 'Failed to bulk create', details: error.message });
  }
});

/**
 * POST /knowledge-center/faqs
 * Convenience endpoint for creating FAQ entries.
 */
router.post('/knowledge-center/faqs/add', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const faq = FAQEntrySchema.parse(req.body);

    const entry = await createEntry(tenantId, {
      category: 'faqs',
      title: faq.question.substring(0, 500),
      fields: { question: faq.question, answer: faq.answer },
      tags: faq.tags,
      sortOrder: faq.sortOrder,
      isActive: faq.isActive,
    });

    await triggerEmbeddingUpdate(tenantId, entry);

    return res.status(201).json(entry);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Create FAQ error:', error);
    return res.status(500).json({ error: 'Failed to create FAQ', details: error.message });
  }
});

/**
 * PUT /knowledge-center/:category/:id
 * Update an entry.
 */
router.put('/knowledge-center/:category/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const data = UpdateKnowledgeEntrySchema.parse(req.body);
    const entry = await updateEntry(tenantId, req.params.id, data);

    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    return res.json(entry);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Update entry error:', error);
    return res.status(500).json({ error: 'Failed to update entry', details: error.message });
  }
});

/**
 * DELETE /knowledge-center/:category/:id
 * Delete an entry.
 */
router.delete('/knowledge-center/:category/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const deleted = await deleteEntry(tenantId, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    return res.json({ status: 'deleted' });
  } catch (error: any) {
    console.error('Delete entry error:', error);
    return res.status(500).json({ error: 'Failed to delete entry', details: error.message });
  }
});

/**
 * POST /knowledge-center/train
 * Trigger re-training (embedding rebuild) for specific categories or all.
 */
router.post('/knowledge-center/train', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { categories } = z.object({
      categories: z.array(KnowledgeCategorySchema).optional(),
    }).parse(req.body);

    const targetCategories = categories || [
      'company_info', 'products', 'warranty', 'shipping', 'financing', 'faqs',
    ] as KnowledgeCategory[];

    let totalTrained = 0;
    for (const category of targetCategories) {
      await triggerCategoryEmbeddingUpdate(tenantId, category);
      const { total } = await listEntries(tenantId, { category, activeOnly: true });
      totalTrained += total;
    }

    return res.json({
      status: 'training_complete',
      categoriesTrained: targetCategories.length,
      entriesTrained: totalTrained,
    });
  } catch (error: any) {
    console.error('Train error:', error);
    return res.status(500).json({ error: 'Training failed', details: error.message });
  }
});

/**
 * GET /knowledge-center/untrained
 * Get count of untrained entries by category.
 */
router.get('/knowledge-center/untrained', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const stats = await prisma.$queryRaw<any[]>`
      SELECT category, COUNT(*)::int as untrained_count
      FROM knowledge_base
      WHERE tenant_id = ${tenantId}::uuid AND ai_trained = false AND is_active = true
      GROUP BY category
    `;

    const untrained: Record<string, number> = {};
    let totalUntrained = 0;
    for (const row of stats) {
      untrained[row.category] = row.untrained_count;
      totalUntrained += row.untrained_count;
    }

    return res.json({ untrained, totalUntrained });
  } catch (error: any) {
    console.error('Get untrained error:', error);
    return res.status(500).json({ error: 'Failed to get untrained', details: error.message });
  }
});

export default router;
export {
  createEntry,
  getEntry,
  listEntries,
  updateEntry,
  deleteEntry,
  bulkCreate,
  getCategorySummary,
  markAsTrained,
  triggerEmbeddingUpdate,
  triggerCategoryEmbeddingUpdate,
  formatKnowledgeForEmbedding,
};
export {
  KnowledgeCategorySchema,
  KnowledgeEntrySchema,
  UpdateKnowledgeEntrySchema,
  BulkCreateSchema,
  FAQEntrySchema,
};
export type { KnowledgeEntry, KnowledgeCategory };
