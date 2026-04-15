/**
 * Company Truth — Brain Service
 * KAN-30: Implement Company Truth storage and management
 *
 * Subtasks:
 * - KAN-138: Create Company Truth CRUD API
 * - KAN-139: Implement admin edit interface endpoints
 * - KAN-140: Build AI inference updates
 *
 * Company Truth is the tenant-specific knowledge layer that stores:
 * - Products & services (catalog, pricing, features)
 * - Positioning & messaging (value props, differentiators, tone)
 * - Business constraints (territories, compliance, blackout periods)
 * - Team & process (sales stages, handoff rules, escalation paths)
 *
 * AI can infer and suggest updates from ingested data, but admin-confirmed
 * facts always take precedence. Every change is audited.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// ━━ Zod Schemas ━━

const CompanyTruthCategorySchema = z.enum([
  'products',
  'pricing',
  'positioning',
  'constraints',
  'team',
  'process',
  'custom',
]);

type CompanyTruthCategory = z.infer<typeof CompanyTruthCategorySchema>;

const ProductSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  price: z.number().optional(),
  currency: z.string().default('USD'),
  billingCycle: z.enum(['one_time', 'monthly', 'annual', 'usage_based', 'custom']).optional(),
  features: z.array(z.string()).optional(),
  isActive: z.boolean().default(true),
  metadata: z.record(z.any()).optional(),
});

const PricingTierSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  price: z.number(),
  currency: z.string().default('USD'),
  billingCycle: z.enum(['monthly', 'annual', 'one_time', 'usage_based']),
  features: z.array(z.string()).optional(),
  limits: z.record(z.any()).optional(),
  isRecommended: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

const PositioningSchema = z.object({
  valueProp: z.string().optional(),
  tagline: z.string().optional(),
  differentiators: z.array(z.string()).optional(),
  targetAudience: z.string().optional(),
  toneOfVoice: z.enum(['professional', 'friendly', 'casual', 'authoritative', 'empathetic', 'custom']).optional(),
  toneNotes: z.string().optional(),
  competitiveAdvantages: z.array(z.string()).optional(),
  objectionHandlers: z.array(z.object({
    objection: z.string(),
    response: z.string(),
    category: z.string().optional(),
  })).optional(),
});

const ConstraintSchema = z.object({
  territories: z.array(z.string()).optional(),
  excludedTerritories: z.array(z.string()).optional(),
  complianceRules: z.array(z.object({
    rule: z.string(),
    type: z.enum(['legal', 'regulatory', 'internal', 'industry']),
    description: z.string().optional(),
  })).optional(),
  blackoutPeriods: z.array(z.object({
    name: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    channels: z.array(z.string()).optional(),
  })).optional(),
  contactFrequencyLimits: z.object({
    maxPerDay: z.number().optional(),
    maxPerWeek: z.number().optional(),
    maxPerMonth: z.number().optional(),
    cooldownHours: z.number().optional(),
  }).optional(),
  doNotContact: z.array(z.string()).optional(),
});

const TeamSchema = z.object({
  salesStages: z.array(z.object({
    name: z.string(),
    order: z.number(),
    description: z.string().optional(),
    avgDurationDays: z.number().optional(),
    automationAllowed: z.boolean().default(true),
  })).optional(),
  escalationRules: z.array(z.object({
    trigger: z.string(),
    assignTo: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
    timeoutHours: z.number().optional(),
    notifyChannels: z.array(z.string()).optional(),
  })).optional(),
  handoffRules: z.array(z.object({
    from: z.string(),
    to: z.string(),
    condition: z.string(),
    includeContext: z.boolean().default(true),
  })).optional(),
});

const CompanyTruthSchema = z.object({
  products: z.array(ProductSchema).optional(),
  pricing: z.array(PricingTierSchema).optional(),
  positioning: PositioningSchema.optional(),
  constraints: ConstraintSchema.optional(),
  team: TeamSchema.optional(),
  process: z.record(z.any()).optional(),
  custom: z.record(z.any()).optional(),
});

type CompanyTruth = z.infer<typeof CompanyTruthSchema>;

const TruthUpdateSchema = z.object({
  category: CompanyTruthCategorySchema,
  data: z.any(),
  source: z.enum(['admin', 'ai_inference', 'onboarding', 'import']).default('admin'),
  confidence: z.number().min(0).max(100).optional(),
  reasoning: z.string().optional(),
});

const AIInferenceSchema = z.object({
  category: CompanyTruthCategorySchema,
  suggestedData: z.any(),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
  sourceContactId: z.string().optional(),
  sourceDataType: z.string().optional(),
});

const BulkUpdateSchema = z.object({
  updates: z.array(TruthUpdateSchema),
});

// ━━ Helper: Get or Initialize Company Truth ━━

async function getCompanyTruth(tenantId: string): Promise<any> {
  const snapshot = await prisma.brainSnapshot.findFirst({
    where: { tenantId, status: 'active' },
    orderBy: { version: 'desc' },
  });

  if (!snapshot) {
    return null;
  }

  return {
    snapshotId: snapshot.id,
    version: snapshot.version,
    companyTruth: snapshot.companyTruth || {},
    updatedAt: snapshot.updatedAt,
  };
}

async function updateCompanyTruth(
  tenantId: string,
  category: CompanyTruthCategory,
  data: any,
  source: string,
  actor: string,
  reasoning?: string
): Promise<any> {
  // Get current snapshot
  const current = await prisma.brainSnapshot.findFirst({
    where: { tenantId, status: 'active' },
    orderBy: { version: 'desc' },
  });

  if (!current) {
    throw new Error('No active Brain snapshot found. Complete onboarding first.');
  }

  const currentTruth = (current.companyTruth as any) || {};

  // Deep merge the category data
  let updatedTruth: any;
  if (category === 'products' || category === 'pricing') {
    // Array-based categories: replace entire array
    updatedTruth = { ...currentTruth, [category]: data };
  } else {
    // Object-based categories: deep merge
    updatedTruth = {
      ...currentTruth,
      [category]: { ...(currentTruth[category] || {}), ...data },
    };
  }

  // Create new snapshot version (immutable history)
  const newSnapshot = await prisma.brainSnapshot.create({
    data: {
      tenantId,
      version: current.version + 1,
      companyTruth: updatedTruth,
      behavioralModel: current.behavioralModel,
      outcomeModel: current.outcomeModel,
      status: 'active',
      metadata: {
        ...(current.metadata as any || {}),
        lastTruthUpdate: new Date().toISOString(),
        lastTruthCategory: category,
        lastTruthSource: source,
      },
    },
  });

  // Deactivate old snapshot
  await prisma.brainSnapshot.update({
    where: { id: current.id },
    data: { status: 'archived' },
  });

  // Audit log
  await prisma.auditLog.create({
    data: {
      tenantId,
      actor,
      actionType: `company_truth.${category}.updated`,
      payload: {
        snapshotId: newSnapshot.id,
        version: newSnapshot.version,
        category,
        source,
        previousVersion: current.version,
      },
      reasoning: reasoning || `Company Truth ${category} updated via ${source}`,
    },
  });

  // TODO: Publish brain.updated event to Pub/Sub
  console.log(`[Pub/Sub Placeholder] brain.updated for tenant ${tenantId} — truth.${category} changed`);

  return {
    snapshotId: newSnapshot.id,
    version: newSnapshot.version,
    category,
    companyTruth: updatedTruth,
  };
}

// ━━ KAN-138: Company Truth CRUD API ━━

/**
 * GET /company-truth
 * Get the full Company Truth for the tenant.
 */
