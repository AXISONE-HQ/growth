/**
 * Meta Lead Ads Webhook Handler
 * Receives leadgen notifications from Meta and ingests contacts.
 */

import { Hono } from "hono";
import crypto from "crypto";
import { fetchLeadData } from "./graph-api.js";
import { mapMetaFieldsToContact } from "./field-mapper.js";
import { prisma } from "../../prisma.js";

export const metaWebhookApp = new Hono();

// ── Signature Verification ──────────────────────────────────────────────────

/**
 * Verify the X-Hub-Signature-256 header against the app secret.
 * Meta signs all webhook payloads with HMAC-SHA256.
 */
function verifySignature(payload: string, signature: string, appSecret: string): boolean {
  const expected = "sha256=" + crypto
    .createHmac("sha256", appSecret)
    .update(payload)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ── Webhook Routes ──────────────────────────────────────────────────────────

/**
 * GET /webhooks/meta/leadgen
 * Meta webhook verification challenge.
 * Meta sends this once when you first configure the webhook URL.
 */
metaWebhookApp.get("/leadgen", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token === verifyToken) {
    console.log("Meta webhook verified successfully");
    return c.text(challenge || "", 200);
  }

  console.warn("Meta webhook verification failed — token mismatch");
  return c.text("Forbidden", 403);
});

/**
 * POST /webhooks/meta/leadgen
 * Receives lead notifications from Meta.
 * Payload contains leadgen_id — we must fetch full lead data via Graph API.
 */
metaWebhookApp.post("/leadgen", async (c) => {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error("META_APP_SECRET not configured");
    return c.json({ error: "Not configured" }, 500);
  }

  // 1. Verify webhook signature
  const signature = c.req.header("x-hub-signature-256");
  const rawBody = await c.req.text();

  if (!signature || !verifySignature(rawBody, signature, appSecret)) {
    console.warn("Meta webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // 2. Parse the payload
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Must respond 200 quickly — Meta retries on timeout
  // Process asynchronously
  processLeadgenEntries(payload).catch((err) => {
    console.error("Lead processing error:", err);
  });

  return c.json({ received: true }, 200);
});

// ── Lead Processing ─────────────────────────────────────────────────────────

interface LeadgenChange {
  field: string;
  value: {
    leadgen_id: string;
    page_id: string;
    form_id?: string;
    ad_id?: string;
    adgroup_id?: string;
    created_time: number;
  };
}

async function processLeadgenEntries(payload: any): Promise<void> {
  const entries = payload?.entry || [];

  for (const entry of entries) {
    const changes: LeadgenChange[] = entry?.changes || [];

    for (const change of changes) {
      if (change.field !== "leadgen") continue;

      const { leadgen_id, page_id, form_id, ad_id, adgroup_id } = change.value;

      try {
        await processLead(leadgen_id, page_id, form_id, ad_id, adgroup_id);
      } catch (err) {
        console.error(`Failed to process lead ${leadgen_id}:`, err);
      }
    }
  }
}

async function processLead(
  leadgenId: string,
  pageId: string,
  formId?: string,
  adId?: string,
  adsetId?: string
): Promise<void> {
  // 1. Look up the integration by page_id to get tenant and token
  const integrations = await prisma.integration.findMany({
    where: {
      provider: "Meta Lead Ads",
      status: "connected",
    },
  });

  // Find the integration whose config.pageId matches
  const integration = integrations.find((i) => {
    const config = i.config as any;
    return config?.pageId === pageId;
  });

  if (!integration) {
    console.warn(`No integration found for page ${pageId} — lead ${leadgenId} dropped`);
    return;
  }

  const config = integration.config as any;
  const pageAccessToken = config.pageAccessToken;
  if (!pageAccessToken) {
    console.error(`No page access token for integration ${integration.id}`);
    return;
  }

  // 2. Fetch full lead data from Graph API
  const leadData = await fetchLeadData(leadgenId, pageAccessToken);

  // 3. Map fields to contact schema
  const mapped = mapMetaFieldsToContact(
    leadData.field_data || [],
    leadgenId,
    formId || leadData.form_id,
    adId || leadData.ad_id,
    adsetId || leadData.adset_id,
    leadData.campaign_id
  );

  if (!mapped) {
    console.warn(`Lead ${leadgenId} could not be mapped (missing email)`);
    return;
  }

  // 4. Upsert contact
  const contact = await prisma.contact.upsert({
    where: {
      tenantId_email: {
        tenantId: integration.tenantId,
        email: mapped.email,
      },
    },
    create: {
      tenantId: integration.tenantId,
      email: mapped.email,
      phone: mapped.phone,
      firstName: mapped.firstName,
      lastName: mapped.lastName,
      company: mapped.company,
      segment: mapped.segment,
      lifecycleStage: "lead",
      dataQualityScore: mapped.dataQualityScore,
      externalIds: mapped.externalIds as any,
    },
    update: {
      // Update fields only if they're provided and the contact doesn't already have them
      ...(mapped.phone && { phone: mapped.phone }),
      ...(mapped.firstName && { firstName: mapped.firstName }),
      ...(mapped.lastName && { lastName: mapped.lastName }),
      ...(mapped.company && { company: mapped.company }),
      // Always update external IDs to capture latest lead metadata
      externalIds: mapped.externalIds as any,
      // Bump data quality score if the new one is higher
      dataQualityScore: mapped.dataQualityScore,
    },
  });

  // 5. Update integration lastSyncAt
  await prisma.integration.update({
    where: { id: integration.id },
    data: { lastSyncAt: new Date() },
  });

  console.log(
    `Lead ingested: ${contact.email} (tenant: ${integration.tenantId}, ` +
    `leadgen: ${leadgenId}, contact: ${contact.id})`
  );

  // 6. TODO: Emit contact.ingested Pub/Sub event when topic is created
  // await pubsub.topic('contact.ingested').publishMessage({
  //   json: {
  //     tenantId: integration.tenantId,
  //     contactId: contact.id,
  //     source: 'meta_lead_ad',
  //     normalizedData: mapped,
  //     dataQualityScore: mapped.dataQualityScore,
  //   },
  // });
}
