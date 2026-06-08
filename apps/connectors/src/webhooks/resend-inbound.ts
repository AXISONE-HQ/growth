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
import { fetchInboundEmailContent, type InboundEmailContent } from "../adapters/resend/inbound-fetch.js";
import { detectAutoresponder } from "./autoresponder-filter.js";
// KAN-1140 Phase 1 PR 4 — Vendor detection via the plugin registry. The
// webhook handler is vendor-agnostic; per-vendor detection + extraction
// lives in vendor-handlers/*. Formspree is registered as the first live
// handler; Tally/Typeform/Webflow stubs follow as templates.
import {
  vendorRegistry,
  type VendorHandler,
  type VendorExtraction,
} from "../parsers/registry.js";
// KAN-1140 Phase 1 PR 1 — Format detection + per-format pre-parsers.
// Runs after Formspree check (vendor-specific path wins); detection result
// is stashed in customFields (_kan_1140_format, _kan_1140_confidence) per
// Q6 disposition (c) until Phase 3 confidence-escalation queue lands.
import { detectEmailFormat } from "../parsers/format-detector.js";
import { parseAdfEmail } from "../parsers/adf-parser.js";
import { parseHtmlEmail } from "../parsers/html-email-parser.js";
import { parsePlainTextEmail } from "../parsers/plain-text-email-parser.js";

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
  /**
   * KAN-954 — extended with optional `companyName` + `source` so
   * Formspree-parsed leads can write firstName/lastName/companyName/source.
   * Form-field bag (role / monthlyLeadVolume / biggestPain) is NOT passed
   * here because Contact has no customFields column — those fields flow
   * through LeadReceivedEvent.metadata.customFields and land on Deal in
   * the consumer.
   */
  upsertContactFromEmail: (input: {
    tenantId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    companyName?: string | null;
    source?: "email_inbox" | "web_form";
  }) => Promise<{ id: string }>;
  writeLeadInboxEvent: (row: LeadInboxEventRow) => Promise<void>;
  publishLeadReceived: (event: LeadReceivedEvent) => Promise<string>;
  /**
   * KAN-954 — hydrate body / reply_to / headers via the Resend Receiving
   * API. Optional hook so tests can mock without hitting real fetch().
   * The default production wiring uses `fetchInboundEmailContent` from
   * `../adapters/resend/inbound-fetch.js`.
   */
  fetchEmailContent?: (emailId: string) => Promise<InboundEmailContent | null>;
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
  // KAN-1037-PR2 — `rejected_autoresponder` added: machine-generated reply
  // detected by `detectAutoresponder` (RFC 3834 headers, sender local-part,
  // subject/body patterns). The Contact upsert still runs; only the
  // `lead.received` Pub/Sub publish is skipped. `rejectionReason` carries
  // the signal-specific tag for forensic grep.
  status: "received" | "rejected_spam" | "rejected_unverified" | "rejected_unknown_slug" | "rejected_autoresponder" | "accepted";
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

/**
 * KAN-1036 — parse the inbound's To: field into {slug, replyToken}.
 *
 * The slug-only path (pre-KAN-1036) was driving tenant lookup via
 * `resolveTenantBySlug`. For subaddress-anchored reply correlation, we
 * split the local-part on `+` to recover the slug (still the tenant key)
 * AND the per-decision token (passed downstream via LeadReceivedEvent
 * metadata so lead-received-push can correlate against
 * engagement_email_metadata.reply_token).
 *
 * Token shape validation: 16-char hex per producer. Tokens that fail
 * the regex are rejected (returned as null) — defends against
 * accidentally-correlated inbounds where a recipient manually typed a
 * recipient with `+something` that isn't one of our tokens.
 *
 * Tenant lookup remains slug-only — the token is forensic at the
 * webhook layer; correlation happens at the consumer.
 */
