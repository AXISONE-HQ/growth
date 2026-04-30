/**
 * CSV Import Service with AI Field Mapping
 * KAN-21: Build CSV import with AI field mapping
 *
 * Subtasks:
 *   KAN-108 — Build CSV upload endpoint with file validation
 *   KAN-109 — Implement Haiku-powered field mapping
 *   KAN-110 — Build mapping preview and confirmation API
 *   KAN-111 — Process confirmed CSV rows into contacts table
 *
 * Flow:
 *   1. Upload CSV → validate → parse headers + sample rows
 *   2. Send headers + sample to Haiku → get column-to-schema mapping
 *   3. Return preview (mapped fields, sample data, confidence)
 *   4. User confirms/adjusts mapping → bulk insert contacts
 *
 * Integration points:
 *   - GCS for file storage
 *   - Anthropic Haiku for AI field mapping
 *   - contacts.ts for contact creation
 *   - data-quality.ts for scoring
 *   - pubsub-events.ts for contact.ingested events
 */

import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'crypto';
import { parse } from 'csv-parse/sync';
import {
  UNIFIED_SCHEMA_FIELDS,
  runHaikuFieldMapping,
  runFallbackMapping,
  type FieldMapping,
  type UnifiedField,
} from './csv-import-haiku-mapping.js';

const router = Router();
const prisma = new PrismaClient();
const storage = new Storage();

const BUCKET_NAME = process.env.GCS_IMPORT_BUCKET || 'growth-csv-imports';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROWS = 50_000;
const SAMPLE_SIZE = 5; // Rows sent to Haiku for mapping inference

// —— Zod Schemas ——————————————————————————————————————

const UploadQuerySchema = z.object({
  tenantId: z.string().uuid(),
});

const ConfirmMappingSchema = z.object({
  tenantId: z.string().uuid(),
  importJobId: z.string().uuid(),
  mappings: z.array(
    z.object({
      csvColumn: z.string(),
      targetField: z.string(),
      confirmed: z.boolean().default(true),
    })
  ),
});

const ImportJobStatusSchema = z.object({
  tenantId: z.string().uuid(),
  importJobId: z.string().uuid(),
});

// —— Type Definitions ————————————————————————————————

interface ImportJob {
  id: string;
  tenantId: string;
  fileName: string;
  gcsPath: string;
  status: 'uploaded' | 'mapping' | 'preview_ready' | 'confirmed' | 'processing' | 'completed' | 'failed';
  totalRows: number;
  headers: string[];
  sampleRows: Record<string, string>[];
  mappings: FieldMapping[];
  processedRows?: number;
  createdRows?: number;
  updatedRows?: number;
  skippedRows?: number;
  errors?: string[];
  createdAt: Date;
  updatedAt: Date;
}

// —— KAN-108: CSV Upload Endpoint with File Validation ————

/**
 * POST /csv/upload
 * Upload a CSV file for import. Validates file type, size, and structure.
 * Returns import job ID and parsed preview.
 *
 * Expects multipart/form-data with field "file".
 * Query: ?tenantId=<uuid>
 */
