/**
 * Identity Resolution & Deduplication Service
 * KAN-22: Match contacts by email/phone/externalId, merge duplicates,
 *         maintain unified entity identity across all data sources.
 *
 * Subtasks:
 *   KAN-112 — Email/phone/external ID matching
 *   KAN-113 — Merge logic for duplicate contacts
 *   KAN-114 — Unified entity record
 *
 * Routes:
 *   GET    /api/contacts/:id/duplicates   - Find duplicate candidates
 *   POST   /api/contacts/merge            - Merge two contacts
 *   POST   /api/contacts/resolve          - Auto-resolve: find-or-create with dedup
 */

import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();

// —— Validation Schemas ——————————————————————————————————

const MergeContactsSchema = z.object({
  primaryContactId: z.string().uuid('Invalid primary contact ID'),
  secondaryContactId: z.string().uuid('Invalid secondary contact ID'),
  fieldOverrides: z
    .object({
      email: z.enum(['primary', 'secondary']).optional(),
      phone: z.enum(['primary', 'secondary']).optional(),
      firstName: z.enum(['primary', 'secondary']).optional(),
      lastName: z.enum(['primary', 'secondary']).optional(),
      segment: z.enum(['primary', 'secondary']).optional(),
      lifecycleStage: z.enum(['primary', 'secondary']).optional(),
    })
    .optional()
    .default({}),
});

const ResolveContactSchema = z.object({
  email: z.string().email().max(255).optional().nullable(),
  phone: z.string().min(7).max(20).optional().nullable(),
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),
  externalIds: z.record(z.string()).optional().default({}),
  segment: z.string().max(100).optional().nullable(),
  source: z.string().max(50).optional().default('api'),
}).refine(
  (data) => data.email || data.phone || Object.keys(data.externalIds || {}).length > 0,
  { message: 'At least one of email, phone, or externalIds is required for identity resolution' }
);

// —— Helper: extract tenant context ——————————————————————

function getTenantId(req: Request): string {
  const tenantId = (req as any).tenantId || req.headers['x-tenant-id'];
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('Missing tenant context');
  }
  return tenantId;
}

// —— Core: Identity Matching Engine (KAN-112) ————————————

interface MatchResult {
  contactId: string;
  matchedOn: ('email' | 'phone' | 'externalId')[];
  confidence: number; // 0-100
  contact: {
    id: string;
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    segment: string | null;
    lifecycleStage: string;
    source: string | null;
    dataQualityScore: number;
    createdAt: Date;
  };
}

/**
 * Find all contacts within a tenant that match on email, phone, or any external ID.
 * Returns matches ranked by confidence:
 *   - email match = 50 points
 *   - phone match = 40 points
 *   - externalId match = 30 points per key
 *   - Multiple matches on same contact compound (email + phone = 90)
 */
