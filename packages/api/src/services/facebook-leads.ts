/**
 * Facebook Lead Ads Webhook Connector
 * KAN-26: Build Facebook Lead Ads webhook connector
 *
 * Subtasks:
 * - KAN-125: Register Facebook Lead Ads webhook endpoint
 * - KAN-126: Normalize Lead Ad form data to contact schema
 * - KAN-127: Route normalized leads through ingestion pipeline
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const router = Router();
const prisma = new PrismaClient();

// ── KAN-125: Facebook Webhook Configuration ──────────────────────────────────

const FB_APP_SECRET = process.env.FB_APP_SECRET || '';
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || '';
const FB_GRAPH_API_VERSION = 'v19.0';
const FB_GRAPH_API_BASE = `https://graph.facebook.com/${FB_GRAPH_API_VERSION}`;

/**
 * Facebook Lead Ad form field → growth unified contact schema mapping.
 * Facebook forms use varying field names; this maps the most common ones.
 */
const FB_LEAD_FIELD_MAP: Record<string, string> = {
  // Standard Facebook Lead Ad fields
  email: 'email',
  phone_number: 'phone',
  full_name: 'fullName',
  first_name: 'firstName',
  last_name: 'lastName',
  company_name: 'company',
  job_title: 'title',
  city: 'city',
  state: 'state',
  country: 'country',
  zip_code: 'postalCode',
  post_code: 'postalCode',
  postal_code: 'postalCode',
  street_address: 'address',
  work_email: 'email',
  work_phone_number: 'phone',
  website: 'website',
};

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const WebhookVerifySchema = z.object({
  'hub.mode': z.literal('subscribe'),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

const LeadFieldSchema = z.object({
  name: z.string(),
  values: z.array(z.string()),
});

const LeadDataSchema = z.object({
  id: z.string(),
  created_time: z.string(),
  field_data: z.array(LeadFieldSchema).optional(),
  retailer_item_id: z.string().optional(),
});

const WebhookChangeSchema = z.object({
  field: z.string(),
  value: z.object({
    ad_id: z.string().optional(),
    adgroup_id: z.string().optional(),
    ad_name: z.string().optional(),
    campaign_id: z.string().optional(),
    campaign_name: z.string().optional(),
    form_id: z.string(),
    leadgen_id: z.string(),
    created_time: z.number(),
    page_id: z.string(),
  }),
});

const WebhookEntrySchema = z.object({
  id: z.string(),
  time: z.number(),
  changes: z.array(WebhookChangeSchema),
});

const WebhookPayloadSchema = z.object({
  object: z.literal('page'),
  entry: z.array(WebhookEntrySchema),
});

const TenantFbConfigSchema = z.object({
  tenantId: z.string().uuid(),
  pageId: z.string(),
  accessToken: z.string(),
  formMappings: z
    .array(
      z.object({
        formId: z.string(),
        objectiveId: z.string().uuid().optional(),
        customFieldMap: z.record(z.string()).optional(),
      })
    )
    .optional(),
});

// ── KAN-125: Webhook Verification Endpoint ───────────────────────────────────

/**
 * GET /facebook/webhook
 * Facebook webhook verification (hub challenge).
 * Facebook sends a GET request with hub.mode, hub.verify_token, and hub.challenge.
 * We must respond with hub.challenge if the verify_token matches.
 */
router.get('/facebook/webhook', (req: Request, res: Response) => {
  try {
    const query = WebhookVerifySchema.safeParse(req.query);

    if (!query.success) {
      return res.status(400).json({ error: 'Invalid verification request' });
    }

    const { 'hub.verify_token': verifyToken, 'hub.challenge': challenge } = query.data;

    if (verifyToken !== FB_VERIFY_TOKEN) {
      console.warn('Facebook webhook verification failed: token mismatch');
      return res.status(403).json({ error: 'Verification token mismatch' });
    }

    // Respond with the challenge to complete verification
    return res.status(200).send(challenge);
  } catch (error: any) {
    console.error('Facebook webhook verify error:', error);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// ── KAN-125: Webhook Receiver Endpoint ───────────────────────────────────────

/**
 * POST /facebook/webhook
 * Receives Facebook Lead Ads webhook events.
 * Facebook sends batched events when new leads are submitted.
 * We validate the payload, look up the tenant by page_id, fetch lead data
 * from the Graph API, normalize it, and route through ingestion.
 */
router.post('/facebook/webhook', async (req: Request, res: Response) => {
  try {
    // Validate webhook signature if app secret is configured
    if (FB_APP_SECRET) {
      const signature = req.headers['x-hub-signature-256'] as string;
      if (!signature) {
        return res.status(401).json({ error: 'Missing webhook signature' });
      }

      const crypto = await import('crypto');
      const expectedSignature =
        'sha256=' +
        crypto
          .createHmac('sha256', FB_APP_SECRET)
          .update(JSON.stringify(req.body))
          .digest('hex');

      if (signature !== expectedSignature) {
        console.warn('Facebook webhook signature mismatch');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    // Parse and validate the webhook payload
    const parsed = WebhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      console.warn('Facebook webhook invalid payload:', parsed.error.message);
      // Facebook requires 200 even for payloads we can't process
      return res.status(200).json({ received: true, processed: false });
    }

    const { entry } = parsed.data;

    // Process each entry (page) and each change (lead event)
    const results: Array<{ leadgenId: string; status: string; contactId?: string }> = [];

    for (const pageEntry of entry) {
      for (const change of pageEntry.changes) {
        if (change.field !== 'leadgen') continue;

        const { leadgen_id, page_id, form_id, campaign_id, campaign_name, ad_id, ad_name } =
          change.value;

        try {
          const result = await processLeadEvent({
            leadgenId: leadgen_id,
            pageId: page_id,
            formId: form_id,
            campaignId: campaign_id,
            campaignName: campaign_name,
            adId: ad_id,
            adName: ad_name,
            createdTime: change.value.created_time,
          });
          results.push(result);
        } catch (err: any) {
          console.error(`Failed to process lead ${leadgen_id}:`, err.message);
          results.push({ leadgenId: leadgen_id, status: 'error' });
        }
      }
    }

    // Facebook requires 200 response to acknowledge receipt
    return res.status(200).json({ received: true, processed: results.length, results });
  } catch (error: any) {
    console.error('Facebook webhook error:', error);
    // Always return 200 to Facebook to prevent retry storms
    return res.status(200).json({ received: true, error: 'Internal processing error' });
  }
});

// ── KAN-126: Lead Data Fetching & Normalization ──────────────────────────────

interface LeadEventParams {
  leadgenId: string;
  pageId: string;
  formId: string;
  campaignId?: string;
  campaignName?: string;
  adId?: string;
  adName?: string;
  createdTime: number;
}

/**
 * Process a single lead event:
 * 1. Look up tenant by page_id
 * 2. Fetch full lead data from Graph API
 * 3. Normalize to unified contact schema
 * 4. Route through ingestion pipeline
 */
async function processLeadEvent(
  params: LeadEventParams
): Promise<{ leadgenId: string; status: string; contactId?: string }> {
  const { leadgenId, pageId, formId, campaignId, campaignName, adId, adName, createdTime } =
    params;

  // Step 1: Find the tenant integration by page_id
  const integration = await prisma.integration.findFirst({
    where: {
      provider: 'facebook_leads',
      status: 'connected',
      config: {
        path: ['pageId'],
        equals: pageId,
      },
    },
  });

  if (!integration) {
    console.warn(`No tenant found for Facebook page ${pageId}`);
    // Audit log for unmatched leads
    await prisma.auditLog.create({
      data: {
        tenantId: 'system',
        actor: 'system',
        actionType: 'facebook.lead_unmatched',
        payload: { leadgenId, pageId, formId },
        reasoning: `No tenant integration found for Facebook page ${pageId}`,
      },
    });
    return { leadgenId, status: 'unmatched' };
  }

  const tenantId = integration.tenantId;
  const accessToken = (integration.config as any)?.accessToken;

  if (!accessToken) {
    throw new Error(`No access token configured for tenant ${tenantId}`);
  }

  // Step 2: Fetch full lead data from Facebook Graph API
  const leadData = await fetchLeadData(leadgenId, accessToken);

  if (!leadData) {
    throw new Error(`Failed to fetch lead data for ${leadgenId}`);
  }

  // Step 3: Normalize lead data to unified contact schema
  const normalizedContact = normalizeLeadData(leadData, {
    tenantId,
    formId,
    campaignId,
    campaignName,
    adId,
    adName,
    createdTime,
    formMappings: (integration.config as any)?.formMappings,
  });

  // Step 4: Route through ingestion pipeline (KAN-127)
  const contactId = await ingestNormalizedLead(normalizedContact, tenantId);

  // Audit log
  await prisma.auditLog.create({
    data: {
      tenantId,
      actor: 'system',
      actionType: 'facebook.lead_ingested',
      payload: {
        leadgenId,
        formId,
        campaignId,
        campaignName,
        contactId,
        fieldCount: Object.keys(normalizedContact.fields).length,
      },
      reasoning: `Facebook Lead Ad captured from form ${formId}${campaignName ? ` (campaign: ${campaignName})` : ''}`,
    },
  });

  return { leadgenId, status: 'ingested', contactId };
}

/**
 * Fetch lead data from Facebook Graph API.
 * Uses the page access token to retrieve form submission details.
 */
async function fetchLeadData(
  leadgenId: string,
  accessToken: string
): Promise<any | null> {
  try {
    const url = `${FB_GRAPH_API_BASE}/${leadgenId}?access_token=${accessToken}`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error(`Facebook Graph API error for lead ${leadgenId}:`, error);
      return null;
    }

    const data = await response.json();
    return LeadDataSchema.parse(data);
  } catch (error: any) {
    console.error(`Failed to fetch lead ${leadgenId}:`, error.message);
    return null;
  }
}

/**
 * Normalize Facebook Lead Ad form data to the growth unified contact schema.
 * Handles varying field names from different form configurations.
 */
interface NormalizationContext {
  tenantId: string;
  formId: string;
  campaignId?: string;
  campaignName?: string;
  adId?: string;
  adName?: string;
  createdTime: number;
  formMappings?: Array<{
    formId: string;
    objectiveId?: string;
    customFieldMap?: Record<string, string>;
  }>;
}

interface NormalizedLead {
  fields: Record<string, any>;
  source: {
    provider: string;
    channel: string;
    formId: string;
    campaignId?: string;
    campaignName?: string;
    adId?: string;
    adName?: string;
    capturedAt: string;
  };
  dataQualityScore: number;
}

function normalizeLeadData(leadData: any, context: NormalizationContext): NormalizedLead {
  const fields: Record<string, any> = {};
  let qualityPoints = 0;
  let maxPoints = 0;

  // Get custom field mapping for this specific form, if configured
  const formConfig = context.formMappings?.find((m) => m.formId === context.formId);
  const customFieldMap = formConfig?.customFieldMap || {};

  // Process each form field
  if (leadData.field_data) {
    for (const field of leadData.field_data) {
      const value = field.values?.[0]; // Facebook returns arrays, take first value
      if (!value || value.trim() === '') continue;

      const fieldName = field.name.toLowerCase().replace(/\s+/g, '_');

      // Priority: custom mapping → default mapping → raw field
      const mappedField = customFieldMap[fieldName] || FB_LEAD_FIELD_MAP[fieldName];

      if (mappedField) {
        // Apply normalization based on field type
        switch (mappedField) {
          case 'email':
            const normalizedEmail = normalizeEmail(value);
            if (normalizedEmail) {
              fields.email = normalizedEmail;
              qualityPoints += 3; // Email is high-value
            }
            break;
          case 'phone':
            const normalizedPhone = normalizePhone(value);
            if (normalizedPhone) {
              fields.phone = normalizedPhone;
              qualityPoints += 2;
            }
            break;
          case 'fullName':
            const nameParts = parseFullName(value);
            if (nameParts.firstName) fields.firstName = nameParts.firstName;
            if (nameParts.lastName) fields.lastName = nameParts.lastName;
            qualityPoints += 1;
            break;
          default:
            fields[mappedField] = value.trim();
            qualityPoints += 1;
            break;
        }
      } else {
        // Store unmapped fields in customFields
        if (!fields.customFields) fields.customFields = {};
        fields.customFields[fieldName] = value.trim();
      }

      maxPoints += 3; // Max per field
    }
  }

  // Calculate data quality score (0-100)
  const dataQualityScore = maxPoints > 0 ? Math.round((qualityPoints / maxPoints) * 100) : 0;

  // Boost score if we have both email and name (minimum viable lead)
  const hasEmail = !!fields.email;
  const hasName = !!(fields.firstName || fields.lastName);
  const adjustedScore = hasEmail
    ? Math.max(dataQualityScore, hasName ? 60 : 40)
    : Math.min(dataQualityScore, 30);

  // Set source metadata
  fields.lifecycleStage = 'lead';
  fields.segment = 'facebook_lead_ad';

  // Add objective ID if form is mapped to one
  if (formConfig?.objectiveId) {
    fields.objectiveId = formConfig.objectiveId;
  }

  return {
    fields,
    source: {
      provider: 'facebook',
      channel: 'lead_ad',
      formId: context.formId,
      campaignId: context.campaignId,
      campaignName: context.campaignName,
      adId: context.adId,
      adName: context.adName,
      capturedAt: new Date(context.createdTime * 1000).toISOString(),
    },
    dataQualityScore: adjustedScore,
  };
}

// ── KAN-127: Ingestion Pipeline Routing ──────────────────────────────────────

/**
 * Ingest a normalized lead into the growth contact pipeline.
 * - Deduplicates by email (if present)
 * - Creates or updates contact record
 * - Fires contact.ingested event for Brain Service consumption
 */
async function ingestNormalizedLead(
  normalizedLead: NormalizedLead,
  tenantId: string
): Promise<string> {
  const { fields, source, dataQualityScore } = normalizedLead;

  // Attempt to find existing contact by email for deduplication
  let existingContact = null;
  if (fields.email) {
    existingContact = await prisma.contact.findFirst({
      where: {
        tenantId,
        email: fields.email,
      },
    });
  }

  // Also try phone-based dedup if no email match
  if (!existingContact && fields.phone) {
    existingContact = await prisma.contact.findFirst({
      where: {
        tenantId,
        phone: fields.phone,
      },
    });
  }

  const contactId = existingContact?.id || randomUUID();

  // Build the external IDs map for tracking source
  const externalIds: Record<string, string> = {
    ...(existingContact?.externalIds as Record<string, string> || {}),
    facebook_form: source.formId,
  };
  if (source.campaignId) externalIds.facebook_campaign = source.campaignId;
  if (source.adId) externalIds.facebook_ad = source.adId;

  // Upsert the contact
  await prisma.contact.upsert({
    where: { id: contactId },
    update: {
      // Only update fields that are non-empty from the lead
      ...(fields.firstName && { firstName: fields.firstName }),
      ...(fields.lastName && { lastName: fields.lastName }),
      ...(fields.phone && !existingContact?.phone && { phone: fields.phone }),
      ...(fields.company && { company: fields.company }),
      ...(fields.title && { title: fields.title }),
      ...(fields.city && { city: fields.city }),
      ...(fields.state && { state: fields.state }),
      ...(fields.country && { country: fields.country }),
      ...(fields.postalCode && { postalCode: fields.postalCode }),
      ...(fields.website && { website: fields.website }),
      externalIds,
      dataQualityScore: Math.max(
        existingContact?.dataQualityScore || 0,
        dataQualityScore
      ),
      // Update segment only if not already set to something more specific
      ...((!existingContact?.segment || existingContact.segment === 'unknown') && {
        segment: fields.segment,
      }),
      updatedAt: new Date(),
    },
    create: {
      id: contactId,
      tenantId,
      email: fields.email || null,
      phone: fields.phone || null,
      firstName: fields.firstName || null,
      lastName: fields.lastName || null,
      company: fields.company || null,
      title: fields.title || null,
      city: fields.city || null,
      state: fields.state || null,
      country: fields.country || null,
      postalCode: fields.postalCode || null,
      website: fields.website || null,
      lifecycleStage: fields.lifecycleStage || 'lead',
      segment: fields.segment || 'facebook_lead_ad',
      externalIds,
      dataQualityScore,
      source: 'facebook_lead_ad',
      customFields: fields.customFields || {},
    },
  });

  // Record the ingestion event in the timeline
  await prisma.contactEvent.create({
    data: {
      id: randomUUID(),
      contactId,
      tenantId,
      eventType: 'lead_captured',
      channel: 'facebook',
      payload: {
        source,
        dataQualityScore,
        isNew: !existingContact,
        fieldCount: Object.keys(fields).length,
      },
    },
  });

  // TODO: Publish contact.ingested event to Pub/Sub for Brain Service
  // await publishEvent('contact.ingested', {
  //   tenantId,
  //   contactId,
  //   normalizedData: fields,
  //   source,
  //   dataQualityScore,
  //   isNew: !existingContact,
  // });

  return contactId;
}

// ── Connection Management ────────────────────────────────────────────────────

/**
 * POST /facebook/connect
 * Register a Facebook page for Lead Ads webhook events.
 * Stores the page access token and page ID for the tenant.
 */
router.post('/facebook/connect', async (req: Request, res: Response) => {
  try {
    const config = TenantFbConfigSchema.parse(req.body);

    await prisma.integration.upsert({
      where: {
        tenantId_provider: {
          tenantId: config.tenantId,
          provider: 'facebook_leads',
        },
      },
      update: {
        status: 'connected',
        connectionId: `fb_leads_${config.tenantId}`,
        config: {
          pageId: config.pageId,
          accessToken: config.accessToken,
          formMappings: config.formMappings || [],
        },
        fieldMappings: FB_LEAD_FIELD_MAP,
      },
      create: {
        id: randomUUID(),
        tenantId: config.tenantId,
        provider: 'facebook_leads',
        connectionId: `fb_leads_${config.tenantId}`,
        status: 'connected',
        config: {
          pageId: config.pageId,
          accessToken: config.accessToken,
          formMappings: config.formMappings || [],
        },
        fieldMappings: FB_LEAD_FIELD_MAP,
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId: config.tenantId,
        actor: 'user',
        actionType: 'facebook.leads_connected',
        payload: { pageId: config.pageId },
        reasoning: 'User connected Facebook Lead Ads integration',
      },
    });

    return res.json({
      status: 'connected',
      pageId: config.pageId,
      webhookUrl: `${process.env.API_BASE_URL || 'https://api.growth.axisone.ca'}/facebook/webhook`,
      message:
        'Facebook Lead Ads connected. Configure the webhook URL in your Facebook App settings ' +
        'and subscribe to the leadgen field on your page.',
    });
  } catch (error: any) {
    console.error('Facebook connect error:', error);
    return res.status(500).json({
      error: 'Failed to connect Facebook Lead Ads',
      details: error.message,
    });
  }
});

/**
 * GET /facebook/status
 * Get the current Facebook Lead Ads connection status for a tenant.
 */
router.get('/facebook/status', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const integration = await prisma.integration.findUnique({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'facebook_leads',
        },
      },
    });

    if (!integration) {
      return res.json({
        connected: false,
        status: 'not_connected',
        message: 'Facebook Lead Ads is not connected for this tenant.',
      });
    }

    // Get lead count for this tenant
    const leadCount = await prisma.contact.count({
      where: {
        tenantId,
        source: 'facebook_lead_ad',
      },
    });

    return res.json({
      connected: integration.status === 'connected',
      status: integration.status,
      pageId: (integration.config as any)?.pageId,
      formMappings: (integration.config as any)?.formMappings || [],
      lastSyncAt: integration.lastSyncAt,
      totalLeadsCaptured: leadCount,
    });
  } catch (error: any) {
    console.error('Facebook status error:', error);
    return res.status(500).json({
      error: 'Failed to get Facebook Lead Ads status',
      details: error.message,
    });
  }
});

/**
 * DELETE /facebook/disconnect
 * Disconnect Facebook Lead Ads integration for a tenant.
 */
router.delete('/facebook/disconnect', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const integration = await prisma.integration.findUnique({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'facebook_leads',
        },
      },
    });

    if (!integration) {
      return res.status(404).json({ error: 'Facebook Lead Ads integration not found' });
    }

    await prisma.integration.update({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'facebook_leads',
        },
      },
      data: {
        status: 'disconnected',
        config: {
          ...(integration.config as any),
          accessToken: '[REDACTED]', // Don't keep stale tokens
        },
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'user',
        actionType: 'facebook.leads_disconnected',
        payload: { pageId: (integration.config as any)?.pageId },
        reasoning: 'User disconnected Facebook Lead Ads integration',
      },
    });

    return res.json({
      status: 'disconnected',
      message: 'Facebook Lead Ads disconnected. Remember to remove the webhook subscription from your Facebook App settings.',
    });
  } catch (error: any) {
    console.error('Facebook disconnect error:', error);
    return res.status(500).json({
      error: 'Failed to disconnect Facebook Lead Ads',
      details: error.message,
    });
  }
});