router.post('/csv/upload', async (req: Request, res: Response) => {
  try {
    const { tenantId } = UploadQuerySchema.parse(req.query);

    // Verify tenant exists
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Validate file presence
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({
        error: 'No file uploaded. Send a CSV file in the "file" field.',
      });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return res.status(400).json({
        error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
        maxSize: MAX_FILE_SIZE,
        actualSize: file.size,
      });
    }

    // Validate file type
    const allowedMimeTypes = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
    const fileName: string = file.originalname || 'upload.csv';
    if (!allowedMimeTypes.includes(file.mimetype) && !fileName.endsWith('.csv')) {
      return res.status(400).json({
        error: 'Invalid file type. Please upload a CSV file.',
        receivedType: file.mimetype,
      });
    }

    // Parse CSV to validate structure
    const csvContent = file.buffer.toString('utf-8');
    let records: Record<string, string>[];
    let headers: string[];

    try {
      records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        cast: false,
      });

      if (records.length === 0) {
        return res.status(400).json({ error: 'CSV file is empty or has no data rows.' });
      }

      headers = Object.keys(records[0]);

      if (headers.length === 0) {
        return res.status(400).json({ error: 'CSV file has no columns.' });
      }

      if (headers.length > 50) {
        return res.status(400).json({
          error: 'CSV file has too many columns. Maximum is 50.',
          columnCount: headers.length,
        });
      }

      if (records.length > MAX_ROWS) {
        return res.status(400).json({
          error: `CSV file has too many rows. Maximum is ${MAX_ROWS.toLocaleString()}.`,
          rowCount: records.length,
        });
      }
    } catch (parseError: any) {
      return res.status(400).json({
        error: 'Failed to parse CSV file. Ensure it is valid CSV format.',
        details: parseError.message,
      });
    }

    // Upload to GCS for persistence
    const importJobId = randomUUID();
    const gcsPath = `imports/${tenantId}/${importJobId}/${fileName}`;

    const bucket = storage.bucket(BUCKET_NAME);
    const blob = bucket.file(gcsPath);
    await blob.save(file.buffer, {
      contentType: 'text/csv',
      metadata: {
        tenantId,
        importJobId,
        originalName: fileName,
        rowCount: String(records.length),
      },
    });

    // Extract sample rows for AI mapping
    const sampleRows = records.slice(0, SAMPLE_SIZE);

    // Create import job record
    const importJob = await prisma.importJob.create({
      data: {
        id: importJobId,
        tenantId,
        fileName,
        gcsPath,
        status: 'uploaded',
        totalRows: records.length,
        headers,
        sampleRows: sampleRows as any,
        mappings: [],
      },
    });

    // Trigger AI field mapping (async — status becomes 'mapping')
    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: 'mapping' },
    });

    // Run AI mapping (KAN-734: routed through llm-client → llm.call cost event with tenantId)
    const mappings = await runHaikuFieldMapping(headers, sampleRows, tenantId);

    // Update job with mappings
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: 'preview_ready',
        mappings: mappings as any,
      },
    });

    // Log to audit
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'system',
        actionType: 'csv.uploaded',
        payload: {
          importJobId,
          fileName,
          rowCount: records.length,
          columnCount: headers.length,
          headers,
        },
        reasoning: `CSV file "${fileName}" uploaded with ${records.length} rows and ${headers.length} columns`,
      },
    });

    return res.status(200).json({
      importJobId,
      fileName,
      totalRows: records.length,
      headers,
      sampleRows,
      mappings,
      status: 'preview_ready',
    });
  } catch (error: any) {
    console.error('CSV upload error:', error);
    return res.status(500).json({ error: 'Failed to process CSV upload', details: error.message });
  }
});

// —— KAN-109 / KAN-734: Haiku-powered field mapping moved to csv-import-haiku-mapping.ts ——
// runHaikuFieldMapping + runFallbackMapping + UNIFIED_SCHEMA_FIELDS imported above.
// Re-exports retained at the bottom of this file for back-compat.

// —— KAN-110: Mapping Preview and Confirmation API ————

/**
 * GET /csv/preview/:importJobId
 * Get the current mapping preview for an import job.
 */
router.get('/csv/preview/:importJobId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const { importJobId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const job = await prisma.importJob.findFirst({
      where: { id: importJobId, tenantId },
    });

    if (!job) {
      return res.status(404).json({ error: 'Import job not found' });
    }

    return res.json({
      importJobId: job.id,
      fileName: job.fileName,
      status: job.status,
      totalRows: job.totalRows,
      headers: job.headers,
      sampleRows: job.sampleRows,
      mappings: job.mappings,
      availableFields: UNIFIED_SCHEMA_FIELDS,
    });
  } catch (error: any) {
    console.error('Preview error:', error);
    return res.status(500).json({ error: 'Failed to get preview', details: error.message });
  }
});

/**
 * POST /csv/confirm
 * User confirms (or adjusts) field mappings and triggers row processing.
 */
