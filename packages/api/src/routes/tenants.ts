/**
 * Tenant CRUD API Endpoints
 * KAN-98: RESTful API for tenant management
 *
 * Routes:
 *   POST   /api/tenants          - Create tenant
 *   GET    /api/tenants           - List tenants (admin)
 *   GET    /api/tenants/:id       - Get tenant by ID
 *   PATCH  /api/tenants/:id       - Update tenant
 *   DELETE /api/tenants/:id       - Soft-delete tenant
 *   GET    /api/tenants/:id/settings - Get tenant settings
 *   PATCH  /api/tenants/:id/settings - Update tenant settings
 */

import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { materializeDefaultsForTenant } from '../../../db/prisma/seeds/micro-objectives.js';

// ─── Validation Schemas ───────────────────────────────────

const CreateTenantSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  planTier: z.enum(['free', 'starter', 'pro', 'enterprise']).optional().default('free'),
  blueprintId: z.string().uuid().optional(),
  settings: z.record(z.unknown()).optional().default({}),
});

const UpdateTenantSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  planTier: z.enum(['free', 'starter', 'pro', 'enterprise']).optional(),
  blueprintId: z.string().uuid().nullable().optional(),
  confidenceThreshold: z.number().int().min(0).max(100).optional(),
  aiPermissions: z.record(z.unknown()).optional(),
});

const UpdateSettingsSchema = z.object({
  settings: z.record(z.unknown()),
});

const ListTenantsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().optional(),
  planTier: z.enum(['free', 'starter', 'pro', 'enterprise']).optional(),
});

// ─── Router Factory ───────────────────────────────────────