export function extractSlugAndToken(
  toField: string | string[] | undefined,
): { slug: string; replyToken: string | null } | null {
  if (!toField) return null;
  const first = Array.isArray(toField) ? toField[0] : toField;
  if (typeof first !== "string") return null;
  // Strip display name if present: "Name <slug@domain>" → "slug@domain"
  const match = first.match(/<([^>]+)>/) ?? [null, first];
  const addr = match[1] ?? first;
  const at = addr.indexOf("@");
  if (at < 1) return null;
  const localPart = addr.slice(0, at).trim();
  const plusIdx = localPart.indexOf("+");
  if (plusIdx < 0) {
    return { slug: localPart, replyToken: null };
  }
  const slug = localPart.slice(0, plusIdx);
  const candidate = localPart.slice(plusIdx + 1);
  // Token shape pin — 16-char hex per producer (resolveReplyToForTenant).
  // Anything else: user-typed `+foo`, mangled by an exotic gateway, or
  // garbage. Return slug-only and let the consumer's `if (replyToken)`
  // guard miss the correlation lookup gracefully.
  if (!/^[0-9a-f]{16}$/.test(candidate)) {
    return { slug, replyToken: null };
  }
  return { slug, replyToken: candidate };
}

/**
 * Pre-KAN-1036 helper — returns the full local-part (slug+subaddress)
 * as a single string. Kept shipped for back-compat with any external
 * call sites or tests that still expect the old shape. Production
 * webhook handler uses `extractSlugAndToken` (KAN-1036) instead.
 *
 * @deprecated Use `extractSlugAndToken` for the slug + token split.
 */