router.post('/csv/confirm', async (req: Request, res: Response) => {
  try {
    const { tenantId, importJobId, mappings } = ConfirmMappingSchema.parse(req.body);

    const job = await prisma.importJob.findFirst({
      where: { id: importJobId, tenantId },
    });

    if (!job) {
      return res.status(404).json({ error: 'Import job not found' });
    }

    if (job.status !== 'preview_ready') {
      return res.status(400).json({
        error: `Import job is not ready for confirmation. Current status: ${job.status}`,
      });
    }

    // Validate that at least one field is mapped (not _skip)
    const activeMappings = mappings.filter((m) => m.targetField !== '_skip' && m.confirmed);
    if (activeMappings.length === 0) {
      return res.status(400).json({
        error: 'At least one column must be mapped to a schema field.',
      });
    }

    // Must have email or phone mapped for identity
    const hasIdentifier = activeMappings.some(
      (m) => m.targetField === 'email' || m.targetField === 'phone'
    );
    if (!hasIdentifier) {
      return res.status(400).json({
        error: 'At least one identifier field (email or phone) must be mapped.',
      });
    }

    // Update job with confirmed mappings
    const confirmedMappings = mappings.map((m) => ({
      ...m,
      confirmed: m.confirmed ?? true,
    }));

    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: 'confirmed',
        mappings: confirmedMappings as any,
      },
    });

    // Process rows (kick off async — in production this would be a Cloud Task)
    // For MVP, process inline with progress tracking
    processImportJob(importJobId, tenantId, confirmedMappings).catch((err) => {
      console.error(`Import job ${importJobId} failed:`, err);
    });

    return res.json({
      importJobId,
      status: 'processing',
      message: 'Import confirmed. Processing rows...',
      totalRows: job.totalRows,
      activeMappings: activeMappings.length,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Confirm error:', error);
    return res.status(500).json({ error: 'Failed to confirm mapping', details: error.message });
  }
});

/**
 * GET /csv/status/:importJobId
 * Get the current status and progress of an import job.
 */
router.get('/csv/status/:importJobId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const { importJobId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const job = await prisma.importJob.findFirst({
      where: { id: importJobId, tenantId },
    });

    if (!job) {
      return res.status(404).json({ error: 'Import job not found' });
    }

    return res.json({
      importJobId: job.id,
      status: job.status,
      totalRows: job.totalRows,
      processedRows: (job as any).processedRows || 0,
      createdRows: (job as any).createdRows || 0,
      updatedRows: (job as any).updatedRows || 0,
      skippedRows: (job as any).skippedRows || 0,
      errors: (job as any).errors || [],
    });
  } catch (error: any) {
    console.error('Status error:', error);
    return res.status(500).json({ error: 'Failed to get status', details: error.message });
  }
});

// —— KAN-111: Process Confirmed CSV Rows into Contacts ————

/**
 * Process all rows from a confirmed import job.
 * Downloads CSV from GCS, applies confirmed mappings, creates/updates contacts.
 */
