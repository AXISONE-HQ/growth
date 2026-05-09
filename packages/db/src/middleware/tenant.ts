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
  // KAN-700: PipelineCard removed; per-Lead pipeline state lives on Contact now.
  // Guardrail added (tenantId always present, pipelineId nullable for tenant-wide).
  // MicroObjective deliberately NOT listed — its tenantId is nullable for platform
  // defaults, so the auto-inject middleware would exclude defaults from queries.
  // Consumers handle the tenant + platform-default merge explicitly.
  'Guardrail',
  'Customer',
  'Conversation',
  'Escalation',
  'KnowledgeBase',
  'AiAgentConfig',
  // KAN-826: Sprint 11a Knowledge Layer (replaces KAN-706 legacy schema).
  // ChunkEffectiveness deliberately NOT listed — no tenant_id column on the
  // model (architect spec §2 loose-FK semantics; tenant context flows via
  // JOIN to KnowledgeChunk at read-time).
  'KnowledgeSource',
  'KnowledgeChunk',
  'KnowledgeGapSummary',
  // KAN-852: Account Page Cohort 1. AccountProfile is 1:1 with Tenant via
  // tenant_id @unique. Its 4 children (SocialProfile, ObservedHoliday,
  // IndustryDisclosure, AccountFieldDetection) are deliberately NOT listed —
  // they have no direct tenant_id column; tenant scope flows transitively
  // through account_profile_id → AccountProfile.tenantId. Auto-injecting
  // tenantId into a where clause for those models would target a
  // non-existent column and break every query. Same precedent as
  // ChunkEffectiveness (line ~38). If Cohort 5/6 introduces $queryRaw
  // against AccountFieldDetection, add an accountTenantGuardMiddleware
  // mirroring knowledgeTenantGuardMiddleware below.
  'AccountProfile',
] as const;

// KAN-826 — defensive guardrail (architect spec §6.1). Knowledge Layer queries
// MUST be tenant-scoped because $queryRaw is the canonical retrieval path
// (pgvector cosine search via raw SQL) and the auto-inject middleware above
// only runs against the typed Prisma client. This guardrail catches any
// non-$queryRaw query on the 3 KB tables that lacks a tenantId filter and
// THROWS — defense-in-depth against accidental cross-tenant leakage. Apply
// to system-level Prisma clients (worker, cron) where withTenantContext is
// not in scope. Sibling to the auto-inject pattern; the two run together.
const KNOWLEDGE_GUARD_MODELS = ['KnowledgeSource', 'KnowledgeChunk', 'KnowledgeGapSummary'] as const;

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

/**
 * KAN-826 — Knowledge Layer tenant-isolation guardrail middleware.
 *
 * Throws on any read/write/delete/upsert query against KnowledgeSource,
 * KnowledgeChunk, or KnowledgeGapSummary that does NOT include a `tenantId`
 * (or `tenant_id`) filter in the where clause. Catches accidental
 * cross-tenant queries from system-level code paths (worker, cron) where
 * the auto-inject `tenantMiddleware` is not active.
 *
 * Defense-in-depth pattern: pairs with auto-inject `tenantMiddleware` for
 * request-scoped clients; this guardrail covers the gaps where tenant
 * context isn't available and a developer must pass tenantId explicitly.
 *
 * Compound `where` clauses (`AND` / `OR`) are accepted at this layer —
 * deeper inspection is too brittle (the architect spec §6 also requires
 * visual review of every $queryRaw to enforce `tenant_id = $1` literally).
 *
 * Usage:
 *   prisma.$use(knowledgeTenantGuardMiddleware());
 *
 * @example
 * ```typescript
 * await prisma.knowledgeChunk.findMany({}); // throws — no tenantId
 * await prisma.knowledgeChunk.findMany({ where: { tenantId: 'x' } }); // ok
 * ```
 */
export function knowledgeTenantGuardMiddleware(): Prisma.Middleware {
  const guarded = new Set<string>(KNOWLEDGE_GUARD_MODELS);
  return async (params, next) => {
    if (!params.model || !guarded.has(params.model)) {
      return next(params);
    }
    // Write paths: create/createMany must include tenantId in data; the
    // auto-inject middleware injects it for tenant-context clients, but
    // for system-level callers we require an explicit value.
    if (params.action === 'create' || params.action === 'upsert') {
      const data = params.action === 'create' ? params.args?.data : params.args?.create;
      if (!data || (typeof data === 'object' && !('tenantId' in data) && !('tenant_id' in data))) {
        throw new Error(
          `[knowledge-tenant-guard] Tenant isolation violation: ${params.action} on ${params.model} without tenantId in data`,
        );
      }
    }
    if (params.action === 'createMany') {
      const data = params.args?.data;
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (!item || (typeof item === 'object' && !('tenantId' in item) && !('tenant_id' in item))) {
          throw new Error(
            `[knowledge-tenant-guard] Tenant isolation violation: createMany on ${params.model} with row missing tenantId`,
          );
        }
      }
    }
    // Read/update/delete paths: where clause must include a tenantId filter
    // (or AND/OR for compound queries — accepted at this layer; visual
    // review of $queryRaw covers the deeper cases per architect spec §6).
    if (
      params.action === 'findUnique' ||
      params.action === 'findFirst' ||
      params.action === 'findMany' ||
      params.action === 'count' ||
      params.action === 'aggregate' ||
      params.action === 'groupBy' ||
      params.action === 'update' ||
      params.action === 'updateMany' ||
      params.action === 'delete' ||
      params.action === 'deleteMany'
    ) {
      const where = params.args?.where;
      const hasTenantFilter =
        where &&
        typeof where === 'object' &&
        ('tenantId' in where || 'tenant_id' in where || 'AND' in where || 'OR' in where);
      if (!hasTenantFilter) {
        throw new Error(
          `[knowledge-tenant-guard] Tenant isolation violation: ${params.action} on ${params.model} without tenantId filter in where`,
        );
      }
    }
    return next(params);
  };
}

export default {
  tenantMiddleware,
  withTenantContext,
  extractTenantId,
  tenantContextMiddleware,
  knowledgeTenantGuardMiddleware,
};
