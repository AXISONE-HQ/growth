/**
 * Product Catalog Sync — KAN-34
 *
 * Integrates Shopify API and Stripe Products for automatic product data sync,
 * plus manual upload capability. Synchronizes product data into Company Truth
 * to keep pricing and offerings current.
 *
 * Subtasks:
 * - KAN-151: Shopify product sync connector
 * - KAN-152: Stripe Products sync connector
 * - KAN-153: Manual product upload endpoint
 *
 * @module services/product-catalog
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import crypto from 'crypto';

const router = Router();
const prisma = new PrismaClient();

// ━━ Types & Schemas ━━

const ProductSchema = z.object({
  externalId: z.string().optional(),
  source: z.enum(['shopify', 'stripe', 'manual']),
  name: z.string().min(1).max(500),
  description: z.string().max(5000).optional().default(''),
  sku: z.string().max(100).optional(),
  price: z.number().nonnegative().optional(),
  currency: z.string().length(3).default('USD'),
  priceFormatted: z.string().optional(),
  compareAtPrice: z.number().nonnegative().optional().nullable(),
  category: z.string().max(200).optional().default(''),
  tags: z.array(z.string()).optional().default([]),
  imageUrl: z.string().url().optional().nullable(),
  status: z.enum(['active', 'draft', 'archived']).default('active'),
  variants: z.array(z.object({
    externalId: z.string().optional(),
    name: z.string(),
    sku: z.string().optional(),
    price: z.number().nonnegative().optional(),
    currency: z.string().length(3).default('USD'),
    inventoryQuantity: z.number().int().optional().nullable(),
    attributes: z.record(z.any()).optional().default({}),
  })).optional().default([]),
  metadata: z.record(z.any()).optional().default({}),
});

type Product = z.infer<typeof ProductSchema>;

const ShopifyProductSchema = z.object({
  id: z.number(),
  title: z.string(),
  body_html: z.string().nullable().optional(),
  vendor: z.string().optional(),
  product_type: z.string().optional(),
  status: z.enum(['active', 'draft', 'archived']).optional(),
  tags: z.string().optional(),
  image: z.object({
    src: z.string().optional(),
  }).nullable().optional(),
  variants: z.array(z.object({
    id: z.number(),
    title: z.string(),
    sku: z.string().nullable().optional(),
    price: z.string(),
    compare_at_price: z.string().nullable().optional(),
    inventory_quantity: z.number().nullable().optional(),
  })).optional().default([]),
});

const StripeProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  active: z.boolean().optional(),
  images: z.array(z.string()).optional().default([]),
  metadata: z.record(z.string()).optional().default({}),
  default_price: z.object({
    id: z.string(),
    unit_amount: z.number().nullable().optional(),
    currency: z.string().optional(),
    recurring: z.object({
      interval: z.string().optional(),
      interval_count: z.number().optional(),
    }).nullable().optional(),
  }).nullable().optional(),
});

const SyncConfigSchema = z.object({
  shopify: z.object({
    enabled: z.boolean().default(false),
    shopDomain: z.string().optional(),
    accessToken: z.string().optional(),
    apiVersion: z.string().default('2024-01'),
    syncInterval: z.enum(['manual', 'hourly', 'daily']).default('daily'),
    lastSyncAt: z.string().optional().nullable(),
  }).optional(),
  stripe: z.object({
    enabled: z.boolean().default(false),
    secretKey: z.string().optional(),
    syncInterval: z.enum(['manual', 'hourly', 'daily']).default('daily'),
    lastSyncAt: z.string().optional().nullable(),
  }).optional(),
});

type SyncConfig = z.infer<typeof SyncConfigSchema>;

interface SyncResult {
  source: string;
  productsCreated: number;
  productsUpdated: number;
  productsArchived: number;
  errors: string[];
  syncedAt: string;
  durationMs: number;
}

// ━━ KAN-151: Shopify Product Sync Connector ━━

/**
 * Fetch products from Shopify Admin API.
 * Handles pagination via Link headers for large catalogs.
 */
