/**
 * KAN-741 — Sprint 3 / S3.11 — Resend Inbound webhook handler.
 *
 * Mounted at POST /webhooks/resend-inbound. Public endpoint (no OIDC).
 * Svix-signed (Resend uses Svix infrastructure for both inbound and outbound
 * webhooks, so signature verification reuses the KAN-684 middleware).
 *
 * Flow:
 *   POST → Svix middleware verifies signature → 400 if bad
 *   → Parse "email.received" event from Resend payload
 *   → Resolve tenant from inbox slug in `to` address
 *   → Redis dedup on resend email_id (24h TTL — short-window)
 *   → Long-window dedup via DB unique constraint on lead_inbox_events.resend_email_id
 *   → SPF/DKIM check — reject per Tenant.inbox_dkim_strict mode
 *   → Upsert Contact (match on tenantId+email, update lastInboundAt)
 *   → Write LeadInboxEvent audit row
 *   → Publish lead.received event to Pub/Sub
 *   → 200 OK
 *
 * Rejected emails (slug-mismatch, SPF/DKIM fail, anonymous domain) ALSO
 * write a LeadInboxEvent audit row with status='rejected_*' — Resend retries
 * non-2xx, so we always 200. The audit row is the operational signal.
 *
 * Direct Pub/Sub publish (not via @growth/connector-contracts publishEvent
 * wrapper) — lead.received is a new topic not yet in the connector-contracts
 * discriminated union. Adding it there is a scope-creep item (separate
 * follow-up if connector-contracts unification matters). The event itself
 * is validated by LeadReceivedEventSchema in @growth/shared at construction
 * time, so wrapper validation would be redundant.
 *
 * Required ops setup (operator-side, NOT executed by this PR — see PR
 * description for the gcloud commands):
 *   - Topic: lead.received
 *   - Topic: lead.received.deadletter
 *   - Subscription: lead.received.assignment-worker (push, OIDC-signed,
 *     audience matching env LEAD_RECEIVED_AUDIENCE)
 *   - DNS MX records pointing the LEAD_INBOX_DOMAIN at Resend's MX
 *   - Resend dashboard: receiving domain configured to forward to
 *     <PUBLIC_WEBHOOK_BASE_URL>/webhooks/resend-inbound
 */
import { Hono } from "hono";
import Redis from "ioredis";
import { PubSub } from "@google-cloud/pubsub";
import { randomUUID } from "node:crypto";
import {
  LEAD_RECEIVED_TOPIC,
  buildLeadReceivedEvent,
  type LeadReceivedEvent,
} from "@growth/shared";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { buildSvixMiddleware, getSvixContext } from "../middleware/svix.js";

export const resendInboundWebhookApp = new Hono();

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_KEY_PREFIX = "webhook:resend-inbound:email-id:";
const BODY_PREVIEW_CAP = 500;

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true });
    redis.on("error", (err) => logger.warn({ err }, "[resend-inbound] redis client error"));
  }
  return redis;
}

let pubsub: PubSub | null = null;
function getPubSubClient(): PubSub {
  if (!pubsub) {
    pubsub = new PubSub({
      projectId: env.GCP_PROJECT_ID,
      ...(env.PUBSUB_EMULATOR_HOST ? { apiEndpoint: env.PUBSUB_EMULATOR_HOST } : {}),
    });
  }
  return pubsub;
}

interface ResendInboundAttachment {
  filename?: string;
  content_type?: string;
  size?: number;
}

interface ResendInboundPayload {
  type: string;
  data?: {
    email_id?: string;
    from?: string | { email?: string; name?: string };
    to?: string[] | string;
    subject?: string;
    text?: string;
    html?: string;
    attachments?: ResendInboundAttachment[];
    spf?: { pass?: boolean };
    dkim?: { pass?: boolean };
  };
}

// ─────────────────────────────────────────────
// Hooks for testing — Prisma + publisher injectable
// ─────────────────────────────────────────────

export interface InboundHandlerHooks {
  resolveTenantBySlug: (slug: string) => Promise<{ id: string; inboxDkimStrict: boolean } | null>;
  upsertContactFromEmail: (input: { tenantId: string; email: string; firstName: string | null; lastName: string | null }) => Promise<{ id: string }>;
  writeLeadInboxEvent: (row: LeadInboxEventRow) => Promise<void>;
  publishLeadReceived: (event: LeadReceivedEvent) => Promise<string>;
}

export interface LeadInboxEventRow {
  tenantId: string;
  inboxAddress: string;
  resendEmailId: string | null;
  fromAddress: string;
  subject: string | null;
  bodyPreview: string | null;
  attachmentCount: number;
  spfPass: boolean;
  dkimPass: boolean;
  status: "received" | "rejected_spam" | "rejected_unverified" | "rejected_unknown_slug" | "accepted";
  rejectionReason: string | null;
  createdContactId: string | null;
}

let _hooks: InboundHandlerHooks | null = null;

/** Test seam — inject mock hooks. */
export function __setInboundHooksForTest(hooks: InboundHandlerHooks | null): void {
  _hooks = hooks;
}