router.get('/company-truth', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const truth = await getCompanyTruth(tenantId);
    if (!truth) {
      return res.status(404).json({
        error: 'No Company Truth found',
        message: 'Complete onboarding to initialize Company Truth.',
      });
    }

    return res.json(truth);
  } catch (error: any) {
    console.error('Get Company Truth error:', error);
    return res.status(500).json({ error: 'Failed to get Company Truth', details: error.message });
  }
});

/**
 * GET /company-truth/:category
 * Get a specific category of Company Truth.
 */
router.get('/company-truth/:category', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const category = CompanyTruthCategorySchema.parse(req.params.category);
    const truth = await getCompanyTruth(tenantId);

    if (!truth) {
      return res.status(404).json({ error: 'No Company Truth found' });
    }

    return res.json({
      category,
      data: truth.companyTruth[category] || null,
      version: truth.version,
      updatedAt: truth.updatedAt,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid category', details: error.errors });
    }
    console.error('Get category error:', error);
    return res.status(500).json({ error: 'Failed to get category', details: error.message });
  }
});

/**
 * PUT /company-truth/:category
 * Update a specific category of Company Truth (admin action).
 */
router.put('/company-truth/:category', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const category = CompanyTruthCategorySchema.parse(req.params.category);

    // Validate data based on category
    let validatedData: any;
    switch (category) {
      case 'products':
        validatedData = z.array(ProductSchema).parse(req.body.data || req.body);
        break;
      case 'pricing':
        validatedData = z.array(PricingTierSchema).parse(req.body.data || req.body);
        break;
      case 'positioning':
        validatedData = PositioningSchema.parse(req.body.data || req.body);
        break;
      case 'constraints':
        validatedData = ConstraintSchema.parse(req.body.data || req.body);
        break;
      case 'team':
        validatedData = TeamSchema.parse(req.body.data || req.body);
        break;
      default:
        validatedData = req.body.data || req.body;
    }

    const result = await updateCompanyTruth(
      tenantId,
      category,
      validatedData,
      'admin',
      'admin',
      req.body.reasoning || `Admin updated ${category}`
    );

    return res.json({ status: 'updated', ...result });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Update category error:', error);
    return res.status(500).json({ error: 'Failed to update', details: error.message });
  }
});