export function createTenantsRouter(prisma: PrismaClient): Router {
  const router = Router();

  /**
   * POST /api/tenants - Create a new tenant
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const data = CreateTenantSchema.parse(req.body);

      // Check slug uniqueness
      const existing = await prisma.tenant.findUnique({
        where: { slug: data.slug },
      });
      if (existing) {
        return res.status(409).json({
          error: 'Conflict',
          message: `Tenant with slug "${data.slug}" already exists`,
        });
      }

      const tenant = await prisma.tenant.create({
        data: {
          name: data.name,
          slug: data.slug,
          planTier: data.planTier,
          blueprintId: data.blueprintId,
          settings: data.settings as Prisma.InputJsonValue,
        },
        include: {
          blueprint: true,
        },
      });

      // Create audit log entry
      await prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          actor: req.auth?.userId || 'system',
          actionType: 'tenant.created',
          payload: { name: data.name, slug: data.slug, planTier: data.planTier } as Prisma.InputJsonValue,
        },
      });

      // KAN-701: clone the 5 platform-default MicroObjectives to per-tenant
      // rows. Best-effort — log on failure but never block tenant creation;
      // the backfill script can recover any stragglers.
      try {
        const seedResult = await materializeDefaultsForTenant(prisma, tenant.id);
        console.log(
          `[tenants] seeded MicroObjectives for tenant ${tenant.slug}: created=${seedResult.created} skipped=${seedResult.skipped}`,
        );
      } catch (seedError) {
        console.error(
          `[tenants] MicroObjective seed failed for tenant ${tenant.slug} — backfill script can recover:`,
          seedError,
        );
      }

      return res.status(201).json({ data: tenant });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation Error',
          details: error.errors,
        });
      }
      console.error('Failed to create tenant:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  /**
   * GET /api/tenants - List all tenants (admin only)
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const query = ListTenantsQuerySchema.parse(req.query);
      const skip = (query.page - 1) * query.limit;

      const where: Prisma.TenantWhereInput = {};

      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: 'insensitive' } },
          { slug: { contains: query.search, mode: 'insensitive' } },
        ];
      }

      if (query.planTier) {
        where.planTier = query.planTier;
      }

      const [tenants, total] = await Promise.all([
        prisma.tenant.findMany({
          where,
          skip,
          take: query.limit,
          orderBy: { createdAt: 'desc' },
          include: {
            _count: {
              select: {
                users: true,
                contacts: true,
              },
            },
          },
        }),
        prisma.tenant.count({ where }),
      ]);

      return res.json({
        data: tenants,
        meta: {
          total,
          page: query.page,
          limit: query.limit,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation Error',
          details: error.errors,
        });
      }
      console.error('Failed to list tenants:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  /**
   * GET /api/tenants/:id - Get tenant by ID
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.params.id },
        include: {
          blueprint: true,
          _count: {
            select: {
              users: true,
              contacts: true,
              objectives: true,
              pipelines: true,
            },
          },
        },
      });

      if (!tenant) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Tenant not found',
        });
      }

      return res.json({ data: tenant });
    } catch (error) {
      console.error('Failed to get tenant:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  /**
   * PATCH /api/tenants/:id - Update tenant
   */
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const data = UpdateTenantSchema.parse(req.body);

      // Verify tenant exists
      const existing = await prisma.tenant.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Tenant not found',
        });
      }

      const tenant = await prisma.tenant.update({
        where: { id: req.params.id },
        data: {
          ...data,
          aiPermissions: data.aiPermissions as Prisma.InputJsonValue,
        },
        include: {
          blueprint: true,
        },
      });

      // Audit log
      await prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          actor: req.auth?.userId || 'system',
          actionType: 'tenant.updated',
          payload: data as Prisma.InputJsonValue,
        },
      });

      return res.json({ data: tenant });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation Error',
          details: error.errors,
        });
      }
      console.error('Failed to update tenant:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  /**
   * DELETE /api/tenants/:id - Soft-delete (deactivate) tenant
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const existing = await prisma.tenant.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Tenant not found',
        });
      }

      // Soft delete by updating settings
      const tenant = await prisma.tenant.update({
        where: { id: req.params.id },
        data: {
          settings: {
            ...(existing.settings as Record<string, unknown>),
            deactivatedAt: new Date().toISOString(),
            isActive: false,
          },
        },
      });

      // Audit log
      await prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          actor: req.auth?.userId || 'system',
          actionType: 'tenant.deactivated',
          payload: { deactivatedAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });

      return res.status(200).json({
        data: { id: tenant.id, deactivated: true },
      });
    } catch (error) {
      console.error('Failed to delete tenant:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  /**
   * GET /api/tenants/:id/settings - Get tenant settings
   */
  router.get('/:id/settings', async (req: Request, res: Response) => {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          settings: true,
          aiPermissions: true,
          confidenceThreshold: true,
          planTier: true,
        },
      });

      if (!tenant) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Tenant not found',
        });
      }

      return res.json({ data: tenant });
    } catch (error) {
      console.error('Failed to get tenant settings:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  /**
   * PATCH /api/tenants/:id/settings - Update tenant settings
   */
  router.patch('/:id/settings', async (req: Request, res: Response) => {
    try {
      const { settings } = UpdateSettingsSchema.parse(req.body);

      const existing = await prisma.tenant.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Tenant not found',
        });
      }

      // Merge settings (shallow merge)
      const mergedSettings = {
        ...(existing.settings as Record<string, unknown>),
        ...settings,
      };

      const tenant = await prisma.tenant.update({
        where: { id: req.params.id },
        data: {
          settings: mergedSettings as Prisma.InputJsonValue,
        },
        select: {
          id: true,
          settings: true,
        },
      });

      // Audit log
      await prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          actor: req.auth?.userId || 'system',
          actionType: 'tenant.settings_updated',
          payload: { updatedKeys: Object.keys(settings) } as Prisma.InputJsonValue,
        },
      });

      return res.json({ data: tenant });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation Error',
          details: error.errors,
        });
      }
      console.error('Failed to update tenant settings:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

// Type augmentation for Express Request
declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        tenantId: string;
        role: string;
      };
      tenantId?: string;
      prisma?: PrismaClient;
    }
  }
}

export default createTenantsRouter;