async function findMatches(
  tenantId: string,
  criteria: { email?: string | null; phone?: string | null; externalIds?: Record<string, string> },
  excludeContactId?: string
): Promise<MatchResult[]> {
  const orConditions: Prisma.ContactWhereInput[] = [];

  if (criteria.email) {
    orConditions.push({
      tenantId,
      email: { equals: criteria.email, mode: 'insensitive' },
    });
  }

  if (criteria.phone) {
    // Normalize phone: strip non-digits for comparison
    const normalizedPhone = criteria.phone.replace(/\D/g, '');
    orConditions.push({
      tenantId,
      phone: { contains: normalizedPhone.slice(-10) }, // Match last 10 digits
    });
  }

  // External ID matching — check each key/value pair
  if (criteria.externalIds && Object.keys(criteria.externalIds).length > 0) {
    for (const [key, value] of Object.entries(criteria.externalIds)) {
      orConditions.push({
        tenantId,
        externalIds: {
          path: [key],
          equals: value,
        },
      });
    }
  }

  if (orConditions.length === 0) {
    return [];
  }

  const candidates = await prisma.contact.findMany({
    where: {
      AND: [
        { tenantId },
        { OR: orConditions },
        ...(excludeContactId ? [{ id: { not: excludeContactId } }] : []),
        { lifecycleStage: { not: 'archived' } }, // Skip archived/soft-deleted
      ],
    },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      externalIds: true,
      segment: true,
      lifecycleStage: true,
      source: true,
      dataQualityScore: true,
      createdAt: true,
    },
  });

  // Score each candidate
  const results: MatchResult[] = candidates.map((candidate) => {
    const matchedOn: ('email' | 'phone' | 'externalId')[] = [];
    let confidence = 0;

    // Email match (case-insensitive)
    if (
      criteria.email &&
      candidate.email &&
      criteria.email.toLowerCase() === candidate.email.toLowerCase()
    ) {
      matchedOn.push('email');
      confidence += 50;
    }

    // Phone match (last 10 digits)
    if (criteria.phone && candidate.phone) {
      const inputNorm = criteria.phone.replace(/\D/g, '').slice(-10);
      const candidateNorm = candidate.phone.replace(/\D/g, '').slice(-10);
      if (inputNorm === candidateNorm && inputNorm.length >= 7) {
        matchedOn.push('phone');
        confidence += 40;
      }
    }

    // External ID match
    if (criteria.externalIds && candidate.externalIds) {
      const candidateExtIds = candidate.externalIds as Record<string, string>;
      for (const [key, value] of Object.entries(criteria.externalIds)) {
        if (candidateExtIds[key] === value) {
          if (!matchedOn.includes('externalId')) matchedOn.push('externalId');
          confidence += 30;
        }
      }
    }

    return {
      contactId: candidate.id,
      matchedOn,
      confidence: Math.min(confidence, 100),
      contact: {
        id: candidate.id,
        email: candidate.email,
        phone: candidate.phone,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        segment: candidate.segment,
        lifecycleStage: candidate.lifecycleStage,
        source: candidate.source,
        dataQualityScore: candidate.dataQualityScore,
        createdAt: candidate.createdAt,
      },
    };
  });

  // Sort by confidence descending, then by createdAt ascending (older = more authoritative)
  results.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.contact.createdAt.getTime() - b.contact.createdAt.getTime();
  });

  return results;
}

// —— Core: Contact Merge Engine (KAN-113 + KAN-114) ——————

interface MergeResult {
  mergedContact: any;
  relationsTransferred: {
    contactStates: number;
    decisions: number;
    outcomes: number;
    actions: number;
    pipelineCards: number;
    conversations: number;
    escalations: number;
    customer: boolean;
  };
  secondaryArchived: boolean;
}

/**
 * Merge secondaryContact into primaryContact:
 * 1. Transfer all relations from secondary to primary
 * 2. Merge fields (primary wins unless overridden)
 * 3. Merge externalIds (union of both)
 * 4. Archive the secondary contact
 * 5. Log the merge in audit_log
 *
 * All operations run in a single transaction.
 */
