/**
 * Contact CRUD API Endpoints
 * KAN-27: RESTful API for manual contact entry
 *
 * Routes:
 *   POST   /api/contacts          - Create contact
 *   GET    /api/contacts          - List contacts (with filters & pagination)
 *   GET    /api/contacts/:id      - Get contact by ID
 *   PATCH  /api/contacts/:id      - Update contact
 *   DELETE /api/contacts/:id      - Soft-delete contact (archive)
 *   POST   /api/contacts/bulk     - Bulk create contacts
 */

import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();

// —— Validation Schemas ——————————————————————————————————

const LifecycleStageEnum = z.enum([
  'new',
  'lead',
  'qualified',
  'opportunity',
  'customer',
  'churned',
  'reactivated',
]);

const ContactSourceEnum = z.enum([
  'manual',
  'csv_import',
  'crm_sync',
  'webhook',
  'lead_ads',
  'api',
  'form',
]);

const CreateContactSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .max(255)
    .optional()
    .nullable(),
  phone: z
    .string()
    .min(7, 'Phone number too short')
    .max(20, 'Phone number too long')
    .optional()
    .nullable(),
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),
  externalIds: z.record(z.string()).optional().default({}),
  segment: z.string().max(100).optional().nullable(),
  lifecycleStage: LifecycleStageEnum.optional().default('new'),
  source: ContactSourceEnum.optional().default('manual'),
}).refine(
  (data) => data.email || data.phone,
  { message: 'At least one of email or phone is required' }
);

const UpdateContactSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .max(255)
    .optional()
    .nullable(),
  phone: z
    .string()
    .min(7, 'Phone number too short')
    .max(20, 'Phone number too long')
    .optional()
    .nullable(),
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),
  externalIds: z.record(z.string()).optional(),
  segment: z.string().max(100).optional().nullable(),
  lifecycleStage: LifecycleStageEnum.optional(),
  source: ContactSourceEnum.optional(),
});

const BulkCreateContactSchema = z.object({
  contacts: z
    .array(CreateContactSchema)
    .min(1, 'At least one contact is required')
    .max(500, 'Maximum 500 contacts per batch'),
});

const ListContactsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  search: z.string().max(200).optional(),
  lifecycleStage: LifecycleStageEnum.optional(),
  segment: z.string().max(100).optional(),
  source: ContactSourceEnum.optional(),
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'firstName', 'lastName', 'email', 'dataQualityScore'])
    .optional()
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

// —— Helper: extract tenant context ——————————————————————

function getTenantId(req: Request): string {
  // tenant_id is injected by auth middleware (from JWT / session)
  const tenantId = (req as any).tenantId || req.headers['x-tenant-id'];
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('Missing tenant context');
  }
  return tenantId;
}

// —— POST /api/contacts — Create a contact ———————————————