/**
 * PUT /facebook/config
 * Update Facebook Lead Ads configuration (form mappings, etc.)
 */
router.put('/facebook/config', async (req: Request, res: Response) => {
  try {
    const { tenantId, formMappings } = z
      .object({
        tenantId: z.string().uuid(),
        formMappings: z.array(
          z.object({
            formId: z.string(),
            objectiveId: z.string().uuid().optional(),
            customFieldMap: z.record(z.string()).optional(),
          })
        ),
      })
      .parse(req.body);

    const integration = await prisma.integration.findUnique({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'facebook_leads',
        },
      },
    });

    if (!integration || integration.status !== 'connected') {
      return res.status(400).json({ error: 'Facebook Lead Ads is not connected' });
    }

    await prisma.integration.update({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'facebook_leads',
        },
      },
      data: {
        config: {
          ...(integration.config as any),
          formMappings,
        },
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'user',
        actionType: 'facebook.config_updated',
        payload: { formMappingCount: formMappings.length },
        reasoning: 'User updated Facebook Lead Ads form mappings',
      },
    });

    return res.json({
      status: 'updated',
      formMappings,
      message: `Updated ${formMappings.length} form mapping(s).`,
    });
  } catch (error: any) {
    console.error('Facebook config error:', error);
    return res.status(500).json({
      error: 'Failed to update Facebook Lead Ads config',
      details: error.message,
    });
  }
});