function getHooks(): InboundHandlerHooks {
  if (!_hooks) {
    throw new Error("[resend-inbound] hooks not initialized — call setInboundHooks() at app boot");
  }
  return _hooks;
}

/**
 * Boot-time wiring. apps/connectors index.ts calls this with real Prisma-
 * backed implementations. Tests inject mocks via __setInboundHooksForTest.
 */
export function setInboundHooks(hooks: InboundHandlerHooks): void {
  _hooks = hooks;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

export function extractSlugFromTo(toField: string | string[] | undefined): string | null {
  if (!toField) return null;
  const first = Array.isArray(toField) ? toField[0] : toField;
  if (typeof first !== "string") return null;
  // Strip display name if present: "Name <slug@domain>" → "slug@domain"
  const match = first.match(/<([^>]+)>/) ?? [null, first];
  const addr = match[1] ?? first;
  const at = addr.indexOf("@");
  if (at < 1) return null;
  return addr.slice(0, at).trim();
}

type FromField = string | { email?: string; name?: string } | undefined;

export function extractFromAddress(fromField: FromField): { email: string; name: string | null } | null {
  if (!fromField) return null;
  if (typeof fromField === "string") {
    const match = fromField.match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/);
    if (match) {
      return { email: match[2].trim(), name: (match[1] ?? "").trim() || null };
    }
    return { email: fromField.trim(), name: null };
  }
  if (typeof fromField === "object" && fromField !== null && typeof (fromField as { email?: string }).email === "string") {
    return {
      email: (fromField as { email: string }).email.trim(),
      name: ((fromField as { name?: string }).name ?? "").trim() || null,
    };
  }
  return null;
}

export function splitDisplayName(name: string | null): { firstName: string | null; lastName: string | null } {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function isAnonymousDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return true;
  // Anonymous = no second-level domain (single-label hosts) OR known
  // free-form anonymous services.
  if (!domain.includes(".")) return true;
  const ANONYMOUS_DOMAINS = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com"]);
  return ANONYMOUS_DOMAINS.has(domain);
}

// ─────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────