async function mergeContacts(
  tenantId: string,
  primaryId: string,
  secondaryId: string,
  fieldOverrides: Record<string, 'primary' | 'secondary'>
): Promise<MergeResult> {
  return await prisma.$transaction(async (tx) => {
    // 1. Load both contacts
    const [primary, secondary] = await Promise.all([
      tx.contact.findFirst({
        where: { id: primaryId, tenantId },
      }),
      tx.contact.findFirst({
        where: { id: secondaryId, tenantId },
      }),
    ]);

    if (!primary) throw new Error('Primary contact not found');
    if (!secondary) throw new Error('Secondary contact not found');
    if (primary.id === secondary.id) throw new Error('Cannot merge a contact with itself');

    // 2. Build merged field values
    const mergedFields: Record<string, any> = {};
    const fieldKeys = ['email', 'phone', 'firstName', 'lastName', 'segment', 'lifecycleStage'] as const;

    for (const field of fieldKeys) {
      const winner = fieldOverrides[field] || 'primary';
      const primaryVal = primary[field];
      const secondaryVal = secondary[field];

      if (winner === 'secondary' && secondaryVal != null) {
        mergedFields[field] = secondaryVal;
      } else if (primaryVal == null && secondaryVal != null) {
        // Fill gaps: if primary is null, use secondary
        mergedFields[field] = secondaryVal;
      }
      // Otherwise primary value stays (no update needed)
    }

    // 3. Merge externalIds (union — secondary values don't overwrite primary)
    const primaryExtIds = (primary.externalIds as Record<string, string>) || {};
    const secondaryExtIds = (secondary.externalIds as Record<string, string>) || {};
    const mergedExtIds = { ...secondaryExtIds, ...primaryExtIds }; // primary wins on conflict
    mergedFields.externalIds = mergedExtIds;

    // 4. Take the higher data quality score
    mergedFields.dataQualityScore = Math.max(
      primary.dataQualityScore,
      secondary.dataQualityScore
    );

    // 5. Transfer all relations from secondary to primary
    // Handle contactStates: if both have state for same objective, keep primary's
    const [primaryStates, secondaryStates] = await Promise.all([
      tx.contactState.findMany({ where: { contactId: primaryId }, select: { objectiveId: true } }),
      tx.contactState.findMany({ where: { contactId: secondaryId }, select: { id: true, objectiveId: true } }),
    ]);

    const primaryObjectiveIds = new Set(primaryStates.map((s) => s.objectiveId));
    const statesToTransfer = secondaryStates.filter((s) => !primaryObjectiveIds.has(s.objectiveId));
    const statesToDelete = secondaryStates.filter((s) => primaryObjectiveIds.has(s.objectiveId));

    // Transfer non-conflicting contact states
    let contactStatesTransferred = 0;
    if (statesToTransfer.length > 0) {
      const result = await tx.contactState.updateMany({
        where: { id: { in: statesToTransfer.map((s) => s.id) } },
        data: { contactId: primaryId },
      });
      contactStatesTransferred = result.count;
    }

    // Delete conflicting contact states (primary wins)
    if (statesToDelete.length > 0) {
      await tx.contactState.deleteMany({
        where: { id: { in: statesToDelete.map((s) => s.id) } },
      });
    }

    // Transfer decisions
    const decisionsResult = await tx.decision.updateMany({
      where: { contactId: secondaryId, tenantId },
      data: { contactId: primaryId },
    });

    // Transfer outcomes
    const outcomesResult = await tx.outcome.updateMany({
      where: { contactId: secondaryId, tenantId },
      data: { contactId: primaryId },
    });

    // Transfer actions
    const actionsResult = await tx.action.updateMany({
      where: { contactId: secondaryId, tenantId },
      data: { contactId: primaryId },
    });

    // Transfer pipeline cards
    const pipelineCardsResult = await tx.pipelineCard.updateMany({
      where: { contactId: secondaryId },
      data: { contactId: primaryId },
    });

    // Transfer conversations
    const conversationsResult = await tx.conversation.updateMany({
      where: { contactId: secondaryId, tenantId },
      data: { contactId: primaryId },
    });

    // Transfer escalations
    const escalationsResult = await tx.escalation.updateMany({
      where: { contactId: secondaryId, tenantId },
      data: { contactId: primaryId },
    });

    // Handle customer record (one-to-one — only transfer if primary doesn't have one)
    let customerTransferred = false;
    const [primaryCustomer, secondaryCustomer] = await Promise.all([
      tx.customer.findUnique({ where: { contactId: primaryId } }),
      tx.customer.findUnique({ where: { contactId: secondaryId } }),
    ]);

    if (secondaryCustomer && !primaryCustomer) {
      await tx.customer.update({
        where: { contactId: secondaryId },
        data: { contactId: primaryId },
      });
      customerTransferred = true;
    } else if (secondaryCustomer && primaryCustomer) {
      // Both are customers — keep primary's record, delete secondary's
      await tx.customer.delete({ where: { contactId: secondaryId } });
    }

    // 6. Update primary contact with merged fields
    const mergedContact = await tx.contact.update({
      where: { id: primaryId },
      data: mergedFields,
    });

    // 7. Archive the secondary contact
    await tx.contact.update({
      where: { id: secondaryId },
      data: {
        lifecycleStage: 'archived',
        externalIds: {
          ...(secondary.externalIds as Record<string, string>),
          _mergedInto: primaryId,
          _mergedAt: new Date().toISOString(),
        },
      },
    });

    // 8. Write audit log entry
    await tx.auditLog.create({
      data: {
        tenantId,
        actor: 'system:identity-resolver',
        actionType: 'contact.merged',
        payload: {
          primaryContactId: primaryId,
          secondaryContactId: secondaryId,
          fieldOverrides,
          relationsTransferred: {
            contactStates: contactStatesTransferred,
            decisions: decisionsResult.count,
            outcomes: outcomesResult.count,
            actions: actionsResult.count,
            pipelineCards: pipelineCardsResult.count,
            conversations: conversationsResult.count,
            escalations: escalationsResult.count,
            customer: customerTransferred,
          },
        },
        reasoning: `Merged contact ${secondaryId} into ${primaryId}. Relations transferred to primary; secondary archived.`,
      },
    });

    return {
      mergedContact,
      relationsTransferred: {
        contactStates: contactStatesTransferred,
        decisions: decisionsResult.count,
        outcomes: outcomesResult.count,
        actions: actionsResult.count,
        pipelineCards: pipelineCardsResult.count,
        conversations: conversationsResult.count,
        escalations: escalationsResult.count,
        customer: customerTransferred,
      },
      secondaryArchived: true,
    };
  });
}

