/**
 * Data Quality Scoring Gate
 * KAN-23: Score contact data quality (0-100), gate downstream processing
 *
 * Subtasks:
 *   KAN-115 — Scoring algorithm (field completeness + consistency)
 *   KAN-116 — Quality gate for Brain updates
 *   KAN-117 — Data quality dashboard endpoint
 *
 * Routes:
 *   POST   /api/contacts/:id/score        - Recalculate quality score for a contact
 *   POST   /api/contacts/score/batch       - Batch score multiple contacts
 *   GET    /api/data-quality/dashboard     - Quality metrics dashboard
 *   GET    /api/data-quality/flagged       - Contacts below quality threshold
 *   PATCH  /api/data-quality/threshold     - Update tenant quality threshold
 */

import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();

// —— Constants ——————————————————————————————————————————

const DEFAULT_QUALITY_THRESHOLD = 40; // Contacts below this are flagged, not acted on

// —— Validation Schemas ——————————————————————————————————

const BatchScoreSchema = z.object({
  contactIds: z
    .array(z.string().uuid())
    .min(1, 'At least one contact ID required')
    .max(500, 'Maximum 500 contacts per batch'),
});

const UpdateThresholdSchema = z.object({
  threshold: z
    .number()
    .int()
    .min(0, 'Threshold must be 0-100')
    .max(100, 'Threshold must be 0-100'),
});

const FlaggedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
});

// —— Helper: extract tenant context ——————————————————————

function getTenantId(req: Request): string {
  const tenantId = (req as any).tenantId || req.headers['x-tenant-id'];
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('Missing tenant context');
  }
  return tenantId;
}

// —— Core: Data Quality Scoring Algorithm (KAN-115) ——————

interface ScoreBreakdown {
  totalScore: number;
  fieldScores: Record<string, number>;
  penalties: { reason: string; points: number }[];
  suggestions: string[];
}

/**
 * Score a contact's data quality on a 0-100 scale.
 *
 * Scoring dimensions:
 *   1. Field completeness (0-60 points)
 *      - email:      15 pts (primary identifier)
 *      - phone:      12 pts (secondary identifier)
 *      - firstName:  10 pts
 *      - lastName:   10 pts
 *      - segment:     5 pts
 *      - source:      5 pts
 *      - externalIds: 3 pts (at least one)
 *
 *   2. Field validity (0-25 points)
 *      - email format valid:    8 pts
 *      - phone format valid:    7 pts
 *      - name not placeholder:  5 pts
 *      - lifecycle not 'new':   5 pts (shows progression)
 *
 *   3. Consistency bonuses (0-15 points)
 *      - has both email+phone:  8 pts (cross-channel reachable)
 *      - has external ID:       4 pts (linked to source system)
 *      - has segment assigned:  3 pts (classified)
 *
 *   Penalties:
 *      - Disposable email domain: -10 pts
 *      - Placeholder name:        -5 pts
 *      - Missing both identifiers: -20 pts (should never happen with validation)
 */