async function processImportJob(
  importJobId: string,
  tenantId: string,
  mappings: Array<{ csvColumn: string; targetField: string; confirmed: boolean }>
): Promise<void> {
  const activeMappings = mappings.filter((m) => m.targetField !== '_skip' && m.confirmed);

  let processedRows = 0;
  let createdRows = 0;
  let updatedRows = 0;
  let skippedRows = 0;
  const errors: string[] = [];

  try {
    // Update status to processing
    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: 'processing' },
    });

    // Download CSV from GCS
    const job = await prisma.importJob.findUnique({ where: { id: importJobId } });
    if (!job) throw new Error('Import job not found');

    const bucket = storage.bucket(BUCKET_NAME);
    const [csvBuffer] = await bucket.file(job.gcsPath).download();
    const csvContent = csvBuffer.toString('utf-8');

    // Parse all rows
    const records: Record<string, string>[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      cast: false,
    });

    // Process in batches of 100
    const BATCH_SIZE = 100;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);

      for (const row of batch) {
        try {
          const result = await processRow(row, activeMappings, tenantId, importJobId);
          processedRows++;

          if (result === 'created') createdRows++;
          else if (result === 'updated') updatedRows++;
          else if (result === 'skipped') skippedRows++;
        } catch (rowError: any) {
          processedRows++;
          skippedRows++;
          errors.push(`Row ${processedRows}: ${rowError.message}`);
          // Cap error log at 100
          if (errors.length > 100) {
            errors.push('... (error limit reached, additional errors truncated)');
            break;
          }
        }
      }

      // Update progress periodically
      await prisma.importJob.update({
        where: { id: importJobId },
        data: {
          processedRows,
          createdRows,
          updatedRows,
          skippedRows,
          errors: errors.slice(0, 100),
        } as any,
      });
    }

    // Mark completed
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: 'completed',
        processedRows,
        createdRows,
        updatedRows,
        skippedRows,
        errors: errors.slice(0, 100),
      } as any,
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'system',
        actionType: 'csv.import_completed',
        payload: {
          importJobId,
          totalRows: records.length,
          processedRows,
          createdRows,
          updatedRows,
          skippedRows,
          errorCount: errors.length,
        },
        reasoning: `CSV import completed: ${createdRows} created, ${updatedRows} updated, ${skippedRows} skipped`,
      },
    });

    console.log(
      `Import ${importJobId} completed: ${createdRows} created, ${updatedRows} updated, ${skippedRows} skipped`
    );
  } catch (error: any) {
    console.error(`Import job ${importJobId} failed:`, error);

    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: 'failed',
        processedRows,
        createdRows,
        updatedRows,
        skippedRows,
        errors: [...errors, `Fatal: ${error.message}`],
      } as any,
    });
  }
}

/**
 * Process a single CSV row into a contact.
 * Maps columns → schema fields, normalizes data, upserts contact.
 */
async function processRow(
  row: Record<string, string>,
  mappings: Array<{ csvColumn: string; targetField: string }>,
  tenantId: string,
  importJobId: string
): Promise<'created' | 'updated' | 'skipped'> {
  // Apply mappings to extract contact data
  const contactData: Record<string, string> = {};
  for (const mapping of mappings) {
    const value = row[mapping.csvColumn]?.trim();
    if (value) {
      contactData[mapping.targetField] = value;
    }
  }

  // Must have at least one identifier
  const email = normalizeEmail(contactData.email);
  const phone = normalizePhone(contactData.phone);

  if (!email && !phone) {
    return 'skipped';
  }

  // Normalize lifecycle stage
  const lifecycleStage = normalizeLifecycleStage(contactData.lifecycleStage);

  // Build external IDs
  const externalIds: Record<string, string> = {};
  if (contactData.externalId) {
    externalIds[`csv_import_${importJobId.slice(0, 8)}`] = contactData.externalId;
  }

  // Check for existing contact (email match first, then phone)
  let existingContact = null;
  if (email) {
    existingContact = await prisma.contact.findFirst({
      where: { tenantId, email },
    });
  }
  if (!existingContact && phone) {
    existingContact = await prisma.contact.findFirst({
      where: { tenantId, phone },
    });
  }

  if (existingContact) {
    // Update existing contact — merge data, don't overwrite with empty
    const updateData: Record<string, any> = {};

    if (email && !existingContact.email) updateData.email = email;
    if (phone && !existingContact.phone) updateData.phone = phone;
    if (contactData.firstName && !existingContact.firstName) updateData.firstName = contactData.firstName;
    if (contactData.lastName && !existingContact.lastName) updateData.lastName = contactData.lastName;
    if (contactData.segment && !existingContact.segment) updateData.segment = contactData.segment;
    if (lifecycleStage) updateData.lifecycleStage = lifecycleStage;
    if (contactData.source && !existingContact.source) updateData.source = contactData.source;

    // Merge external IDs
    const existingExternalIds = (existingContact.externalIds as Record<string, string>) || {};
    const mergedExternalIds = { ...existingExternalIds, ...externalIds };

    // Merge metadata (company, title, location, etc.)
    const existingMeta = (existingContact.metadata as Record<string, any>) || {};
    const newMeta: Record<string, any> = { ...existingMeta };
    if (contactData.company) newMeta.company = contactData.company;
    if (contactData.title) newMeta.title = contactData.title;
    if (contactData.city) newMeta.city = contactData.city;
    if (contactData.state) newMeta.state = contactData.state;
    if (contactData.country) newMeta.country = contactData.country;
    if (contactData.postalCode) newMeta.postalCode = contactData.postalCode;
    if (contactData.website) newMeta.website = contactData.website;
    if (contactData.notes) newMeta.notes = contactData.notes;
    if (contactData.tags) newMeta.tags = contactData.tags;

    if (Object.keys(updateData).length > 0 || Object.keys(externalIds).length > 0) {
      await prisma.contact.update({
        where: { id: existingContact.id },
        data: {
          ...updateData,
          externalIds: mergedExternalIds,
          metadata: newMeta,
        },
      });
      return 'updated';
    }

    return 'skipped'; // No new data to add
  }

  // Create new contact
  await prisma.contact.create({
    data: {
      id: randomUUID(),
      tenantId,
      email: email || null,
      phone: phone || null,
      firstName: contactData.firstName || null,
      lastName: contactData.lastName || null,
      segment: contactData.segment || null,
      lifecycleStage: lifecycleStage || 'lead',
      source: contactData.source || 'csv_import',
      externalIds,
      dataQualityScore: 0, // Will be scored by data-quality service
      metadata: {
        company: contactData.company || null,
        title: contactData.title || null,
        city: contactData.city || null,
        state: contactData.state || null,
        country: contactData.country || null,
        postalCode: contactData.postalCode || null,
        website: contactData.website || null,
        notes: contactData.notes || null,
        tags: contactData.tags || null,
        importJobId,
      },
    },
  });

  return 'created';
}