/**
 * GET /facebook/forms
 * List available Lead Ad forms for the connected Facebook page.
 */
router.get('/facebook/forms', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const integration = await prisma.integration.findUnique({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'facebook_leads',
        },
      },
    });

    if (!integration || integration.status !== 'connected') {
      return res.status(400).json({ error: 'Facebook Lead Ads is not connected' });
    }

    const config = integration.config as any;
    const { pageId, accessToken } = config;

    // Fetch forms from Facebook Graph API
    const url = `${FB_GRAPH_API_BASE}/${pageId}/leadgen_forms?access_token=${accessToken}`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return res.status(502).json({
        error: 'Failed to fetch forms from Facebook',
        details: (error as any)?.error?.message || 'Unknown error',
      });
    }

    const data = await response.json();
    const forms = (data.data || []).map((form: any) => ({
      id: form.id,
      name: form.name,
      status: form.status,
      createdTime: form.created_time,
      // Include whether this form has a mapping configured
      isMapped: config.formMappings?.some((m: any) => m.formId === form.id) || false,
    }));

    return res.json({ forms, total: forms.length });
  } catch (error: any) {
    console.error('Facebook forms error:', error);
    return res.status(500).json({
      error: 'Failed to get Facebook Lead Ad forms',
      details: error.message,
    });
  }
});