// —— GET /api/contacts/:id/duplicates — Find duplicate candidates ——

router.get('/:id/duplicates', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    // Load the source contact
    const contact = await prisma.contact.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        email: true,
        phone: true,
        externalIds: true,
      },
    });

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const matches = await findMatches(
      tenantId,
      {
        email: contact.email,
        phone: contact.phone,
        externalIds: (contact.externalIds as Record<string, string>) || {},
      },
      contact.id // exclude self
    );

    return res.status(200).json({
      data: {
        sourceContactId: contact.id,
        duplicates: matches,
        count: matches.length,
      },
    });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('GET /api/contacts/:id/duplicates error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— POST /api/contacts/merge — Merge two contacts ———————

router.post('/merge', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = MergeContactsSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { primaryContactId, secondaryContactId, fieldOverrides } = parsed.data;

    const result = await mergeContacts(tenantId, primaryContactId, secondaryContactId, fieldOverrides);

    return res.status(200).json({ data: result });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    if (
      err.message === 'Primary contact not found' ||
      err.message === 'Secondary contact not found'
    ) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === 'Cannot merge a contact with itself') {
      return res.status(400).json({ error: err.message });
    }
    console.error('POST /api/contacts/merge error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— POST /api/contacts/resolve — Find-or-create with dedup ——

router.post('/resolve', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = ResolveContactSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const data = parsed.data;

    // Step 1: Find existing matches
    const matches = await findMatches(tenantId, {
      email: data.email,
      phone: data.phone,
      externalIds: data.externalIds,
    });

    // Step 2: If high-confidence match exists, return it (and enrich if needed)
    if (matches.length > 0 && matches[0].confidence >= 50) {
      const bestMatch = matches[0];

      // Enrich: fill in null fields on the existing contact
      const updateFields: Record<string, any> = {};
      const existing = bestMatch.contact;

      if (!existing.firstName && data.firstName) updateFields.firstName = data.firstName;
      if (!existing.lastName && data.lastName) updateFields.lastName = data.lastName;
      if (!existing.email && data.email) updateFields.email = data.email;
      if (!existing.phone && data.phone) updateFields.phone = data.phone;
      if (!existing.segment && data.segment) updateFields.segment = data.segment;

      // Merge externalIds
      if (data.externalIds && Object.keys(data.externalIds).length > 0) {
        const existingContact = await prisma.contact.findUnique({
          where: { id: bestMatch.contactId },
          select: { externalIds: true },
        });
        const existingExtIds = (existingContact?.externalIds as Record<string, string>) || {};
        const mergedExtIds = { ...existingExtIds };
        let hasNewKeys = false;
        for (const [key, value] of Object.entries(data.externalIds)) {
          if (!mergedExtIds[key]) {
            mergedExtIds[key] = value;
            hasNewKeys = true;
          }
        }
        if (hasNewKeys) updateFields.externalIds = mergedExtIds;
      }

      let enrichedContact;
      if (Object.keys(updateFields).length > 0) {
        enrichedContact = await prisma.contact.update({
          where: { id: bestMatch.contactId },
          data: updateFields,
        });
      } else {
        enrichedContact = await prisma.contact.findUnique({
          where: { id: bestMatch.contactId },
        });
      }

      return res.status(200).json({
        data: {
          action: 'matched',
          contact: enrichedContact,
          matchedOn: bestMatch.matchedOn,
          confidence: bestMatch.confidence,
          enriched: Object.keys(updateFields).length > 0,
          enrichedFields: Object.keys(updateFields),
        },
      });
    }

    // Step 3: No match — create new contact
    const newContact = await prisma.contact.create({
      data: {
        tenantId,
        email: data.email ?? null,
        phone: data.phone ?? null,
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        externalIds: data.externalIds || {},
        segment: data.segment ?? null,
        lifecycleStage: 'new',
        source: data.source,
        dataQualityScore: 0,
      },
    });

    return res.status(201).json({
      data: {
        action: 'created',
        contact: newContact,
        matchedOn: [],
        confidence: 0,
        enriched: false,
        enrichedFields: [],
      },
    });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('POST /api/contacts/resolve error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— Export matching engine for use by other services ————

export { findMatches, mergeContacts };
export type { MatchResult, MergeResult };
export default router;