router.post('/', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = CreateContactSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const data = parsed.data;

    // Check for duplicate by email or phone within same tenant
    if (data.email || data.phone) {
      const existingWhere: Prisma.ContactWhereInput[] = [];
      if (data.email) {
        existingWhere.push({ tenantId, email: data.email });
      }
      if (data.phone) {
        existingWhere.push({ tenantId, phone: data.phone });
      }

      const existing = await prisma.contact.findFirst({
        where: { OR: existingWhere },
        select: { id: true, email: true, phone: true },
      });

      if (existing) {
        return res.status(409).json({
          error: 'Contact already exists',
          existingContactId: existing.id,
          matchedOn: existing.email === data.email ? 'email' : 'phone',
        });
      }
    }

    const contact = await prisma.contact.create({
      data: {
        tenantId,
        email: data.email ?? null,
        phone: data.phone ?? null,
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        externalIds: data.externalIds || {},
        segment: data.segment ?? null,
        lifecycleStage: data.lifecycleStage,
        source: data.source,
        dataQualityScore: 0, // Will be scored by quality gate service
      },
    });

    return res.status(201).json({ data: contact });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('POST /api/contacts error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— GET /api/contacts — List contacts with filters ———————

router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = ListContactsQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, search, lifecycleStage, segment, source, sortBy, sortOrder } =
      parsed.data;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.ContactWhereInput = { tenantId };

    if (lifecycleStage) where.lifecycleStage = lifecycleStage;
    if (segment) where.segment = segment;
    if (source) where.source = source;

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          segment: true,
          lifecycleStage: true,
          source: true,
          dataQualityScore: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.contact.count({ where }),
    ]);

    return res.status(200).json({
      data: contacts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('GET /api/contacts error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— GET /api/contacts/:id — Get single contact ——————————

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const contact = await prisma.contact.findFirst({
      where: { id, tenantId },
      include: {
        contactStates: {
          select: {
            id: true,
            objectiveId: true,
            subObjectives: true,
            strategyCurrent: true,
            confidenceScore: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    return res.status(200).json({ data: contact });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('GET /api/contacts/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— PATCH /api/contacts/:id — Update contact ————————————

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const parsed = UpdateContactSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // Verify contact exists and belongs to tenant
    const existing = await prisma.contact.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // If updating email/phone, check for duplicates
    const data = parsed.data;
    if (data.email || data.phone) {
      const dupeWhere: Prisma.ContactWhereInput[] = [];
      if (data.email) {
        dupeWhere.push({ tenantId, email: data.email, id: { not: id } });
      }
      if (data.phone) {
        dupeWhere.push({ tenantId, phone: data.phone, id: { not: id } });
      }

      if (dupeWhere.length > 0) {
        const duplicate = await prisma.contact.findFirst({
          where: { OR: dupeWhere },
          select: { id: true },
        });

        if (duplicate) {
          return res.status(409).json({
            error: 'A contact with this email or phone already exists',
            existingContactId: duplicate.id,
          });
        }
      }
    }

    const contact = await prisma.contact.update({
      where: { id },
      data: {
        ...(data.email !== undefined && { email: data.email }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.externalIds !== undefined && { externalIds: data.externalIds }),
        ...(data.segment !== undefined && { segment: data.segment }),
        ...(data.lifecycleStage !== undefined && { lifecycleStage: data.lifecycleStage }),
        ...(data.source !== undefined && { source: data.source }),
      },
    });

    return res.status(200).json({ data: contact });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('PATCH /api/contacts/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— DELETE /api/contacts/:id — Soft-delete (archive) ————

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const existing = await prisma.contact.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Soft-delete by moving to 'archived' lifecycle stage
    await prisma.contact.update({
      where: { id },
      data: { lifecycleStage: 'archived' },
    });

    return res.status(200).json({ message: 'Contact archived successfully' });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('DELETE /api/contacts/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— POST /api/contacts/bulk — Bulk create ———————————————

router.post('/bulk', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = BulkCreateContactSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { contacts: contactsInput } = parsed.data;
    const created: any[] = [];
    const skipped: { index: number; reason: string; existingContactId?: string }[] = [];

    // Process in a transaction for atomicity
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < contactsInput.length; i++) {
        const data = contactsInput[i];

        // Check for duplicate
        const dupeWhere: Prisma.ContactWhereInput[] = [];
        if (data.email) dupeWhere.push({ tenantId, email: data.email });
        if (data.phone) dupeWhere.push({ tenantId, phone: data.phone });

        if (dupeWhere.length > 0) {
          const existing = await tx.contact.findFirst({
            where: { OR: dupeWhere },
            select: { id: true },
          });

          if (existing) {
            skipped.push({
              index: i,
              reason: 'Duplicate contact',
              existingContactId: existing.id,
            });
            continue;
          }
        }

        const contact = await tx.contact.create({
          data: {
            tenantId,
            email: data.email ?? null,
            phone: data.phone ?? null,
            firstName: data.firstName ?? null,
            lastName: data.lastName ?? null,
            externalIds: data.externalIds || {},
            segment: data.segment ?? null,
            lifecycleStage: data.lifecycleStage || 'new',
            source: data.source || 'manual',
            dataQualityScore: 0,
          },
        });

        created.push(contact);
      }
    });

    return res.status(201).json({
      data: {
        created: created.length,
        skipped: skipped.length,
        total: contactsInput.length,
        contacts: created,
        skippedDetails: skipped,
      },
    });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('POST /api/contacts/bulk error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