export function extractSlugFromTo(toField: string | string[] | undefined): string | null {
  const parsed = extractSlugAndToken(toField);
  return parsed?.slug ?? null;
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
  // KAN-1036 — split data.to local-part on `+` to recover slug + per-decision
  // reply correlation token. Tenant lookup remains slug-only; the token is
  // propagated downstream via LeadReceivedEvent.metadata.replyToken so
  // lead-received-push correlates against engagement_email_metadata.reply_token.
  const parsedTo = extractSlugAndToken(data.to);
  const slug = parsedTo?.slug ?? null;
  const replyToken = parsedTo?.replyToken ?? null;
  const inboxAddress = Array.isArray(data.to) ? data.to[0] : data.to ?? "";
  const fromParsed = extractFromAddress(data.from);
  const fromAddress = fromParsed?.email ?? "unknown";
  const subject = data.subject ?? null;
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

  // ── KAN-954 — hydrate body / reply_to / headers via Resend Receiving API.
  // Webhook payload is metadata-only — bodyPreview is empty without this
  // fetch. Applies to ALL inbound (not Formspree-specific); the Formspree
  // parser sits on top. Fail-open: null result on any failure falls through
  // to current empty-body behavior (no regression for direct inbound).
  let fetchedContent: InboundEmailContent | null = null;
  if (resendEmailId) {
    const fetchHook = getHooks().fetchEmailContent;
    fetchedContent = fetchHook
      ? await fetchHook(resendEmailId).catch((err: unknown) => {
          logger.warn({ err, resendEmailId }, "[resend-inbound] fetch hook threw");
          return null;
        })
      : await fetchInboundEmailContent(resendEmailId, env.RESEND_API_KEY_RW);
  }
  // bodyPreview now sources from the fetched text (Formspree + every other
  // inbound), falling back to the legacy webhook-payload fields if the
  // Receiving API isn't reachable.
  const bodyPreview =
    (fetchedContent?.text ?? fetchedContent?.html ?? data.text ?? data.html ?? "")
      .slice(0, BODY_PREVIEW_CAP) || null;

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

  // ── KAN-954 / KAN-1140 PR 4 — Vendor-detection dispatch via the plugin
  // registry. Every registered handler's detect() is consulted first-match-
  // wins; on match, extract() returns the normalized VendorExtraction shape
  // (uniform across vendors). Handlers return null on extraction failure —
  // null path falls through to legacy From-keyed identity (mis-attributed
  // but flagged). NEVER drops a lead.
  let vendorMatch: VendorHandler | null = null;
  let vendorExtraction: VendorExtraction | null = null;
  const vendorDetectionPayload = {
    fromHeader: fromParsed.email,
    subject,
    text: fetchedContent?.text ?? null,
  };
  vendorMatch = vendorRegistry.detect(vendorDetectionPayload);
  if (vendorMatch) {
    vendorExtraction = vendorMatch.extract({
      ...vendorDetectionPayload,
      replyTo: fetchedContent?.replyTo ?? [],
    });
    if (!vendorExtraction) {
      logger.warn(
        { resendEmailId, fromAddress, subject, vendor: vendorMatch.name },
        "[resend-inbound] vendor detection fired but extraction failed — falling back to mis-attributed Contact",
      );
    }
  }

  // ── Contact upsert + audit + publish
  // Identity selection: vendor-extracted values when available; otherwise
  // the legacy From-header values. Either path produces a Contact row + a
  // lead.received event — fallback is "mis-attributed but landed," never
  // dropped.
  const { firstName: legacyFirst, lastName: legacyLast } = splitDisplayName(fromParsed.name);
  const identity = vendorExtraction
    ? {
        email: vendorExtraction.senderEmail,
        firstName: vendorExtraction.firstName ?? null,
        lastName: vendorExtraction.lastName ?? null,
        companyName: vendorExtraction.companyName ?? null,
        source: "web_form" as const,
      }
    : {
        email: fromParsed.email,
        firstName: legacyFirst,
        lastName: legacyLast,
        companyName: null,
        source: undefined,
      };

  const contact = await getHooks().upsertContactFromEmail({
    tenantId: tenant.id,
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
    companyName: identity.companyName,
    source: identity.source,
  });

  // ── KAN-1037-PR2 — autoresponder / OOO / mailer-daemon filter.
  // Runs after Contact upsert (so the operator still sees the inbound
  // identity in the audit trail) but BEFORE the `lead.received` publish.
  // Detect-and-drop at the webhook layer keeps machine-generated replies
  // out of the engine's view + structurally rules out engine ↔ responder
  // ping-pong post-PR3 (`contact.replied` event). False-negative-tolerant
  // posture: occasional dropped genuine reply degrades to today's pre-
  // filter behavior; under-filtering would waste inference + risk loops.
  //
  // Skip entirely on ANY vendor-detected inbound: form submissions are
  // user-initiated form fills, NOT machine-generated email replies. The
  // envelope From is the vendor's relay (e.g., `noreply@formspree.io`),
  // which the sender-local-part denylist would false-positive on every
  // single form submission. Even if a vendor relay carried autoresponder
  // headers/body, the engine consumes form_fill source events differently
  // (vendor → web_form path, not the contact-replied loop), so the filter
  // is structurally irrelevant.
  //
  // KAN-1140 PR 4 — gate on the vendor registry's match result so any
  // registered vendor (current: Formspree; future: Tally/Typeform/Webflow/
  // etc.) joins this skip automatically.
  //
  // Audit row reuses the existing `safeWriteAuditRow` writer with new
  // status `rejected_autoresponder` (status union extended at L146); the
  // `rejectionReason` field carries the signal-specific tag for forensic
  // grep (`header:auto-submitted=...`, `subject-pattern`, etc.).
  const autoresponderCheck = vendorMatch
    ? ({ filtered: false } as const)
    : detectAutoresponder({
        headers: fetchedContent?.headers ?? {},
        fromAddress: fromParsed.email,
        subject: subject ?? "",
        bodyText: fetchedContent?.text ?? "",
      });

  if (autoresponderCheck.filtered) {
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
      status: "rejected_autoresponder",
      rejectionReason: autoresponderCheck.reason,
      createdContactId: contact.id,
    });
    logger.info(
      {
        resendEmailId,
        contactId: contact.id,
        reason: autoresponderCheck.reason,
      },
      "[resend-inbound] inbound filtered as autoresponder — no lead.received publish",
    );
    return c.text("OK", 200);
  }

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

  // KAN-1140 Phase 1 PR 1 — Format-aware enrichment (skipped when any
  // vendor handler matched; vendor-specific extraction wins as the primary
  // source). Detection result is stashed in customFields (_kan_1140_format,
  // _kan_1140_confidence) per Q6 disposition (c) — wire schema extension
  // deferred to Phase 3 when the confidence-escalation queue lands.
  //
  // KAN-1140 PR 4 — gate updated from `!formspreeParsed` to
  // `!vendorExtraction` for vendor-agnostic precedence.
  let formatEnrichment: {
    vendor?: string;
    leadType?: string;
    dealName?: string;
    customFields?: Record<string, string>;
  } | null = null;
  if (!vendorExtraction && fetchedContent) {
    const detection = detectEmailFormat({
      text: fetchedContent.text,
      html: fetchedContent.html,
    });
    const baseCustomFields: Record<string, string> = {
      _kan_1140_format: detection.format,
      _kan_1140_confidence: detection.confidence,
    };

    if (detection.format === "adf" && fetchedContent.text) {
      const adfResult = parseAdfEmail({ text: fetchedContent.text });
      if (adfResult) {
        formatEnrichment = {
          vendor: "adf",
          leadType: "auto_lead",
          dealName: adfResult.dealNameSeed ?? undefined,
          customFields: { ...baseCustomFields, ...adfResult.customFields },
        };
      } else {
        formatEnrichment = { customFields: baseCustomFields };
      }
    } else if (
      (detection.format === "html" || detection.format === "html-in-text") &&
      (fetchedContent.html || fetchedContent.text)
    ) {
      const htmlBody = fetchedContent.html ?? fetchedContent.text ?? "";
      const htmlResult = parseHtmlEmail({ html: htmlBody });
      formatEnrichment = htmlResult
        ? { customFields: { ...baseCustomFields, ...htmlResult.customFields } }
        : { customFields: baseCustomFields };
    } else if (detection.format === "plain-text" && fetchedContent.text) {
      const plainResult = parsePlainTextEmail({ text: fetchedContent.text });
      formatEnrichment = plainResult
        ? { customFields: { ...baseCustomFields, ...plainResult.customFields } }
        : { customFields: baseCustomFields };
    } else {
      formatEnrichment = { customFields: baseCustomFields };
    }
  }

  // M3-2.5b — propagate raw Resend Receiving headers so the consumer can
  // sidecar-write + correlation-lookup. Raw form (`<id@domain>`, References
  // space-separated) is preserved on the wire for forensic value; the
  // consumer normalizes via @growth/shared's stripMessageIdBrackets +
  // parseReferencesHeader before lookup. Absent when fetchedContent is
  // null (Resend Receiving API unreachable) — consumer falls back to the
  // no-correlation path cleanly.
  const headersRaw = fetchedContent?.headers ?? {};
  const inboundHeaders =
    fetchedContent && (headersRaw["message-id"] || headersRaw["in-reply-to"] || headersRaw["references"])
      ? {
          ...(headersRaw["message-id"] ? { messageId: headersRaw["message-id"] } : {}),
          ...(headersRaw["in-reply-to"] ? { inReplyTo: headersRaw["in-reply-to"] } : {}),
          ...(headersRaw["references"] ? { references: headersRaw["references"] } : {}),
        }
      : undefined;

  const event = buildLeadReceivedEvent({
    eventId: `evt_${randomUUID()}`,
    tenantId: tenant.id,
    contactId: contact.id,
    source: "email_inbox",
    metadata: {
      // fromAddress remains the raw envelope From — preserves audit trail
      // (Formspree forwarded from `noreply@formspree.io`, even though the
      // Contact + dealName use the parsed real submitter identity).
      fromAddress: fromParsed.email,
      subject: subject ?? undefined,
      bodyPreview: bodyPreview ?? undefined,
      attachmentCount,
      // KAN-954 / KAN-1140 PR 4 — optional vendor-attribution + deal-naming
      // hints. Vendor path uses the normalized VendorExtraction shape
      // (uniform across Formspree/Tally/Typeform/future); format-enrichment
      // path (PR #304) populates only for non-vendor inbounds.
      // Pre-KAN-954 producers omit these; consumer falls back to defaults.
      ...(vendorExtraction
        ? {
            vendor: vendorExtraction.vendor,
            formSource: vendorExtraction.formSource ?? undefined,
            leadType: vendorExtraction.leadType ?? undefined,
            dealName: vendorExtraction.dealName,
            customFields: vendorExtraction.customFields,
          }
        : formatEnrichment
          ? {
              ...(formatEnrichment.vendor ? { vendor: formatEnrichment.vendor } : {}),
              ...(formatEnrichment.leadType ? { leadType: formatEnrichment.leadType } : {}),
              ...(formatEnrichment.dealName ? { dealName: formatEnrichment.dealName } : {}),
              ...(formatEnrichment.customFields &&
              Object.keys(formatEnrichment.customFields).length > 0
                ? { customFields: formatEnrichment.customFields }
                : {}),
            }
          : {}),
      ...(inboundHeaders ? { inboundHeaders } : {}),
      // KAN-1036 — per-decision reply correlation token from data.to
      // subaddress. NULL when the inbound's To: had no `+suffix`
      // (e.g., direct inbound to <slug>@<domain>) or when the suffix
      // didn't match the 16-char hex shape (e.g., user typed
      // `+something` manually). Consumer's `if (replyToken)` guard
      // skips the correlation lookup gracefully in both cases.
      ...(replyToken ? { replyToken } : {}),
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