// —— Normalization Helpers ————————————————————————————

function normalizeEmail(email: string | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed) ? trimmed : null;
}

function normalizePhone(phone: string | undefined): string | null {
  if (!phone) return null;
  // Strip all non-digit characters except leading +
  const cleaned = phone.trim().replace(/[^\d+]/g, '');
  // Must have at least 7 digits
  const digitCount = cleaned.replace(/\+/g, '').length;
  if (digitCount < 7 || digitCount > 15) return null;

  // Add + prefix if 10+ digits and no prefix
  if (digitCount >= 10 && !cleaned.startsWith('+')) {
    return `+${cleaned}`;
  }
  return cleaned;
}

function normalizeLifecycleStage(stage: string | undefined): string {
  if (!stage) return 'lead';
  const normalized = stage.trim().toLowerCase();

  const stageMap: Record<string, string> = {
    lead: 'lead',
    new: 'lead',
    prospect: 'prospect',
    qualified: 'prospect',
    mql: 'prospect',
    sql: 'prospect',
    opportunity: 'prospect',
    customer: 'customer',
    client: 'customer',
    active: 'customer',
    paying: 'customer',
    churned: 'churned',
    lost: 'churned',
    inactive: 'churned',
    cancelled: 'churned',
    canceled: 'churned',
  };

  return stageMap[normalized] || 'lead';
}

// —— Import History Endpoint ——————————————————————————

/**
 * GET /csv/history
 * List import jobs for a tenant.
 */
router.get('/csv/history', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [jobs, total] = await Promise.all([
      prisma.importJob.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          fileName: true,
          status: true,
          totalRows: true,
          processedRows: true,
          createdRows: true,
          updatedRows: true,
          skippedRows: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.importJob.count({ where: { tenantId } }),
    ]);

    return res.json({
      jobs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('History error:', error);
    return res.status(500).json({ error: 'Failed to get import history', details: error.message });
  }
});

// —— Exports ————————————————————————————————————————

export default router;
export { runHaikuFieldMapping, runFallbackMapping, UNIFIED_SCHEMA_FIELDS };
export type { FieldMapping, ImportJob, UnifiedField };