function calculateQualityScore(contact: {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  segment: string | null;
  source: string | null;
  lifecycleStage: string;
  externalIds: Record<string, string> | any;
}): ScoreBreakdown {
  const fieldScores: Record<string, number> = {};
  const penalties: { reason: string; points: number }[] = [];
  const suggestions: string[] = [];
  let total = 0;

  // —— 1. Field Completeness (max 60) ——
  if (contact.email) {
    fieldScores.email = 15;
    total += 15;
  } else {
    fieldScores.email = 0;
    suggestions.push('Add email address for primary reachability');
  }

  if (contact.phone) {
    fieldScores.phone = 12;
    total += 12;
  } else {
    fieldScores.phone = 0;
    suggestions.push('Add phone number for SMS/WhatsApp channel');
  }

  if (contact.firstName) {
    fieldScores.firstName = 10;
    total += 10;
  } else {
    fieldScores.firstName = 0;
    suggestions.push('Add first name for personalized messaging');
  }

  if (contact.lastName) {
    fieldScores.lastName = 10;
    total += 10;
  } else {
    fieldScores.lastName = 0;
    suggestions.push('Add last name');
  }

  if (contact.segment) {
    fieldScores.segment = 5;
    total += 5;
  } else {
    fieldScores.segment = 0;
    suggestions.push('Assign a segment for targeted strategies');
  }

  if (contact.source) {
    fieldScores.source = 5;
    total += 5;
  } else {
    fieldScores.source = 0;
  }

  const extIds = (contact.externalIds as Record<string, string>) || {};
  const extIdCount = Object.keys(extIds).filter((k) => !k.startsWith('_')).length;
  if (extIdCount > 0) {
    fieldScores.externalIds = 3;
    total += 3;
  } else {
    fieldScores.externalIds = 0;
  }

  // —— 2. Field Validity (max 25) ——
  if (contact.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(contact.email)) {
      fieldScores.emailValid = 8;
      total += 8;
    } else {
      fieldScores.emailValid = 0;
      suggestions.push('Email format appears invalid');
    }
  }

  if (contact.phone) {
    const digitsOnly = contact.phone.replace(/\D/g, '');
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      fieldScores.phoneValid = 7;
      total += 7;
    } else {
      fieldScores.phoneValid = 0;
      suggestions.push('Phone number format appears invalid');
    }
  }

  // Check for placeholder names
  const placeholderPatterns = /^(test|unknown|n\/a|none|na|tbd|xxx|sample|demo|fake)/i;
  const nameIsPlaceholder =
    (contact.firstName && placeholderPatterns.test(contact.firstName)) ||
    (contact.lastName && placeholderPatterns.test(contact.lastName));

  if (contact.firstName && contact.lastName && !nameIsPlaceholder) {
    fieldScores.nameQuality = 5;
    total += 5;
  } else {
    fieldScores.nameQuality = 0;
  }

  // Lifecycle progression
  if (contact.lifecycleStage && contact.lifecycleStage !== 'new') {
    fieldScores.lifecycleProgression = 5;
    total += 5;
  } else {
    fieldScores.lifecycleProgression = 0;
  }

  // —— 3. Consistency Bonuses (max 15) ——
  if (contact.email && contact.phone) {
    fieldScores.crossChannel = 8;
    total += 8;
  } else {
    fieldScores.crossChannel = 0;
  }

  if (extIdCount > 0) {
    fieldScores.linkedSystem = 4;
    total += 4;
  } else {
    fieldScores.linkedSystem = 0;
  }

  if (contact.segment) {
    fieldScores.classified = 3;
    total += 3;
  } else {
    fieldScores.classified = 0;
  }

  // —— Penalties ——
  if (contact.email) {
    const disposableDomains = [
      'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
      'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
      'dispostable.com', 'trashmail.com', 'temp-mail.org', '10minutemail.com',
    ];
    const domain = contact.email.split('@')[1]?.toLowerCase();
    if (domain && disposableDomains.includes(domain)) {
      penalties.push({ reason: 'Disposable email domain', points: -10 });
      total -= 10;
      suggestions.push('Contact uses a disposable email — may not be reachable');
    }
  }

  if (nameIsPlaceholder) {
    penalties.push({ reason: 'Placeholder name detected', points: -5 });
    total -= 5;
    suggestions.push('Name appears to be a placeholder — update with real name');
  }

  if (!contact.email && !contact.phone) {
    penalties.push({ reason: 'No contact identifiers', points: -20 });
    total -= 20;
    suggestions.push('No email or phone — contact is unreachable');
  }

  return {
    totalScore: Math.max(0, Math.min(100, total)),
    fieldScores,
    penalties,
    suggestions,
  };
}

// —— Core: Quality Gate (KAN-116) ————————————————————————

interface QualityGateResult {
  passed: boolean;
  score: number;
  threshold: number;
  action: 'proceed' | 'flag' | 'block';
  reason: string;
}

/**
 * Evaluate whether a contact passes the quality gate for downstream processing.
 *
 * Actions:
 *   - score >= threshold:      "proceed" — allow Brain update + Decision Engine
 *   - score >= threshold - 15: "flag"    — allow processing but flag for review
 *   - score < threshold - 15:  "block"   — do not process; queue for enrichment
 */
async function evaluateQualityGate(
  tenantId: string,
  contactId: string
): Promise<QualityGateResult> {
  // Get tenant threshold (from tenant config, default to 40)
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { aiPermissions: true, confidenceThreshold: true },
  });

  const threshold =
    (tenant?.aiPermissions as any)?.dataQualityThreshold ?? DEFAULT_QUALITY_THRESHOLD;

  // Get the contact
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: {
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      segment: true,
      source: true,
      lifecycleStage: true,
      externalIds: true,
      dataQualityScore: true,
    },
  });

  if (!contact) {
    return {
      passed: false,
      score: 0,
      threshold,
      action: 'block',
      reason: 'Contact not found',
    };
  }

  const score = contact.dataQualityScore;

  if (score >= threshold) {
    return {
      passed: true,
      score,
      threshold,
      action: 'proceed',
      reason: 'Score meets quality threshold',
    };
  }

  if (score >= threshold - 15) {
    return {
      passed: true,
      score,
      threshold,
      action: 'flag',
      reason: `Score (${score}) is below threshold (${threshold}) but within review range`,
    };
  }

  return {
    passed: false,
    score,
    threshold,
    action: 'block',
    reason: `Score (${score}) is significantly below threshold (${threshold})`,
  };
}