resendInboundWebhookApp.post(
  "/",
  buildSvixMiddleware({ signingSecret: env.RESEND_INBOUND_WEBHOOK_SIGNING_SECRET }),
  async (c) => {
  const svix = getSvixContext(c);
  const payload = svix.payload as unknown as ResendInboundPayload;

  if (payload.type !== "email.received") {
    logger.info({ type: payload.type }, "[resend-inbound] non-receive event — ignoring");
    return c.text("OK", 200);
  }

  const data = payload.data ?? {};
  const resendEmailId = data.email_id ?? null;
  const slug = extractSlugFromTo(data.to);
  const inboxAddress = Array.isArray(data.to) ? data.to[0] : data.to ?? "";
  const fromParsed = extractFromAddress(data.from);
  const fromAddress = fromParsed?.email ?? "unknown";
  const subject = data.subject ?? null;
  const bodyPreview = (data.text ?? data.html ?? "").slice(0, BODY_PREVIEW_CAP) || null;
  const attachmentCount = Array.isArray(data.attachments) ? data.attachments.length : 0;
  const spfPass = data.spf?.pass === true;
  const dkimPass = data.dkim?.pass === true;
  // KAN-741 fix-forward (2026-05-02): the gate decision uses the EXPLICITLY-
  // FAILED signal, not the inverse of "pass". Resend Inbound's webhook payload
  // does not always populate `data.spf` / `data.dkim` (verified empirically:
  // 3 real-email smokes from Formspree / iCloud-via-mkze.vc / Outlook all
  // arrived without these fields and were silently rejected as
  // `rejected_spam`). When the field is absent, we trust Resend's upstream
  // SES-layer filtering — Resend would not webhook the email if SES considered
  // it spam. The gate now rejects only on EXPLICIT failure (pass === false).
  // The audit row still records `spfPass`/`dkimPass` as the boolean shape it
  // had before — `false` when the field is absent — preserving forensic
  // signal in `lead_inbox_events.spf_pass` / `dkim_pass` columns.
  const spfExplicitlyFailed = data.spf?.pass === false;
  const dkimExplicitlyFailed = data.dkim?.pass === false;

  // ── Redis short-window dedup
  if (resendEmailId) {
    const redisKey = `${IDEMPOTENCY_KEY_PREFIX}${resendEmailId}`;
    try {
      const existing = await getRedis().set(redisKey, "1", "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
      if (existing === null) {
        logger.info({ resendEmailId }, "[resend-inbound] duplicate (redis)");
        return c.text("OK", 200);
      }
    } catch (err) {
      logger.warn({ err }, "[resend-inbound] redis dedup failed — fail-open");
    }
  }

  // ── Resolve tenant from slug
  if (!slug) {
    await safeWriteAuditRow({
      tenantId: "00000000-0000-0000-0000-000000000000",
      inboxAddress,
      resendEmailId,
      fromAddress,
      subject,
      bodyPreview,
      attachmentCount,
      spfPass,
      dkimPass,
      status: "rejected_unknown_slug",
      rejectionReason: "to address has no slug",
      createdContactId: null,
    });
    return c.text("OK", 200);
  }

  const tenant = await getHooks().resolveTenantBySlug(slug).catch((err: unknown) => {
    logger.error({ err, slug }, "[resend-inbound] tenant resolve failed");
    return null;
  });
  if (!tenant) {
    await safeWriteAuditRow({
      tenantId: "00000000-0000-0000-0000-000000000000",
      inboxAddress,
      resendEmailId,
      fromAddress,
      subject,
      bodyPreview,
      attachmentCount,
      spfPass,
      dkimPass,
      status: "rejected_unknown_slug",
      rejectionReason: `slug "${slug}" not registered`,
      createdContactId: null,
    });
    return c.text("OK", 200);
  }

  // ── SPF/DKIM enforcement
  if (!fromParsed || isAnonymousDomain(fromParsed.email)) {
    await safeWriteAuditRow({
      tenantId: tenant.id,
      inboxAddress,
      resendEmailId,
      fromAddress,
      subject,
      bodyPreview,
      attachmentCount,
      spfPass,
      dkimPass,
      status: "rejected_unverified",
      rejectionReason: "anonymous or malformed sender domain",
      createdContactId: null,
    });
    return c.text("OK", 200);
  }

  if (spfExplicitlyFailed) {
    await safeWriteAuditRow({
      tenantId: tenant.id,
      inboxAddress,
      resendEmailId,
      fromAddress,
      subject,
      bodyPreview,
      attachmentCount,
      spfPass,
      dkimPass,
      status: "rejected_spam",
      rejectionReason: "SPF check failed",
      createdContactId: null,
    });
    return c.text("OK", 200);
  }

  // DKIM strict mode (default): reject only on EXPLICIT DKIM=fail.
  // Pre-KAN-741-fix-forward, this rejected DKIM=fail AND DKIM=none under
  // strict mode. Empirically Resend's payload omits `dkim` for most emails;
  // treating "none" as "fail" rejected 100% of real inbound. Now: explicit
  // `dkim.pass === false` is the only DKIM-strict rejection signal. If the
  // field is absent, trust Resend's upstream filtering.
  if (tenant.inboxDkimStrict && dkimExplicitlyFailed) {
    await safeWriteAuditRow({
      tenantId: tenant.id,
      inboxAddress,
      resendEmailId,
      fromAddress,
      subject,
      bodyPreview,
      attachmentCount,
      spfPass,
      dkimPass,
      status: "rejected_spam",
      rejectionReason: "DKIM check failed (strict mode)",
      createdContactId: null,
    });
    return c.text("OK", 200);
  }

  // ── Contact upsert + audit + publish
  const { firstName, lastName } = splitDisplayName(fromParsed.name);
  const contact = await getHooks().upsertContactFromEmail({
    tenantId: tenant.id,
    email: fromParsed.email,
    firstName,
    lastName,
  });

  await safeWriteAuditRow({
    tenantId: tenant.id,
    inboxAddress,
    resendEmailId,
    fromAddress,
    subject,
    bodyPreview,
    attachmentCount,
    spfPass,
    dkimPass,
    status: "accepted",
    rejectionReason: null,
    createdContactId: contact.id,
  });

  const event = buildLeadReceivedEvent({
    eventId: `evt_${randomUUID()}`,
    tenantId: tenant.id,
    contactId: contact.id,
    source: "inbox_email",
    metadata: {
      fromAddress: fromParsed.email,
      subject: subject ?? undefined,
      bodyPreview: bodyPreview ?? undefined,
      attachmentCount,
    },
  });

  try {
    await getHooks().publishLeadReceived(event);
  } catch (err) {
    logger.error({ err, eventId: event.eventId }, "[resend-inbound] lead.received publish failed");
    // Audit row already written. Resend doesn't retry on 2xx so we accept
    // the publish failure as recoverable via downstream audit consumers.
  }

  return c.text("OK", 200);
});

async function safeWriteAuditRow(row: LeadInboxEventRow): Promise<void> {
  try {
    await getHooks().writeLeadInboxEvent(row);
  } catch (err) {
    logger.error({ err, status: row.status }, "[resend-inbound] writeLeadInboxEvent failed");
  }
}

/**
 * Default-publish helper — publishes via @google-cloud/pubsub direct topic
 * client. Bypasses the connector-contracts publishEvent wrapper because
 * lead.received isn't yet in the discriminated-union schema there. Event
 * payload is validated by LeadReceivedEventSchema in @growth/shared at
 * buildLeadReceivedEvent time, so the wrapper's validation step would be
 * redundant.
 */
export async function defaultPublishLeadReceived(event: LeadReceivedEvent): Promise<string> {
  const data = Buffer.from(JSON.stringify(event));
  const messageId = await getPubSubClient().topic(LEAD_RECEIVED_TOPIC).publishMessage({
    data,
    attributes: {
      eventType: event.eventType,
      tenantId: event.tenantId,
      contactId: event.contactId,
      source: event.source,
      version: event.version,
    },
  });
  logger.debug({ topic: LEAD_RECEIVED_TOPIC, messageId, eventId: event.eventId }, "lead.received published");
  return messageId;
}
