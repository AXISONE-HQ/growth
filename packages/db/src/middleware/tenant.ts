/**
 * Prisma Middleware for Multi-Tenant Context Injection
 * KAN-97: Automatically injects tenant_id into every query
 *
 * Usage:
 *   import { withTenantContext } from './middleware/tenant';
 *   const prisma = withTenantContext(new PrismaClient(), tenantId);
 */

import { PrismaClient, Prisma } from '@prisma/client';

// Models that require tenant_id filtering
const TENANT_SCOPED_MODELS = [
  'User',
  'Contact',
  'ContactState',
  'BrainSnapshot',
  'Objective',
  'Decision',
  'Action',
  'Outcome',
  'StrategyWeight',
  'AuditLog',
  'Pipeline',
  'PipelineCard',
  'Customer',
  'Conversation',
  'Escalation',
  'KnowledgeBase',
  'AiAgentConfig',
] as const;

// Models that are global (not tenant-scoped)
const GLOBAL_MODELS = ['Blueprint'] as const;

type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

/**
 * Check if a model is tenant-scoped
 */
function isTenantScoped(model: string): model is TenantScopedModel {
  return TENANT_SCOPED_MODELS.includes(model as TenantScopedModel);
}

/**
 * Prisma middleware that enforces tenant isolation.
 * Injects tenant_id into all queries for tenant-scoped models.
 */
export function tenantMiddleware(
  tenantId: string
): Prisma.Middleware {
  return async (
    params: Prisma.MiddlewareParams,
    next: (params: Prisma.MiddlewareParams) => Promise<any>
  ) => {
    if (!params.model || !isTenantScoped(params.model)) {
      return next(params);
    }

    // Inject tenant_id for write operations
    switch (params.action) {
      case 'create':
        params.args.data = {
          ...params.args.data,
          tenantId,
        };
        break;

      case 'createMany':
        if (Array.isArray(params.args.data)) {
          params.args.data = params.args.data.map((item: any) => ({
            ...item,
            tenantId,
          }));
        } else {
          params.args.data = {
            ...params.args.data,
            tenantId,
          };
        }
        break;

      // Inject tenant_id filter for read/update/delete operations
      case 'findUnique':
      case 'findFirst':
      case 'findMany':
      case 'count':
      case 'aggregate':
      case 'groupBy':
        params.args.where = {
          ...params.args.where,
          tenantId,
        };
        break;

      case 'update':
        params.args.where = {
          ...params.args.where,
          tenantId,
        };
        break;

      case 'updateMany':
        params.args.where = {
          ...params.args.where,
          tenantId,
        };
        break;

      case 'delete':
        params.args.where = {
          ...params.args.where,
          tenantId,
        };
        break;

      case 'deleteMany':
        params.args.where = {
          ...params.args.where,
          tenantId,
        };
        break;

      case 'upsert':
        params.args.where = {
          ...params.args.where,
          tenantId,
        };
        params.args.create = {
          ...params.args.create,
          tenantId,
        };
        break;
    }

    return next(params);
  };
}

/**
 * Creates a tenant-scoped Prisma client by attaching the tenant middleware.
 *
 * @param prisma - Base PrismaClient instance
 * @param tenantId - The tenant ID to scope all queries to
 * @returns The same PrismaClient instance with tenant middleware applied
 *
 * @example
 * ```typescript
 * const prisma = new PrismaClient();
 * const tenantPrisma = withTenantContext(prisma, 'tenant-uuid-123');
 *
 * // All queries are now automatically scoped to tenant-uuid-123
 * const contacts = await tenantPrisma.contact.findMany();
 * ```
 */
export function withTenantContext(
  prisma: PrismaClient,
  tenantId: string
): PrismaClient {
  if (!tenantId) {
    throw new Error('tenantId is required for tenant context');
  }

  prisma.$use(tenantMiddleware(tenantId));
  return prisma;
}

/**
 * Express/Cloud Run middleware to extract tenant context from request.
 * Reads tenant ID from x-tenant-id header or JWT claims.
 */
export function extractTenantId(req: any): string | null {
  // 1. Check explicit header
  const headerTenantId = req.headers?.['x-tenant-id'];
  if (headerTenantId && typeof headerTenantId === 'string') {
    return headerTenantId;
  }

  // 2. Check JWT claims (set by auth middleware)
  const jwtTenantId = req.auth?.tenantId || req.user?.tenantId;
  if (jwtTenantId && typeof jwtTenantId === 'string') {
    return jwtTenantId;
  }

  return null;
}

/**
 * Express middleware that attaches a tenant-scoped Prisma client to the request.
 *
 * @example
 * ```typescript
 * app.use(tenantContextMiddleware(prisma));
 * app.get('/contacts', (req, res) => {
 *   const contacts = await req.prisma.contact.findMany();
 * });
 * ```
 */
export function tenantContextMiddleware(prisma: PrismaClient) {
  return (req: any, res: any, next: () => void) => {
    const tenantId = extractTenantId(req);

    if (!tenantId) {
      return res.status(401).json({
        error: 'Missing tenant context',
        message: 'x-tenant-id header or valid JWT with tenantId claim is required',
      });
    }

    // Attach tenant-scoped client to request
    req.tenantId = tenantId;
    req.prisma = withTenantContext(prisma, tenantId);
    next();
  };
}

export default {
  tenantMiddleware,
  withTenantContext,
  extractTenantId,
  tenantContextMiddleware,
};