// —— POST /api/contacts/:id/score — Recalculate quality score ——

router.post('/:id/score', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const contact = await prisma.contact.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        segment: true,
        source: true,
        lifecycleStage: true,
        externalIds: true,
        dataQualityScore: true,
      },
    });

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const breakdown = calculateQualityScore(contact);

    // Update the contact's score
    await prisma.contact.update({
      where: { id },
      data: { dataQualityScore: breakdown.totalScore },
    });

    // Evaluate quality gate
    const gate = await evaluateQualityGate(tenantId, id);

    return res.status(200).json({
      data: {
        contactId: id,
        previousScore: contact.dataQualityScore,
        newScore: breakdown.totalScore,
        breakdown,
        gate,
      },
    });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('POST /api/contacts/:id/score error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— POST /api/contacts/score/batch — Batch score contacts ——

router.post('/score/batch', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = BatchScoreSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { contactIds } = parsed.data;

    const contacts = await prisma.contact.findMany({
      where: { id: { in: contactIds }, tenantId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        segment: true,
        source: true,
        lifecycleStage: true,
        externalIds: true,
        dataQualityScore: true,
      },
    });

    const results: {
      contactId: string;
      previousScore: number;
      newScore: number;
      gate: string;
    }[] = [];

    // Process in transaction
    await prisma.$transaction(async (tx) => {
      for (const contact of contacts) {
        const breakdown = calculateQualityScore(contact);

        await tx.contact.update({
          where: { id: contact.id },
          data: { dataQualityScore: breakdown.totalScore },
        });

        results.push({
          contactId: contact.id,
          previousScore: contact.dataQualityScore,
          newScore: breakdown.totalScore,
          gate:
            breakdown.totalScore >= DEFAULT_QUALITY_THRESHOLD
              ? 'proceed'
              : breakdown.totalScore >= DEFAULT_QUALITY_THRESHOLD - 15
                ? 'flag'
                : 'block',
        });
      }
    });

    const scored = results.length;
    const notFound = contactIds.length - scored;

    return res.status(200).json({
      data: {
        scored,
        notFound,
        averageScore: scored > 0
          ? Math.round(results.reduce((sum, r) => sum + r.newScore, 0) / scored)
          : 0,
        results,
      },
    });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('POST /api/contacts/score/batch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— GET /api/data-quality/dashboard — Quality metrics (KAN-117) ——

router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    // Get tenant threshold
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { aiPermissions: true },
    });
    const threshold =
      (tenant?.aiPermissions as any)?.dataQualityThreshold ?? DEFAULT_QUALITY_THRESHOLD;

    // Aggregate stats in parallel
    const [
      totalContacts,
      avgScore,
      belowThreshold,
      scoreDistribution,
      sourceBreakdown,
    ] = await Promise.all([
      // Total active contacts
      prisma.contact.count({
        where: { tenantId, lifecycleStage: { not: 'archived' } },
      }),

      // Average score
      prisma.contact.aggregate({
        where: { tenantId, lifecycleStage: { not: 'archived' } },
        _avg: { dataQualityScore: true },
      }),

      // Below threshold count
      prisma.contact.count({
        where: {
          tenantId,
          lifecycleStage: { not: 'archived' },
          dataQualityScore: { lt: threshold },
        },
      }),

      // Score distribution (buckets: 0-20, 21-40, 41-60, 61-80, 81-100)
      prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
        `SELECT
          CASE
            WHEN "dataQualityScore" <= 20 THEN 'critical'
            WHEN "dataQualityScore" <= 40 THEN 'poor'
            WHEN "dataQualityScore" <= 60 THEN 'fair'
            WHEN "dataQualityScore" <= 80 THEN 'good'
            ELSE 'excellent'
          END as bucket,
          COUNT(*) as count
        FROM contacts
        WHERE "tenantId" = $1 AND "lifecycleStage" != 'archived'
        GROUP BY bucket
        ORDER BY MIN("dataQualityScore")`,
        tenantId
      ),

      // Quality by source
      prisma.$queryRawUnsafe<{ source: string; avg_score: number; count: bigint }[]>(
        `SELECT
          COALESCE(source, 'unknown') as source,
          ROUND(AVG("dataQualityScore")::numeric, 1) as avg_score,
          COUNT(*) as count
        FROM contacts
        WHERE "tenantId" = $1 AND "lifecycleStage" != 'archived'
        GROUP BY source
        ORDER BY avg_score DESC`,
        tenantId
      ),
    ]);

    return res.status(200).json({
      data: {
        threshold,
        totalContacts,
        averageScore: Math.round(avgScore._avg.dataQualityScore ?? 0),
        belowThreshold,
        aboveThreshold: totalContacts - belowThreshold,
        passRate:
          totalContacts > 0
            ? Math.round(((totalContacts - belowThreshold) / totalContacts) * 100)
            : 0,
        scoreDistribution: scoreDistribution.map((d) => ({
          bucket: d.bucket,
          count: Number(d.count),
        })),
        bySource: sourceBreakdown.map((s) => ({
          source: s.source,
          averageScore: Number(s.avg_score),
          count: Number(s.count),
        })),
      },
    });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('GET /api/data-quality/dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— GET /api/data-quality/flagged — Contacts below threshold ——

router.get('/flagged', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = FlaggedQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, maxScore } = parsed.data;
    const skip = (page - 1) * limit;

    // Get tenant threshold
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { aiPermissions: true },
    });
    const threshold =
      (tenant?.aiPermissions as any)?.dataQualityThreshold ?? DEFAULT_QUALITY_THRESHOLD;

    const scoreLimit = maxScore ?? threshold;

    const where: Prisma.ContactWhereInput = {
      tenantId,
      lifecycleStage: { not: 'archived' },
      dataQualityScore: { lt: scoreLimit },
    };

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        skip,
        take: limit,
        orderBy: { dataQualityScore: 'asc' },
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          segment: true,
          source: true,
          lifecycleStage: true,
          dataQualityScore: true,
          createdAt: true,
        },
      }),
      prisma.contact.count({ where }),
    ]);

    // Add suggestions for each flagged contact
    const contactsWithSuggestions = contacts.map((c) => {
      const breakdown = calculateQualityScore({
        ...c,
        externalIds: {},
      });
      return {
        ...c,
        suggestions: breakdown.suggestions,
        gateAction:
          c.dataQualityScore >= threshold
            ? 'proceed'
            : c.dataQualityScore >= threshold - 15
              ? 'flag'
              : 'block',
      };
    });

    return res.status(200).json({
      data: contactsWithSuggestions,
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
    console.error('GET /api/data-quality/flagged error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— PATCH /api/data-quality/threshold — Update quality threshold ——

router.patch('/threshold', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = UpdateThresholdSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { threshold } = parsed.data;

    // Update tenant's aiPermissions with new threshold
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { aiPermissions: true },
    });

    const currentPermissions = (tenant?.aiPermissions as Record<string, any>) || {};
    const updatedPermissions = {
      ...currentPermissions,
      dataQualityThreshold: threshold,
    };

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { aiPermissions: updatedPermissions },
    });

    // Count impact
    const [belowNew, belowOld] = await Promise.all([
      prisma.contact.count({
        where: {
          tenantId,
          lifecycleStage: { not: 'archived' },
          dataQualityScore: { lt: threshold },
        },
      }),
      prisma.contact.count({
        where: {
          tenantId,
          lifecycleStage: { not: 'archived' },
          dataQualityScore: { lt: currentPermissions.dataQualityThreshold ?? DEFAULT_QUALITY_THRESHOLD },
        },
      }),
    ]);

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'user',
        actionType: 'data_quality.threshold_updated',
        payload: {
          previousThreshold: currentPermissions.dataQualityThreshold ?? DEFAULT_QUALITY_THRESHOLD,
          newThreshold: threshold,
          contactsNewlyBlocked: Math.max(0, belowNew - belowOld),
          contactsNewlyUnblocked: Math.max(0, belowOld - belowNew),
        },
        reasoning: `Quality threshold updated from ${currentPermissions.dataQualityThreshold ?? DEFAULT_QUALITY_THRESHOLD} to ${threshold}`,
      },
    });

    return res.status(200).json({
      data: {
        previousThreshold: currentPermissions.dataQualityThreshold ?? DEFAULT_QUALITY_THRESHOLD,
        newThreshold: threshold,
        contactsBelowThreshold: belowNew,
      },
    });
  } catch (err: any) {
    if (err.message === 'Missing tenant context') {
      return res.status(401).json({ error: err.message });
    }
    console.error('PATCH /api/data-quality/threshold error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// —— Exports for use by other services ———————————————————

export { calculateQualityScore, evaluateQualityGate };
export type { ScoreBreakdown, QualityGateResult };
export default router;