async function fetchShopifyProducts(
  shopDomain: string,
  accessToken: string,
  apiVersion: string = '2024-01',
  sinceId?: string
): Promise<z.infer<typeof ShopifyProductSchema>[]> {
  const allProducts: z.infer<typeof ShopifyProductSchema>[] = [];
  let url = `https://${shopDomain}/admin/api/${apiVersion}/products.json?limit=250`;
  if (sinceId) {
    url += `&since_id=${sinceId}`;
  }

  let hasNext = true;
  while (hasNext) {
    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const products = data.products || [];

    for (const p of products) {
      try {
        allProducts.push(ShopifyProductSchema.parse(p));
      } catch (err: any) {
        console.warn(`Skipping malformed Shopify product ${p.id}:`, err.message);
      }
    }

    // Handle pagination via Link header
    const linkHeader = response.headers.get('Link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        url = match[1];
      } else {
        hasNext = false;
      }
    } else {
      hasNext = false;
    }
  }

  return allProducts;
}

/**
 * Transform Shopify product to unified Product format.
 */
function transformShopifyProduct(shopifyProduct: z.infer<typeof ShopifyProductSchema>): Product {
  const firstVariant = shopifyProduct.variants[0];
  const price = firstVariant ? parseFloat(firstVariant.price) : 0;
  const compareAtPrice = firstVariant?.compare_at_price
    ? parseFloat(firstVariant.compare_at_price)
    : null;

  return {
    externalId: String(shopifyProduct.id),
    source: 'shopify',
    name: shopifyProduct.title,
    description: shopifyProduct.body_html
      ? shopifyProduct.body_html.replace(/<[^>]*>/g, '').trim()
      : '',
    sku: firstVariant?.sku || undefined,
    price,
    currency: 'USD',
    priceFormatted: `$${price.toFixed(2)}`,
    compareAtPrice,
    category: shopifyProduct.product_type || '',
    tags: shopifyProduct.tags ? shopifyProduct.tags.split(', ').filter(Boolean) : [],
    imageUrl: shopifyProduct.image?.src || null,
    status: shopifyProduct.status || 'active',
    variants: shopifyProduct.variants.map(v => ({
      externalId: String(v.id),
      name: v.title,
      sku: v.sku || undefined,
      price: parseFloat(v.price),
      currency: 'USD',
      inventoryQuantity: v.inventory_quantity,
      attributes: {},
    })),
    metadata: {
      vendor: shopifyProduct.vendor,
      shopifyProductType: shopifyProduct.product_type,
    },
  };
}

/**
 * Sync products from Shopify for a tenant.
 */
