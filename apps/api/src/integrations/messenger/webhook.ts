/**
 * Facebook Messenger Webhook Handler
 * Receives incoming messages from Messenger, routes to the correct tenant,
 * persists conversation history, and emits events for the AI loop.
 *
 * Per-tenant routing:
 *   Meta sends pageId in every webhook entry â we look up the integration
 *   record by pageId to resolve the tenantId. This avoids scanning all
 *   integrations  -  the query is indexed via the JSONB config column.
 */

import { Hono } from "hono";
import crypto from "crypto";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { getMessengerProfile } from "./graph-api.js";
import { prisma } from "../../prisma.js";

export const messengerWebhookApp = new Hono();

const secretManager = new SecretManagerServiceClient();

// ââ Signature Verification ââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Verify the X-Hub-Signature-256 header against the app secret.
 * Meta signs all webhook payloads with HMAC-SHA256.
 */
function verifySignature(
  payload: string,
  signature: string,
  appSecret: string
): boolean {
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(payload).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

// ââ In-memory pageâintegration cache ââââââââââââââââââââââââââââââââââââââââ
// Avoids a DB round-trip on every single message. TTL = 5 minutes.

interface CachedIntegration {
  id: string;
  tenantId: string;
  pageAccessToken: string;
  // Held so the lastInboundEventAt write below can spread + merge without a
  // separate fetch round-trip. Reset on cache eviction.
  metadata: Record<string, unknown>;
  cachedAt: number;
}

const integrationCache = new Map<string, CachedIntegration>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Inline page-token loader. Mirrors the access pattern from
 * apps/connectors/src/adapters/meta/client.ts loadPageToken(); two callsites
 * (here + KAN-474 oauth.ts disconnect path) doesn't justify extracting to a
 * shared package yet.
 */
async function loadPageTokenFromSecretRef(
  credentialsRef: string,
): Promise<string | null> {
  try {
    const [version] = await secretManager.accessSecretVersion({ name: credentialsRef });
    const raw = version.payload?.data?.toString();
    if (!raw) return null;
    const payload = JSON.parse(raw) as { pageAccessToken?: string };
    return payload.pageAccessToken ?? null;
  } catch (err) {
    console.error(
      "[messenger-webhook] failed to load page token from Secret Manager:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Resolve the Messenger ChannelConnection for a given Page ID.
 * KAN-691: replaces the prior raw-SQL query against the phantom Integration
 * table. Page token now lives in Secret Manager (per KAN-474), loaded on
 * cache miss via credentialsRef.
 */
async function getIntegrationByPageId(
  pageId: string
): Promise<CachedIntegration | null> {
  // 1. Check cache
  const cached = integrationCache.get(pageId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  // 2. Query DB  -  use raw SQL for efficient JSONB lookup
  //    This avoids fetching all integrations and filtering in-memory.
  // 2. Look up the active ChannelConnection. KAN-474 set:
  //      provider='meta', channelType='MESSENGER', providerAccountId=page.id,
  //      credentialsRef=<Secret Manager path>, metadata={pageId, pageName, ...}
  const conn = await prisma.channelConnection.findFirst({
    where: {
      provider: "meta",
      channelType: "MESSENGER",
      providerAccountId: pageId,
      status: "ACTIVE",
    },
  });
  if (!conn) {
    return null;
  }

  // 3. Load the page access token from Secret Manager via credentialsRef.
  const pageAccessToken = await loadPageTokenFromSecretRef(conn.credentialsRef);
  if (!pageAccessToken) {
    console.error(
      `[messenger-webhook] no page access token for ChannelConnection ${conn.id}`,
    );
    return null;
  }

  // 4. Populate cache
  const entry: CachedIntegration = {
    id: conn.id,
    tenantId: conn.tenantId,
    pageAccessToken,
    metadata: (conn.metadata ?? {}) as Record<string, unknown>,
    cachedAt: Date.now(),
  };
  integrationCache.set(pageId, entry);

  return entry;
}

/**
 * Invalidate cache for a specific page (call on disconnect).
 */
export function invalidatePageCache(pageId: string): void {
  integrationCache.delete(pageId);
}

// ââ Webhook Routes ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * GET /webhooks/messenger
 * Meta webhook verification challenge.
 */
messengerWebhookApp.get("/", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  const verifyToken = process.env.MESSENGER_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token === verifyToken) {
    console.log("Messenger webhook verified successfully");
    return c.text(challenge || "", 200);
  }

  console.warn("Messenger webhook verification failed  -  token mismatch");
  return c.text("Forbidden", 403);
});

/**
 * POST /webhooks/messenger
 * Receives messaging events from Meta.
 * Payload contains sender PSID and message content.
 *
 * CRITICAL: Must return 200 within 5 seconds or Meta will retry.
 * All processing happens asynchronously after the response.
 */
messengerWebhookApp.post("/", async (c) => {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error("META_APP_SECRET not configured");
    return c.json({ error: "Not configured" }, 500);
  }

  // 1. Verify webhook signature
  const signature = c.req.header("x-hub-signature-256");
  const rawBody = await c.req.text();

  if (!signature || !verifySignature(rawBody, signature, appSecret)) {
    console.warn("Messenger webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // 2. Parse the payload
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Must respond 200 immediately  -  Meta retries on timeout
  processMessagingEntries(payload).catch((err) => {
    console.error("Messenger processing error:", err);
  });

  return c.json({ received: true }, 200);
});

// ââ Message Processing ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

interface MessagingEntry {
  id: string; // Page ID
  time: number;
  messaging: Array<{
    sender: { id: string };
    recipient: { id: string };
    timestamp: number;
    message?: {
      mid: string;
      text?: string;
      is_echo?: boolean;
      attachments?: Array<{
        type: string;
        payload: { url?: string };
      }>;
      quick_reply?: { payload: string };
    };
    postback?: {
      title: string;
      payload: string;
    };
    optin?: {
      ref?: string;
    };
    delivery?: {
      mids: string[];
      watermark: number;
    };
    read?: {
      watermark: number;
    };
  }>;
}

async function processMessagingEntries(payload: any): Promise<void> {
  if (payload.object !== "page") return;

  const entries: MessagingEntry[] = payload.entry || [];

  for (const entry of entries) {
    const pageId = entry.id;

    // ââ Per-tenant routing: resolve pageId â tenant ââ
    const integration = await getIntegrationByPageId(pageId);
    if (!integration) {
      console.warn(
        `No Messenger integration found for page ${pageId}  -  dropping ${entry.messaging?.length || 0} events`
      );
      continue;
    }

    const events = entry.messaging || [];

    for (const event of events) {
      try {
        // Skip delivery receipts and read receipts  -  they're not messages
        if (event.delivery || event.read) continue;

        // Skip echo messages (messages sent by the page itself)
        if (event.message?.is_echo) continue;

        await processMessagingEvent(integration, pageId, event);
      } catch (err) {
        console.error(
          `Failed to process Messenger event from PSID ${event.sender?.id} ` +
            `(tenant: ${integration.tenantId}):`,
          err
        );
      }
    }
  }
}

async function processMessagingEvent(
  integration: CachedIntegration,
  pageId: string,
  event: MessagingEntry["messaging"][0]
): Promise<void> {
  const senderId = event.sender.id;
  const { tenantId, pageAccessToken } = integration;

  // 1. Extract message content
  let messageText = "";
  let messageType = "text";

  if (event.message?.text) {
    messageText = event.message.text;
  } else if (event.message?.quick_reply) {
    messageText = event.message.quick_reply.payload;
    messageType = "quick_reply";
  } else if (event.postback) {
    messageText = event.postback.payload;
    messageType = "postback";
  } else if (event.message?.attachments) {
    messageType = "attachment";
    messageText = event.message.attachments
      .map((a) => `[${a.type}]`)
      .join(", ");
  } else if (event.optin) {
    messageType = "optin";
    messageText = event.optin.ref || "opted_in";
  }

  // 2. Get sender profile (best-effort, non-blocking)
  let profile: { firstName?: string; lastName?: string } = {};
  try {
    profile = await getMessengerProfile(senderId, pageAccessToken);
  } catch {
    console.warn(`Could not fetch profile for PSID ${senderId}`);
  }

  // 3. Upsert contact by Messenger PSID
  //    Messenger doesn't provide email  -  we use a synthetic placeholder.
  //    When the contact is later enriched (via lead ad, form, CRM sync),
  //    the externalIds.messenger.psid field enables identity merge.
  const syntheticEmail = `messenger_${senderId}@messenger.placeholder`;

  // KAN-691: Contact has no @@unique([tenantId,email]) — only @@index. Email is
  // nullable so an upsert composite key isn't possible at the schema level.
  // Use findFirst + create-or-update. Race window is benign: a duplicate row
  // would create a second messenger contact for the same PSID; identity-merge
  // (separate ticket) will reconcile via externalIds.
  const existingContact = await prisma.contact.findFirst({
    where: { tenantId, email: syntheticEmail },
    select: { id: true },
  });
  const contact = existingContact
    ? await prisma.contact.update({
        where: { id: existingContact.id },
        data: {
          ...(profile.firstName && { firstName: profile.firstName }),
          ...(profile.lastName && { lastName: profile.lastName }),
          externalIds: { messenger: { psid: senderId, pageId } },
        },
      })
    : await prisma.contact.create({
        data: {
          tenantId,
          email: syntheticEmail,
          firstName: profile.firstName,
          lastName: profile.lastName,
          segment: "messenger_inbound",
          lifecycleStage: "lead",
          dataQualityScore: 20, // Low - no email, only PSID
          externalIds: { messenger: { psid: senderId, pageId } },
        },
      });

  // 4. Log the inbound message in the audit log
  //    This creates a full conversation history per tenant.
  await prisma.auditLog.create({
    data: {
      tenantId,
      actor: `messenger:${senderId}`,
      actionType: "message.received",
      payload: {
        channel: "messenger",
        contactId: contact.id,
        senderId,
        pageId,
        messageType,
        messageText:
          messageText.length > 1000
            ? messageText.substring(0, 1000) + "..."
            : messageText,
        messageId: event.message?.mid,
        timestamp: event.timestamp,
        senderName: [profile.firstName, profile.lastName]
          .filter(Boolean)
          .join(" "),
      },
      reasoning: `Inbound ${messageType} message from Messenger PSID ${senderId}`,
    },
  });

  // 5. Update connection metadata.lastInboundEventAt (KAN-691).
  //    ChannelConnection has no `lastSyncAt` column; metadata JSONB carries
  //    the same liveness signal. Spread the cached metadata so we don't clobber
  //    pageId/pageName/subscribedAt that KAN-474 set at OAuth time.
  await prisma.channelConnection.update({
    where: { id: integration.id },
    data: {
      metadata: {
        ...integration.metadata,
        lastInboundEventAt: new Date().toISOString(),
      },
    },
  });

  console.log(
    `[Messenger] Message ingested  -  tenant: ${tenantId}, PSID: ${senderId}, ` +
      `type: ${messageType}, contact: ${contact.id}`
  );

  // 6. Emit contact.message.received event via Pub/Sub
  //    This kicks off the AI Decision Engine loop:
  //    Ingest â Understand â Decide â Execute â Learn
  try {
    await emitMessageReceivedEvent({
      tenantId,
      contactId: contact.id,
      integrationId: integration.id,
      channel: "messenger",
      senderId,
      pageId,
      messageText,
      messageType,
      messageId: event.message?.mid,
      timestamp: event.timestamp,
    });
  } catch (err) {
    // Non-fatal  -  message is already persisted in audit log
    console.error("Failed to emit Pub/Sub event:", err);
  }
}

// ââ Pub/Sub Event Emission ââââââââââââââââââââââââââââââââââââââââââââââââââ

interface MessageReceivedEvent {
  tenantId: string;
  contactId: string;
  integrationId: string;
  channel: string;
  senderId: string;
  pageId: string;
  messageText: string;
  messageType: string;
  messageId?: string;
  timestamp: number;
}

/**
 * Emit a contact.message.received event to Pub/Sub.
 * The Decision Engine subscribes to this topic and determines
 * the best next action for the contact.
 *
 * At MVP, if Pub/Sub isn't configured, we log and skip gracefully.
 * The audit log still captures the message for conversation history.
 */
async function emitMessageReceivedEvent(
  event: MessageReceivedEvent
): Promise<void> {
  const topicName = process.env.PUBSUB_TOPIC_MESSAGE_RECEIVED;

  if (!topicName) {
    console.log(
      "[Pub/Sub] PUBSUB_TOPIC_MESSAGE_RECEIVED not configured  -  skipping event emission"
    );
    return;
  }

  // Dynamic import  -  Pub/Sub client is only loaded when needed
  try {
    const { PubSub } = await import("@google-cloud/pubsub");
    const pubsub = new PubSub();
    const topic = pubsub.topic(topicName);

    await topic.publishMessage({
      json: {
        eventType: "contact.message.received",
        // KAN-691: separate emit-time (ISO) from Meta-side event time (unix ms,
        // carried as `event.timestamp` from the spread). Pre-fix the explicit
        // `timestamp:` field was silently overwritten by the spread; rename
        // the wall-clock signal to `emittedAt` so both survive.
        emittedAt: new Date().toISOString(),
        ...event,
      },
    });

    console.log(
      `[Pub/Sub] Emitted contact.message.received for contact ${event.contactId}`
    );
  } catch (err) {
    // Don't let Pub/Sub failure break message ingestion
    console.error("[Pub/Sub] Failed to publish message event:", err);
  }
}