/**
 * POST /company-truth/bulk
 * Bulk update multiple categories at once.
 */
router.post('/company-truth/bulk', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { updates } = BulkUpdateSchema.parse(req.body);
    const results: any[] = [];

    for (const update of updates) {
      const result = await updateCompanyTruth(
        tenantId,
        update.category,
        update.data,
        update.source,
        'admin',
        update.reasoning
      );
      results.push(result);
    }

    return res.json({
      status: 'updated',
      updatedCategories: results.map(r => r.category),
      latestVersion: results[results.length - 1]?.version,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Bulk update error:', error);
    return res.status(500).json({ error: 'Failed to bulk update', details: error.message });
  }
});

/**
 * DELETE /company-truth/:category
 * Clear a specific category (sets to null/empty).
 */
router.delete('/company-truth/:category', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const category = CompanyTruthCategorySchema.parse(req.params.category);
    const emptyData = (category === 'products' || category === 'pricing') ? [] : {};

    const result = await updateCompanyTruth(
      tenantId,
      category,
      emptyData,
      'admin',
      'admin',
      `Admin cleared ${category}`
    );

    return res.json({ status: 'cleared', ...result });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid category', details: error.errors });
    }
    console.error('Delete category error:', error);
    return res.status(500).json({ error: 'Failed to clear category', details: error.message });
  }
});

// ━━ KAN-138: Product-specific CRUD ━━

/**
 * POST /company-truth/products
 * Add a new product to the catalog.
 */