async function syncShopifyProducts(
  tenantId: string,
  config: NonNullable<SyncConfig['shopify']>
): Promise<SyncResult> {
  const startTime = Date.now();
  const result: SyncResult = {
    source: 'shopify',
    productsCreated: 0,
    productsUpdated: 0,
    productsArchived: 0,
    errors: [],
    syncedAt: new Date().toISOString(),
    durationMs: 0,
  };

  if (!config.shopDomain || !config.accessToken) {
    result.errors.push('Shopify shop domain and access token required');
    result.durationMs = Date.now() - startTime;
    return result;
  }

  try {
    const shopifyProducts = await fetchShopifyProducts(
      config.shopDomain,
      config.accessToken,
      config.apiVersion
    );

    // Get existing products from this source
    const existing = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id::text, metadata->>'externalId' as external_id
      FROM products
      WHERE tenant_id = '${tenantId}'::uuid AND source = 'shopify'
    `);

    const existingMap = new Map(existing.map(e => [e.external_id, e.id]));
    const syncedExternalIds = new Set<string>();

    for (const sp of shopifyProducts) {
      try {
        const product = transformShopifyProduct(sp);
        const externalId = String(sp.id);
        syncedExternalIds.add(externalId);

        if (existingMap.has(externalId)) {
          // Update existing
          await upsertProduct(tenantId, product, existingMap.get(externalId)!);
          result.productsUpdated++;
        } else {
          // Create new
          await upsertProduct(tenantId, product);
          result.productsCreated++;
        }
      } catch (err: any) {
        result.errors.push(`Product ${sp.id}: ${err.message}`);
      }
    }

    // Archive products no longer in Shopify
    for (const [extId, dbId] of existingMap) {
      if (!syncedExternalIds.has(extId)) {
        await prisma.$queryRawUnsafe(`
          UPDATE products SET status = 'archived', updated_at = NOW()
          WHERE id = '${dbId}'::uuid AND tenant_id = '${tenantId}'::uuid
        `);
        result.productsArchived++;
      }
    }

    // Update sync timestamp
    await updateSyncConfig(tenantId, 'shopify', { lastSyncAt: new Date().toISOString() });

  } catch (err: any) {
    result.errors.push(`Shopify sync failed: ${err.message}`);
    console.error('Shopify sync error:', err);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

// ━━ KAN-152: Stripe Products Sync Connector ━━

/**
 * Fetch products from Stripe API.
 * Uses cursor-based pagination via starting_after.
 */
async function fetchStripeProducts(
  secretKey: string
): Promise<z.infer<typeof StripeProductSchema>[]> {
  const allProducts: z.infer<typeof StripeProductSchema>[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    let url = 'https://api.stripe.com/v1/products?limit=100&expand[]=data.default_price';
    if (startingAfter) {
      url += `&starting_after=${startingAfter}`;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Stripe API error: ${response.status} — ${errorBody}`);
    }

    const data = await response.json();

    for (const p of data.data || []) {
      try {
        allProducts.push(StripeProductSchema.parse(p));
      } catch (err: any) {
        console.warn(`Skipping malformed Stripe product ${p.id}:`, err.message);
      }
    }

    hasMore = data.has_more === true;
    if (hasMore && data.data.length > 0) {
      startingAfter = data.data[data.data.length - 1].id;
    }
  }

  return allProducts;
}

/**
 * Transform Stripe product to unified Product format.
 */
function transformStripeProduct(stripeProduct: z.infer<typeof StripeProductSchema>): Product {
  const defaultPrice = stripeProduct.default_price;
  const unitAmount = defaultPrice?.unit_amount || 0;
  const price = unitAmount / 100; // Stripe uses cents
  const currency = (defaultPrice?.currency || 'usd').toUpperCase();
  const isRecurring = !!defaultPrice?.recurring;

  return {
    externalId: stripeProduct.id,
    source: 'stripe',
    name: stripeProduct.name,
    description: stripeProduct.description || '',
    price,
    currency,
    priceFormatted: `${currency === 'USD' ? '$' : currency + ' '}${price.toFixed(2)}${isRecurring ? `/${defaultPrice!.recurring!.interval}` : ''}`,
    compareAtPrice: null,
    category: stripeProduct.metadata?.category || '',
    tags: stripeProduct.metadata?.tags ? stripeProduct.metadata.tags.split(',').map(t => t.trim()) : [],
    imageUrl: stripeProduct.images[0] || null,
    status: stripeProduct.active !== false ? 'active' : 'archived',
    variants: [],
    metadata: {
      stripeProductId: stripeProduct.id,
      stripePriceId: defaultPrice?.id,
      isRecurring,
      recurringInterval: defaultPrice?.recurring?.interval,
      recurringIntervalCount: defaultPrice?.recurring?.interval_count,
      ...stripeProduct.metadata,
    },
  };
}

/**
 * Sync products from Stripe for a tenant.
 */
