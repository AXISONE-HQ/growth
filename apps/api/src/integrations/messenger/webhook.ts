/**
 * Facebook Messenger Webhook Handler
 * Receives incoming messages from Messenger and ingests contacts.
 * Messages are processed asynchronously — we return 200 immediately.
 */

import { Hono } from "hono";
import crypto from "crypto";
import { getMessengerProfile } from "./graph-api.js";
import { prisma } from "../../prisma.js";

export const messengerWebhookApp = new Hono();

// ── Signature Verification ──────────────────────────────────────────────────

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

// ── Webhook Routes ──────────────────────────────────────────────────────────

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

  console.warn("Messenger webhook verification failed — token mismatch");
  return c.text("Forbidden", 403);
});

/**
 * POST /webhooks/messenger
 * Receives messaging events from Meta.
 * Payload contains sender PSID and message content.
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

  // Must respond 200 quickly — Meta retries on timeout
  processMessagingEntries(payload).catch((err) => {
    console.error("Messenger processing error:", err);
  });

  return c.json({ received: true }, 200);
});

// ── Message Processing ──────────────────────────────────────────────────────

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
  }>;
}

async function processMessagingEntries(payload: any): Promise<void> {
  if (payload.object !== "page") return;

  const entries: MessagingEntry[] = payload.entry || [];

  for (const entry of entries) {
    const pageId = entry.id;
    const events = entry.messaging || [];

    for (const event of events) {
      try {
        await processMessagingEvent(pageId, event);
      } catch (err) {
        console.error(
          `Failed to process Messenger event from ${event.sender?.id}:`,
          err
        );
      }
    }
  }
}

async function processMessagingEvent(
  pageId: string,
  event: MessagingEntry["messaging"][0]
): Promise<void> {
  const senderId = event.sender.id;

  // Skip echo messages (sent by the page itself)
  if (senderId === event.recipient.id) return;

  // 1. Look up the integration by page_id to get tenant and token
  const integrations = await prisma.integration.findMany({
    where: {
      provider: "Facebook Messenger",
      status: "connected",
    },
  });

  const integration = integrations.find((i) => {
    const config = i.config as any;
    return config?.pageId === pageId;
  });

  if (!integration) {
    console.warn(
      `No Messenger integration found for page ${pageId} — message from ${senderId} dropped`
    );
    return;
  }

  const config = integration.config as any;
  const pageAccessToken = config.pageAccessToken;
  if (!pageAccessToken) {
    console.error(
      `No page access token for Messenger integration ${integration.id}`
    );
    return;
  }

  // 2. Extract message content
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
  }

  // 3. Get sender profile (best-effort)
  let profile: { firstName?: string; lastName?: string } = {};
  try {
    profile = await getMessengerProfile(senderId, pageAccessToken);
  } catch {
    console.warn(`Could not fetch profile for PSID ${senderId}`);
  }

  // 4. Upsert contact by Messenger PSID
  //    Messenger doesn't give us an email — we use PSID as primary identifier.
  //    When the contact is later enriched (e.g. via lead ad or form), the
  //    externalIds.messenger.psid can be used to merge.
  const contact = await prisma.contact.upsert({
    where: {
      tenantId_email: {
        tenantId: integration.tenantId,
        // Use a synthetic email based on PSID — will be replaced when real email is known
        email: `messenger_${senderId}@messenger.placeholder`,
      },
    },
    create: {
      tenantId: integration.tenantId,
      email: `messenger_${senderId}@messenger.placeholder`,
      firstName: profile.firstName,
      lastName: profile.lastName,
      segment: "messenger_inbound",
      lifecycleStage: "lead",
      dataQualityScore: 20, // Low — no email, only PSID
      externalIds: {
        messenger: {
          psid: senderId,
          pageId,
        },
      },
    },
    update: {
      ...(profile.firstName && { firstName: profile.firstName }),
      ...(profile.lastName && { lastName: profile.lastName }),
      externalIds: {
        messenger: {
          psid: senderId,
          pageId,
        },
      },
    },
  });

  // 5. Update integration lastSyncAt
  await prisma.integration.update({
    where: { id: integration.id },
    data: { lastSyncAt: new Date() },
  });

  console.log(
    `Messenger message ingested: PSID ${senderId} (tenant: ${integration.tenantId}, ` +
      `type: ${messageType}, contact: ${contact.id})`
  );

  // 6. TODO: Emit contact.message.received Pub/Sub event
  // await pubsub.topic('contact.message.received').publishMessage({
  //   json: {
  //     tenantId: integration.tenantId,
  //     contactId: contact.id,
  //     channel: 'messenger',
  //     senderId,
  //     messageText,
  //     messageType,
  //     timestamp: event.timestamp,
  //   },
  // });
}