// ── Sync History ─────────────────────────────────────────────────────────────

/**
 * GET /facebook/leads/history
 * Get lead capture history and audit trail for Facebook Lead Ads.
 */
router.get('/facebook/leads/history', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const logs = await prisma.auditLog.findMany({
      where: {
        tenantId,
        actionType: { startsWith: 'facebook.' },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    const total = await prisma.auditLog.count({
      where: {
        tenantId,
        actionType: { startsWith: 'facebook.' },
      },
    });

    return res.json({
      history: logs.map((log) => ({
        id: log.id,
        actionType: log.actionType,
        payload: log.payload,
        reasoning: log.reasoning,
        createdAt: log.createdAt,
      })),
      total,
      limit,
      offset,
    });
  } catch (error: any) {
    console.error('Facebook history error:', error);
    return res.status(500).json({
      error: 'Failed to get lead capture history',
      details: error.message,
    });
  }
});

// ── Normalization Helpers ────────────────────────────────────────────────────

function normalizeEmail(email: string | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed) ? trimmed : null;
}

function normalizePhone(phone: string | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.trim().replace(/[^\d+]/g, '');
  const digitCount = cleaned.replace(/\+/g, '').length;
  if (digitCount < 7 || digitCount > 15) return null;
  if (digitCount >= 10 && !cleaned.startsWith('+')) {
    return `+${cleaned}`;
  }
  return cleaned;
}

/**
 * Parse a full name into first and last name components.
 * Handles common patterns: "John Smith", "Smith, John", "John"
 */
function parseFullName(fullName: string): { firstName?: string; lastName?: string } {
  const trimmed = fullName.trim();
  if (!trimmed) return {};

  // Handle "Last, First" format
  if (trimmed.includes(',')) {
    const [last, first] = trimmed.split(',').map((s) => s.trim());
    return { firstName: first || undefined, lastName: last || undefined };
  }

  // Handle "First Last" format
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0] };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

export default router;
export { processLeadEvent, normalizeLeadData, ingestNormalizedLead, fetchLeadData };
export { FB_LEAD_FIELD_MAP, parseFullName };