async function syncStripeProducts(
  tenantId: string,
  config: NonNullable<SyncConfig['stripe']>
): Promise<SyncResult> {
  const startTime = Date.now();
  const result: SyncResult = {
    source: 'stripe',
    productsCreated: 0,
    productsUpdated: 0,
    productsArchived: 0,
    errors: [],
    syncedAt: new Date().toISOString(),
    durationMs: 0,
  };

  if (!config.secretKey) {
    result.errors.push('Stripe secret key required');
    result.durationMs = Date.now() - startTime;
    return result;
  }

  try {
    const stripeProducts = await fetchStripeProducts(config.secretKey);

    // Get existing products from this source
    const existing = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id::text, metadata->>'externalId' as external_id
      FROM products
      WHERE tenant_id = '${tenantId}'::uuid AND source = 'stripe'
    `);

    const existingMap = new Map(existing.map(e => [e.external_id, e.id]));
    const syncedExternalIds = new Set<string>();

    for (const sp of stripeProducts) {
      try {
        const product = transformStripeProduct(sp);
        syncedExternalIds.add(sp.id);

        if (existingMap.has(sp.id)) {
          await upsertProduct(tenantId, product, existingMap.get(sp.id)!);
          result.productsUpdated++;
        } else {
          await upsertProduct(tenantId, product);
          result.productsCreated++;
        }
      } catch (err: any) {
        result.errors.push(`Product ${sp.id}: ${err.message}`);
      }
    }

    // Archive products no longer in Stripe
    for (const [extId, dbId] of existingMap) {
      if (!syncedExternalIds.has(extId)) {
        await prisma.$queryRawUnsafe(`
          UPDATE products SET status = 'archived', updated_at = NOW()
          WHERE id = '${dbId}'::uuid AND tenant_id = '${tenantId}'::uuid
        `);
        result.productsArchived++;
      }
    }

    await updateSyncConfig(tenantId, 'stripe', { lastSyncAt: new Date().toISOString() });

  } catch (err: any) {
    result.errors.push(`Stripe sync failed: ${err.message}`);
    console.error('Stripe sync error:', err);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

// ━━ Shared: Product Persistence ━━

/**
 * Upsert a product into the database.
 * Creates new or updates existing product.
 */
async function upsertProduct(
  tenantId: string,
  product: Product,
  existingId?: string
): Promise<string> {
  const id = existingId || crypto.randomUUID();
  const variantsJson = JSON.stringify(product.variants).replace(/'/g, "''");
  const metadataJson = JSON.stringify({
    ...product.metadata,
    externalId: product.externalId,
  }).replace(/'/g, "''");
  const tagsJson = JSON.stringify(product.tags).replace(/'/g, "''");
  const description = (product.description || '').replace(/'/g, "''");
  const name = product.name.replace(/'/g, "''");
  const category = (product.category || '').replace(/'/g, "''");

  if (existingId) {
    await prisma.$queryRawUnsafe(`
      UPDATE products SET
        name = '${name}',
        description = '${description}',
        sku = ${product.sku ? `'${product.sku}'` : 'NULL'},
        price = ${product.price ?? 0},
        currency = '${product.currency}',
        price_formatted = ${product.priceFormatted ? `'${product.priceFormatted}'` : 'NULL'},
        compare_at_price = ${product.compareAtPrice ?? 'NULL'},
        category = '${category}',
        tags = '${tagsJson}'::jsonb,
        image_url = ${product.imageUrl ? `'${product.imageUrl}'` : 'NULL'},
        status = '${product.status}',
        variants = '${variantsJson}'::jsonb,
        metadata = '${metadataJson}'::jsonb,
        updated_at = NOW()
      WHERE id = '${existingId}'::uuid AND tenant_id = '${tenantId}'::uuid
    `);
  } else {
    await prisma.$queryRawUnsafe(`
      INSERT INTO products (
        id, tenant_id, source, name, description, sku, price, currency,
        price_formatted, compare_at_price, category, tags, image_url,
        status, variants, metadata, created_at, updated_at
      ) VALUES (
        '${id}'::uuid, '${tenantId}'::uuid, '${product.source}',
        '${name}', '${description}',
        ${product.sku ? `'${product.sku}'` : 'NULL'},
        ${product.price ?? 0}, '${product.currency}',
        ${product.priceFormatted ? `'${product.priceFormatted}'` : 'NULL'},
        ${product.compareAtPrice ?? 'NULL'},
        '${category}', '${tagsJson}'::jsonb,
        ${product.imageUrl ? `'${product.imageUrl}'` : 'NULL'},
        '${product.status}', '${variantsJson}'::jsonb, '${metadataJson}'::jsonb,
        NOW(), NOW()
      )
    `);
  }

  return id;
}

/**
 * Update Company Truth with latest product catalog summary.
 * Called after any sync operation to keep Brain context current.
 */
async function updateCompanyTruthProducts(tenantId: string): Promise<void> {
  try {
    // Get product summary
    const summary = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(*)::int as total_products,
        COUNT(*) FILTER (WHERE status = 'active')::int as active_products,
        COUNT(DISTINCT category) FILTER (WHERE category != '')::int as categories,
        COALESCE(json_agg(DISTINCT category) FILTER (WHERE category != ''), '[]') as category_list,
        MIN(price) FILTER (WHERE status = 'active' AND price > 0) as min_price,
        MAX(price) FILTER (WHERE status = 'active') as max_price,
        AVG(price) FILTER (WHERE status = 'active' AND price > 0) as avg_price,
        MAX(updated_at) as last_updated
      FROM products
      WHERE tenant_id = '${tenantId}'::uuid
    `);

    const stats = summary[0] || {};

    // Get active products for Brain context (top 50 by most recently updated)
    const activeProducts = await prisma.$queryRawUnsafe<any[]>(`
      SELECT name, description, price, currency, price_formatted, category, status, sku
      FROM products
      WHERE tenant_id = '${tenantId}'::uuid AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 50
    `);

    // Update brain_snapshots company_truth -> products
    const productsSummary = JSON.stringify({
      totalProducts: stats.total_products || 0,
      activeProducts: stats.active_products || 0,
      categories: stats.categories || 0,
      categoryList: stats.category_list || [],
      priceRange: {
        min: stats.min_price || 0,
        max: stats.max_price || 0,
        avg: Math.round((stats.avg_price || 0) * 100) / 100,
      },
      lastUpdated: stats.last_updated?.toISOString?.() || stats.last_updated || null,
      catalog: activeProducts.map((p: any) => ({
        name: p.name,
        description: p.description?.substring(0, 200),
        price: p.price,
        currency: p.currency,
        priceFormatted: p.price_formatted,
        category: p.category,
        sku: p.sku,
      })),
    }).replace(/'/g, "''");

    // Update latest brain snapshot's company_truth.products
    await prisma.$queryRawUnsafe(`
      UPDATE brain_snapshots
      SET company_truth = jsonb_set(
        COALESCE(company_truth, '{}'::jsonb),
        '{products}',
        '${productsSummary}'::jsonb
      ),
      updated_at = NOW()
      WHERE id = (
        SELECT id FROM brain_snapshots
        WHERE tenant_id = '${tenantId}'::uuid
        ORDER BY version DESC
        LIMIT 1
      )
    `).catch((err: any) => {
      console.warn('Brain snapshot update skipped:', err.message);
    });

    console.log(`Company Truth products updated for tenant ${tenantId}: ${stats.active_products} active products`);
  } catch (err: any) {
    console.warn('updateCompanyTruthProducts failed:', err.message);
  }
}