router.post('/company-truth/products', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const product = ProductSchema.parse(req.body);
    product.id = product.id || `prod_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const truth = await getCompanyTruth(tenantId);
    const currentProducts = (truth?.companyTruth?.products || []) as any[];
    currentProducts.push(product);

    const result = await updateCompanyTruth(
      tenantId,
      'products',
      currentProducts,
      'admin',
      'admin',
      `Added product: ${product.name}`
    );

    return res.status(201).json({ status: 'created', product, version: result.version });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Add product error:', error);
    return res.status(500).json({ error: 'Failed to add product', details: error.message });
  }
});

/**
 * PUT /company-truth/products/:productId
 * Update a specific product.
 */
router.put('/company-truth/products/:productId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { productId } = req.params;
    const updates = ProductSchema.partial().parse(req.body);

    const truth = await getCompanyTruth(tenantId);
    const products = (truth?.companyTruth?.products || []) as any[];
    const idx = products.findIndex((p: any) => p.id === productId);

    if (idx === -1) {
      return res.status(404).json({ error: 'Product not found' });
    }

    products[idx] = { ...products[idx], ...updates };

    const result = await updateCompanyTruth(
      tenantId,
      'products',
      products,
      'admin',
      'admin',
      `Updated product: ${products[idx].name}`
    );

    return res.json({ status: 'updated', product: products[idx], version: result.version });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Update product error:', error);
    return res.status(500).json({ error: 'Failed to update product', details: error.message });
  }
});

/**
 * DELETE /company-truth/products/:productId
 * Remove a product from the catalog.
 */
router.delete('/company-truth/products/:productId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { productId } = req.params;
    const truth = await getCompanyTruth(tenantId);
    const products = (truth?.companyTruth?.products || []) as any[];
    const filtered = products.filter((p: any) => p.id !== productId);

    if (filtered.length === products.length) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const result = await updateCompanyTruth(
      tenantId,
      'products',
      filtered,
      'admin',
      'admin',
      `Removed product ID: ${productId}`
    );

    return res.json({ status: 'deleted', version: result.version });
  } catch (error: any) {
    console.error('Delete product error:', error);
    return res.status(500).json({ error: 'Failed to delete product', details: error.message });
  }
});

// ━━ KAN-139: Admin Edit Interface Endpoints ━━

/**
 * GET /company-truth/history
 * Get version history of Company Truth changes.
 */
router.get('/company-truth/history', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const snapshots = await prisma.brainSnapshot.findMany({
      where: { tenantId },
      orderBy: { version: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        version: true,
        status: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const total = await prisma.brainSnapshot.count({ where: { tenantId } });

    return res.json({ history: snapshots, total, limit, offset });
  } catch (error: any) {
    console.error('History error:', error);
    return res.status(500).json({ error: 'Failed to get history', details: error.message });
  }
});

/**
 * GET /company-truth/history/:version
 * Get a specific version of Company Truth.
 */
router.get('/company-truth/history/:version', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const version = parseInt(req.params.version);
    if (isNaN(version)) {
      return res.status(400).json({ error: 'Invalid version number' });
    }

    const snapshot = await prisma.brainSnapshot.findFirst({
      where: { tenantId, version },
    });

    if (!snapshot) {
      return res.status(404).json({ error: 'Version not found' });
    }

    return res.json({
      version: snapshot.version,
      status: snapshot.status,
      companyTruth: snapshot.companyTruth,
      metadata: snapshot.metadata,
      createdAt: snapshot.createdAt,
    });
  } catch (error: any) {
    console.error('Get version error:', error);
    return res.status(500).json({ error: 'Failed to get version', details: error.message });
  }
});

/**
 * POST /company-truth/rollback/:version
 * Rollback Company Truth to a specific version.
 */
router.post('/company-truth/rollback/:version', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const targetVersion = parseInt(req.params.version);
    if (isNaN(targetVersion)) {
      return res.status(400).json({ error: 'Invalid version number' });
    }

    // Get the target snapshot
    const targetSnapshot = await prisma.brainSnapshot.findFirst({
      where: { tenantId, version: targetVersion },
    });

    if (!targetSnapshot) {
      return res.status(404).json({ error: 'Target version not found' });
    }

    // Get current active snapshot
    const current = await prisma.brainSnapshot.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { version: 'desc' },
    });

    if (!current) {
      return res.status(400).json({ error: 'No active snapshot to rollback from' });
    }

    // Create a new snapshot with the old data (preserves history)
    const newSnapshot = await prisma.brainSnapshot.create({
      data: {
        tenantId,
        version: current.version + 1,
        companyTruth: targetSnapshot.companyTruth,
        behavioralModel: current.behavioralModel,
        outcomeModel: current.outcomeModel,
        status: 'active',
        metadata: {
          ...(current.metadata as any || {}),
          rolledBackFrom: current.version,
          rolledBackTo: targetVersion,
          rollbackAt: new Date().toISOString(),
        },
      },
    });

    // Deactivate current
    await prisma.brainSnapshot.update({
      where: { id: current.id },
      data: { status: 'archived' },
    });

    // Audit
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'admin',
        actionType: 'company_truth.rollback',
        payload: {
          fromVersion: current.version,
          toVersion: targetVersion,
          newVersion: newSnapshot.version,
        },
        reasoning: req.body.reasoning || `Admin rolled back Company Truth from v${current.version} to v${targetVersion}`,
      },
    });

    console.log(`[Pub/Sub Placeholder] brain.updated for tenant ${tenantId} — truth rollback`);

    return res.json({
      status: 'rolled_back',
      previousVersion: current.version,
      restoredFrom: targetVersion,
      newVersion: newSnapshot.version,
    });
  } catch (error: any) {
    console.error('Rollback error:', error);
    return res.status(500).json({ error: 'Failed to rollback', details: error.message });
  }
});

/**
 * GET /company-truth/diff/:fromVersion/:toVersion
 * Compare two versions of Company Truth.
 */
router.get('/company-truth/diff/:fromVersion/:toVersion', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const fromVersion = parseInt(req.params.fromVersion);
    const toVersion = parseInt(req.params.toVersion);

    if (isNaN(fromVersion) || isNaN(toVersion)) {
      return res.status(400).json({ error: 'Invalid version numbers' });
    }

    const [fromSnapshot, toSnapshot] = await Promise.all([
      prisma.brainSnapshot.findFirst({ where: { tenantId, version: fromVersion } }),
      prisma.brainSnapshot.findFirst({ where: { tenantId, version: toVersion } }),
    ]);

    if (!fromSnapshot || !toSnapshot) {
      return res.status(404).json({ error: 'One or both versions not found' });
    }

    const fromTruth = (fromSnapshot.companyTruth as any) || {};
    const toTruth = (toSnapshot.companyTruth as any) || {};

    // Compute category-level diff
    const categories = new Set([...Object.keys(fromTruth), ...Object.keys(toTruth)]);
    const diff: Record<string, { changed: boolean; from: any; to: any }> = {};

    categories.forEach(cat => {
      const fromVal = JSON.stringify(fromTruth[cat]);
      const toVal = JSON.stringify(toTruth[cat]);
      diff[cat] = {
        changed: fromVal !== toVal,
        from: fromTruth[cat] || null,
        to: toTruth[cat] || null,
      };
    });

    return res.json({
      fromVersion,
      toVersion,
      diff,
      changedCategories: Object.keys(diff).filter(k => diff[k].changed),
    });
  } catch (error: any) {
    console.error('Diff error:', error);
    return res.status(500).json({ error: 'Failed to compute diff', details: error.message });
  }
});

/**
 * GET /company-truth/audit
 * Get audit log for Company Truth changes.
 */
router.get('/company-truth/audit', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as string;

    const where: any = {
      tenantId,
      actionType: { startsWith: 'company_truth.' },
    };

    if (category) {
      where.actionType = `company_truth.${category}.updated`;
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return res.json({
      auditLogs: logs.map(log => ({
        id: log.id,
        actionType: log.actionType,
        actor: log.actor,
        payload: log.payload,
        reasoning: log.reasoning,
        createdAt: log.createdAt,
      })),
      total,
      limit,
      offset,
    });
  } catch (error: any) {
    console.error('Audit log error:', error);
    return res.status(500).json({ error: 'Failed to get audit log', details: error.message });
  }
});

// ━━ KAN-139: Admin Validation & Lock ━━

/**
 * POST /company-truth/:category/validate
 * Admin confirms a category as validated (locks AI from overwriting).
 */
router.post('/company-truth/:category/validate', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const category = CompanyTruthCategorySchema.parse(req.params.category);

    const current = await prisma.brainSnapshot.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { version: 'desc' },
    });

    if (!current) {
      return res.status(404).json({ error: 'No active snapshot found' });
    }

    const metadata = (current.metadata as any) || {};
    const validatedCategories = metadata.validatedCategories || [];

    if (!validatedCategories.includes(category)) {
      validatedCategories.push(category);
    }

    await prisma.brainSnapshot.update({
      where: { id: current.id },
      data: {
        metadata: {
          ...metadata,
          validatedCategories,
          [`${category}_validatedAt`]: new Date().toISOString(),
          [`${category}_validatedBy`]: 'admin',
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'admin',
        actionType: `company_truth.${category}.validated`,
        payload: { category, snapshotId: current.id },
        reasoning: `Admin validated ${category} — AI inference will not overwrite confirmed data`,
      },
    });

    return res.json({
      status: 'validated',
      category,
      message: `${category} is now admin-confirmed. AI will suggest but not overwrite.`,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid category', details: error.errors });
    }
    console.error('Validate error:', error);
    return res.status(500).json({ error: 'Failed to validate', details: error.message });
  }
});

/**
 * DELETE /company-truth/:category/validate
 * Remove admin validation lock (allow AI to update again).
 */
router.delete('/company-truth/:category/validate', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const category = CompanyTruthCategorySchema.parse(req.params.category);

    const current = await prisma.brainSnapshot.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { version: 'desc' },
    });

    if (!current) {
      return res.status(404).json({ error: 'No active snapshot found' });
    }

    const metadata = (current.metadata as any) || {};
    const validatedCategories = (metadata.validatedCategories || []).filter(
      (c: string) => c !== category
    );

    await prisma.brainSnapshot.update({
      where: { id: current.id },
      data: {
        metadata: {
          ...metadata,
          validatedCategories,
          [`${category}_validatedAt`]: null,
          [`${category}_validatedBy`]: null,
        },
      },
    });

    return res.json({
      status: 'unlocked',
      category,
      message: `${category} validation removed. AI can now update this category.`,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid category', details: error.errors });
    }
    console.error('Unlock error:', error);
    return res.status(500).json({ error: 'Failed to unlock', details: error.message });
  }
});

// ━━ KAN-140: AI Inference Updates ━━

/**
 * POST /company-truth/ai-inference
 * AI suggests an update to Company Truth based on ingested data.
 * Respects admin validation locks — validated categories go to pending review.
 */
router.post('/company-truth/ai-inference', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const inference = AIInferenceSchema.parse(req.body);

    // Check if category is admin-validated (locked)
    const current = await prisma.brainSnapshot.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { version: 'desc' },
    });

    if (!current) {
      return res.status(404).json({ error: 'No active snapshot found' });
    }

    const metadata = (current.metadata as any) || {};
    const validatedCategories = metadata.validatedCategories || [];
    const isLocked = validatedCategories.includes(inference.category);

    // Get tenant confidence threshold
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const confidenceThreshold = (tenant?.aiPermissions as any)?.truthInferenceThreshold || 70;

    if (isLocked) {
      // Category is admin-confirmed → queue for review instead of auto-applying
      await prisma.auditLog.create({
        data: {
          tenantId,
          actor: 'ai_inference',
          actionType: `company_truth.${inference.category}.suggestion_queued`,
          payload: {
            suggestedData: inference.suggestedData,
            confidence: inference.confidence,
            sourceContactId: inference.sourceContactId,
            sourceDataType: inference.sourceDataType,
            reason: 'Category is admin-validated — queued for review',
          },
          reasoning: inference.reasoning,
        },
      });

      return res.json({
        status: 'queued_for_review',
        category: inference.category,
        confidence: inference.confidence,
        message: `${inference.category} is admin-validated. Suggestion queued for human review.`,
      });
    }

    if (inference.confidence < confidenceThreshold) {
      // Below threshold → queue for review
      await prisma.auditLog.create({
        data: {
          tenantId,
          actor: 'ai_inference',
          actionType: `company_truth.${inference.category}.low_confidence_queued`,
          payload: {
            suggestedData: inference.suggestedData,
            confidence: inference.confidence,
            threshold: confidenceThreshold,
            sourceContactId: inference.sourceContactId,
          },
          reasoning: inference.reasoning,
        },
      });

      return res.json({
        status: 'queued_for_review',
        category: inference.category,
        confidence: inference.confidence,
        threshold: confidenceThreshold,
        message: `Confidence ${inference.confidence} below threshold ${confidenceThreshold}. Queued for review.`,
      });
    }

    // High confidence + not locked → auto-apply
    const result = await updateCompanyTruth(
      tenantId,
      inference.category,
      inference.suggestedData,
      'ai_inference',
      'ai_inference',
      `AI inferred update (confidence: ${inference.confidence}): ${inference.reasoning}`
    );

    return res.json({
      status: 'applied',
      category: inference.category,
      confidence: inference.confidence,
      version: result.version,
      message: 'AI inference applied to Company Truth.',
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('AI inference error:', error);
    return res.status(500).json({ error: 'Failed to process inference', details: error.message });
  }
});

/**
 * GET /company-truth/pending-inferences
 * Get AI suggestions that are pending admin review.
 */
router.get('/company-truth/pending-inferences', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: {
          tenantId,
          actionType: {
            in: [
              'company_truth.products.suggestion_queued',
              'company_truth.pricing.suggestion_queued',
              'company_truth.positioning.suggestion_queued',
              'company_truth.constraints.suggestion_queued',
              'company_truth.team.suggestion_queued',
              'company_truth.process.suggestion_queued',
              'company_truth.custom.suggestion_queued',
              'company_truth.products.low_confidence_queued',
              'company_truth.pricing.low_confidence_queued',
              'company_truth.positioning.low_confidence_queued',
              'company_truth.constraints.low_confidence_queued',
              'company_truth.team.low_confidence_queued',
              'company_truth.process.low_confidence_queued',
              'company_truth.custom.low_confidence_queued',
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({
        where: {
          tenantId,
          actionType: { contains: 'queued' },
        },
      }),
    ]);

    return res.json({
      pendingInferences: logs.map(log => ({
        id: log.id,
        actionType: log.actionType,
        category: log.actionType.split('.')[1],
        suggestedData: (log.payload as any)?.suggestedData,
        confidence: (log.payload as any)?.confidence,
        reasoning: log.reasoning,
        createdAt: log.createdAt,
      })),
      total,
      limit,
      offset,
    });
  } catch (error: any) {
    console.error('Pending inferences error:', error);
    return res.status(500).json({ error: 'Failed to get pending inferences', details: error.message });
  }
});

/**
 * POST /company-truth/pending-inferences/:inferenceId/approve
 * Admin approves a pending AI inference.
 */
router.post('/company-truth/pending-inferences/:inferenceId/approve', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { inferenceId } = req.params;

    // Get the pending inference audit log
    const inference = await prisma.auditLog.findFirst({
      where: {
        id: inferenceId,
        tenantId,
        actionType: { contains: 'queued' },
      },
    });

    if (!inference) {
      return res.status(404).json({ error: 'Pending inference not found' });
    }

    const payload = inference.payload as any;
    const category = inference.actionType.split('.')[1] as CompanyTruthCategory;

    // Apply the suggested update
    const result = await updateCompanyTruth(
      tenantId,
      category,
      payload.suggestedData,
      'ai_inference_approved',
      'admin',
      `Admin approved AI suggestion (confidence: ${payload.confidence}): ${inference.reasoning}`
    );

    // Mark the inference as approved
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'admin',
        actionType: `company_truth.${category}.inference_approved`,
        payload: {
          originalInferenceId: inferenceId,
          confidence: payload.confidence,
          version: result.version,
        },
        reasoning: `Admin approved AI inference for ${category}`,
      },
    });

    return res.json({
      status: 'approved',
      category,
      version: result.version,
      message: `AI inference for ${category} approved and applied.`,
    });
  } catch (error: any) {
    console.error('Approve inference error:', error);
    return res.status(500).json({ error: 'Failed to approve', details: error.message });
  }
});

/**
 * POST /company-truth/pending-inferences/:inferenceId/reject
 * Admin rejects a pending AI inference.
 */
router.post('/company-truth/pending-inferences/:inferenceId/reject', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { inferenceId } = req.params;

    const inference = await prisma.auditLog.findFirst({
      where: {
        id: inferenceId,
        tenantId,
        actionType: { contains: 'queued' },
      },
    });

    if (!inference) {
      return res.status(404).json({ error: 'Pending inference not found' });
    }

    const category = inference.actionType.split('.')[1];

    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'admin',
        actionType: `company_truth.${category}.inference_rejected`,
        payload: {
          originalInferenceId: inferenceId,
          rejectionReason: req.body.reason || 'Admin rejected',
        },
        reasoning: req.body.reason || `Admin rejected AI inference for ${category}`,
      },
    });

    return res.json({
      status: 'rejected',
      category,
      message: `AI inference for ${category} rejected.`,
    });
  } catch (error: any) {
    console.error('Reject inference error:', error);
    return res.status(500).json({ error: 'Failed to reject', details: error.message });
  }
});

// ━━ KAN-140: AI Batch Inference from Ingestion ━━

/**
 * POST /company-truth/ai-batch-inference
 * Process multiple AI inferences at once (called by Ingestion Service).
 */
router.post('/company-truth/ai-batch-inference', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const { inferences } = z.object({
      inferences: z.array(AIInferenceSchema),
    }).parse(req.body);

    const results: any[] = [];

    for (const inference of inferences) {
      // Check validation lock
      const current = await prisma.brainSnapshot.findFirst({
        where: { tenantId, status: 'active' },
        orderBy: { version: 'desc' },
      });

      const metadata = (current?.metadata as any) || {};
      const validatedCategories = metadata.validatedCategories || [];
      const isLocked = validatedCategories.includes(inference.category);

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      const threshold = (tenant?.aiPermissions as any)?.truthInferenceThreshold || 70;

      if (isLocked || inference.confidence < threshold) {
        await prisma.auditLog.create({
          data: {
            tenantId,
            actor: 'ai_inference',
            actionType: `company_truth.${inference.category}.${isLocked ? 'suggestion' : 'low_confidence'}_queued`,
            payload: {
              suggestedData: inference.suggestedData,
              confidence: inference.confidence,
              sourceContactId: inference.sourceContactId,
            },
            reasoning: inference.reasoning,
          },
        });
        results.push({ category: inference.category, status: 'queued_for_review' });
      } else {
        const result = await updateCompanyTruth(
          tenantId,
          inference.category,
          inference.suggestedData,
          'ai_inference',
          'ai_inference',
          `Batch AI inference (confidence: ${inference.confidence}): ${inference.reasoning}`
        );
        results.push({ category: inference.category, status: 'applied', version: result.version });
      }
    }

    return res.json({
      status: 'processed',
      results,
      applied: results.filter(r => r.status === 'applied').length,
      queued: results.filter(r => r.status === 'queued_for_review').length,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Batch inference error:', error);
    return res.status(500).json({ error: 'Failed to process batch', details: error.message });
  }
});

export default router;
export {
  getCompanyTruth,
  updateCompanyTruth,
};
export {
  CompanyTruthSchema,
  ProductSchema,
  PricingTierSchema,
  PositioningSchema,
  ConstraintSchema,
  TeamSchema,
  TruthUpdateSchema,
  AIInferenceSchema,
  CompanyTruthCategorySchema,
};
export type { CompanyTruth, CompanyTruthCategory };