/**
 * Update sync configuration for a source.
 */
async function updateSyncConfig(
  tenantId: string,
  source: 'shopify' | 'stripe',
  updates: Record<string, any>
): Promise<void> {
  const updatesJson = JSON.stringify(updates).replace(/'/g, "''");

  await prisma.$queryRawUnsafe(`
    UPDATE tenants
    SET ai_permissions = jsonb_set(
      COALESCE(ai_permissions, '{}'::jsonb),
      '{productSync,${source}}',
      COALESCE(ai_permissions->'productSync'->'${source}', '{}'::jsonb) || '${updatesJson}'::jsonb
    ),
    updated_at = NOW()
    WHERE id = '${tenantId}'::uuid
  `).catch((err: any) => {
    console.warn('Sync config update skipped:', err.message);
  });
}

// ━━ KAN-153: Manual Product Upload Endpoint ━━

const ManualProductSchema = ProductSchema.omit({ source: true }).extend({
  source: z.literal('manual').default('manual'),
});

const BulkUploadSchema = z.object({
  products: z.array(ManualProductSchema).min(1).max(500),
  replaceExisting: z.boolean().default(false),
});

// ━━ API Routes ━━

/**
 * GET /products/:tenantId
 * List all products for a tenant with optional filters.
 */
router.get('/products/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const status = req.query.status as string || 'active';
    const source = req.query.source as string;
    const category = req.query.category as string;
    const search = req.query.search as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    let whereClause = `tenant_id = '${tenantId}'::uuid`;
    if (status && status !== 'all') {
      whereClause += ` AND status = '${status}'`;
    }
    if (source) {
      whereClause += ` AND source = '${source}'`;
    }
    if (category) {
      whereClause += ` AND category = '${category.replace(/'/g, "''")}'`;
    }
    if (search) {
      const searchEscaped = search.replace(/'/g, "''");
      whereClause += ` AND (name ILIKE '%${searchEscaped}%' OR description ILIKE '%${searchEscaped}%' OR sku ILIKE '%${searchEscaped}%')`;
    }

    const [products, countResult] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(`
        SELECT id::text, source, name, description, sku, price, currency,
               price_formatted, compare_at_price, category, tags, image_url,
               status, variants, metadata, created_at, updated_at
        FROM products
        WHERE ${whereClause}
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
      prisma.$queryRawUnsafe<any[]>(`
        SELECT COUNT(*)::int as total FROM products WHERE ${whereClause}
      `),
    ]);

    const total = countResult[0]?.total || 0;

    return res.json({
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('List products error:', error);
    return res.status(500).json({ error: 'Failed to list products', details: error.message });
  }
});

/**
 * GET /products/:tenantId/:productId
 * Get a single product by ID.
 */
router.get('/products/:tenantId/:productId', async (req: Request, res: Response) => {
  try {
    const { tenantId, productId } = req.params;
    if (!tenantId || !productId) {
      return res.status(400).json({ error: 'tenantId and productId required' });
    }

    const result = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id::text, source, name, description, sku, price, currency,
             price_formatted, compare_at_price, category, tags, image_url,
             status, variants, metadata, created_at, updated_at
      FROM products
      WHERE id = '${productId}'::uuid AND tenant_id = '${tenantId}'::uuid
      LIMIT 1
    `);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json({ product: result[0] });
  } catch (error: any) {
    console.error('Get product error:', error);
    return res.status(500).json({ error: 'Failed to get product', details: error.message });
  }
});

/**
 * POST /products/:tenantId
 * Manually create a single product (KAN-153).
 */
router.post('/products/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const product = ManualProductSchema.parse(req.body);
    const id = await upsertProduct(tenantId, { ...product, source: 'manual' });

    // Update Company Truth
    await updateCompanyTruthProducts(tenantId);

    return res.status(201).json({ id, status: 'created' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Create product error:', error);
    return res.status(500).json({ error: 'Failed to create product', details: error.message });
  }
});

/**
 * PUT /products/:tenantId/:productId
 * Update an existing product.
 */
router.put('/products/:tenantId/:productId', async (req: Request, res: Response) => {
  try {
    const { tenantId, productId } = req.params;
    if (!tenantId || !productId) {
      return res.status(400).json({ error: 'tenantId and productId required' });
    }

    // Verify product exists
    const existing = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id::text, source FROM products
      WHERE id = '${productId}'::uuid AND tenant_id = '${tenantId}'::uuid
      LIMIT 1
    `);

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = ManualProductSchema.partial().parse(req.body);
    await upsertProduct(tenantId, {
      ...product,
      source: existing[0].source || 'manual',
      name: product.name || '',
    } as Product, productId);

    await updateCompanyTruthProducts(tenantId);

    return res.json({ id: productId, status: 'updated' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Update product error:', error);
    return res.status(500).json({ error: 'Failed to update product', details: error.message });
  }
});

/**
 * DELETE /products/:tenantId/:productId
 * Soft-delete (archive) a product.
 */
router.delete('/products/:tenantId/:productId', async (req: Request, res: Response) => {
  try {
    const { tenantId, productId } = req.params;
    if (!tenantId || !productId) {
      return res.status(400).json({ error: 'tenantId and productId required' });
    }

    await prisma.$queryRawUnsafe(`
      UPDATE products SET status = 'archived', updated_at = NOW()
      WHERE id = '${productId}'::uuid AND tenant_id = '${tenantId}'::uuid
    `);

    await updateCompanyTruthProducts(tenantId);

    return res.json({ status: 'archived' });
  } catch (error: any) {
    console.error('Delete product error:', error);
    return res.status(500).json({ error: 'Failed to archive product', details: error.message });
  }
});

/**
 * POST /products/:tenantId/bulk
 * Bulk upload products manually (KAN-153).
 */
router.post('/products/:tenantId/bulk', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const { products, replaceExisting } = BulkUploadSchema.parse(req.body);

    if (replaceExisting) {
      // Archive all existing manual products
      await prisma.$queryRawUnsafe(`
        UPDATE products SET status = 'archived', updated_at = NOW()
        WHERE tenant_id = '${tenantId}'::uuid AND source = 'manual' AND status = 'active'
      `);
    }

    let created = 0;
    const errors: string[] = [];

    for (const product of products) {
      try {
        await upsertProduct(tenantId, { ...product, source: 'manual' });
        created++;
      } catch (err: any) {
        errors.push(`${product.name}: ${err.message}`);
      }
    }

    await updateCompanyTruthProducts(tenantId);

    return res.json({
      status: 'completed',
      created,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Bulk upload error:', error);
    return res.status(500).json({ error: 'Failed to bulk upload', details: error.message });
  }
});

/**
 * POST /products/:tenantId/sync/shopify
 * Trigger Shopify product sync (KAN-151).
 */
router.post('/products/:tenantId/sync/shopify', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    // Get sync config from tenant settings
    const tenant = await prisma.$queryRawUnsafe<any[]>(`
      SELECT ai_permissions->'productSync'->'shopify' as config
      FROM tenants WHERE id = '${tenantId}'::uuid
    `);

    const config = tenant[0]?.config || {};
    if (!config.enabled) {
      return res.status(400).json({ error: 'Shopify sync not enabled for this tenant' });
    }

    const result = await syncShopifyProducts(tenantId, config);
    await updateCompanyTruthProducts(tenantId);

    return res.json(result);
  } catch (error: any) {
    console.error('Shopify sync trigger error:', error);
    return res.status(500).json({ error: 'Failed to trigger Shopify sync', details: error.message });
  }
});

/**
 * POST /products/:tenantId/sync/stripe
 * Trigger Stripe product sync (KAN-152).
 */
router.post('/products/:tenantId/sync/stripe', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const tenant = await prisma.$queryRawUnsafe<any[]>(`
      SELECT ai_permissions->'productSync'->'stripe' as config
      FROM tenants WHERE id = '${tenantId}'::uuid
    `);

    const config = tenant[0]?.config || {};
    if (!config.enabled) {
      return res.status(400).json({ error: 'Stripe sync not enabled for this tenant' });
    }

    const result = await syncStripeProducts(tenantId, config);
    await updateCompanyTruthProducts(tenantId);

    return res.json(result);
  } catch (error: any) {
    console.error('Stripe sync trigger error:', error);
    return res.status(500).json({ error: 'Failed to trigger Stripe sync', details: error.message });
  }
});

/**
 * GET /products/:tenantId/sync/status
 * Get sync status for all connectors.
 */
router.get('/products/:tenantId/sync/status', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const [tenant, productStats] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(`
        SELECT ai_permissions->'productSync' as sync_config
        FROM tenants WHERE id = '${tenantId}'::uuid
      `),
      prisma.$queryRawUnsafe<any[]>(`
        SELECT
          source,
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE status = 'active')::int as active,
          MAX(updated_at) as last_updated
        FROM products
        WHERE tenant_id = '${tenantId}'::uuid
        GROUP BY source
      `),
    ]);

    const syncConfig = tenant[0]?.sync_config || {};
    const statsBySource: Record<string, any> = {};
    for (const s of productStats) {
      statsBySource[s.source] = {
        total: s.total,
        active: s.active,
        lastUpdated: s.last_updated,
      };
    }

    return res.json({
      shopify: {
        enabled: syncConfig.shopify?.enabled || false,
        lastSyncAt: syncConfig.shopify?.lastSyncAt || null,
        syncInterval: syncConfig.shopify?.syncInterval || 'manual',
        products: statsBySource.shopify || { total: 0, active: 0 },
      },
      stripe: {
        enabled: syncConfig.stripe?.enabled || false,
        lastSyncAt: syncConfig.stripe?.lastSyncAt || null,
        syncInterval: syncConfig.stripe?.syncInterval || 'manual',
        products: statsBySource.stripe || { total: 0, active: 0 },
      },
      manual: {
        products: statsBySource.manual || { total: 0, active: 0 },
      },
    });
  } catch (error: any) {
    console.error('Sync status error:', error);
    return res.status(500).json({ error: 'Failed to get sync status', details: error.message });
  }
});

/**
 * PUT /products/:tenantId/sync/config
 * Update sync connector configuration.
 */
router.put('/products/:tenantId/sync/config', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const config = SyncConfigSchema.parse(req.body);

    if (config.shopify) {
      await updateSyncConfig(tenantId, 'shopify', config.shopify);
    }
    if (config.stripe) {
      await updateSyncConfig(tenantId, 'stripe', config.stripe);
    }

    return res.json({ status: 'updated' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Config update error:', error);
    return res.status(500).json({ error: 'Failed to update config', details: error.message });
  }
});

/**
 * GET /products/:tenantId/categories
 * Get distinct product categories for a tenant.
 */
router.get('/products/:tenantId/categories', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const categories = await prisma.$queryRawUnsafe<any[]>(`
      SELECT category, COUNT(*)::int as product_count
      FROM products
      WHERE tenant_id = '${tenantId}'::uuid AND status = 'active' AND category != ''
      GROUP BY category
      ORDER BY product_count DESC
    `);

    return res.json({ categories });
  } catch (error: any) {
    console.error('Categories error:', error);
    return res.status(500).json({ error: 'Failed to get categories', details: error.message });
  }
});

export default router;
export {
  // Sync functions
  syncShopifyProducts,
  syncStripeProducts,
  // Transformers
  transformShopifyProduct,
  transformStripeProduct,
  // Persistence
  upsertProduct,
  updateCompanyTruthProducts,
  updateSyncConfig,
  // Fetch functions
  fetchShopifyProducts,
  fetchStripeProducts,
};
export {
  ProductSchema,
  ShopifyProductSchema,
  StripeProductSchema,
  SyncConfigSchema,
  ManualProductSchema,
  BulkUploadSchema,
};
export type {
  Product,
  SyncConfig,
  SyncResult,
};
