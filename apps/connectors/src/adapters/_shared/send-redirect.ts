/**
 * Send-redirect guardrail — founder mandate 2026-05-25; M2-6a per-tenant
 * extension 2026-05-27.
 *
 * The final recipient override. Sits BELOW every other safety control
 * (kill-switch, send-policy, threshold-gate). Even an approved, executed
 * send gets redirected to the founder's test contacts when redirect is on.
 *
 * # KAN-1005 M2-6a precedence ladder (sharpened from KAN-1030 single-env)
 *
 * Read at every send time (NOT snapshotted at decision time — incident
 * flip TO redirect-ON honors in-flight Pub/Sub-queued messages):
 *
 *   1. env.SEND_REDIRECT_ENABLED === true (incl. unset → default true)
 *        → redirect-ON globally (master force-ON / incident lever)
 *
 *   2. env.SEND_REDIRECT_ENABLED === false (explicit production posture)
 *        → consult Tenant.sendRedirectEnabled per-tenant:
 *           true  → redirect-ON (tenant explicit)
 *           false → real send (tenant explicit, KAN-808-gated go-live)
 *
 *   3. Any failure (missing tenantId / DB error / row not found)
 *        → redirect-ON (FAIL-SAFE, hardcoded, ignores env)
 *
 * Single env var by design (founder decision 2026-05-27 — refining the
 * Phase-1 proposal). No SEND_REDIRECT_FORCE_GLOBAL second var; that
 * would create a redundant control surface that can drift out of sync.
 * One control, one meaning: "force redirect globally; when off, per-
 * tenant governs."
 *
 * # Today's PROD state (M2-6a merge day)
 *
 * env.SEND_REDIRECT_ENABLED=true → step 1 fires for every send → every
 * tenant redirects. Zero behavioral change at merge. The new column
 * defaults to true so any future env flip still defaults safe.
 *
 * # Fail-closed: when redirect is ON and the channel-target env is
 * missing/empty, applyRedirect THROWS SendRedirectMisconfiguredError.
 * The caller (adapter) propagates; the subscriber logs+ACKs. Never
 * falls through to the real recipient.
 *
 * # Unbypassable enforcement: the no-bypass CI gate at
 *   adapters/_shared/__tests__/send-redirect-no-bypass.test.ts
 * scans every provider SDK call site under apps/connectors/src/adapters
 * and apps/api/src/integrations and fails CI if any provider call
 * (Resend emails.send / Twilio client.messages.create / FB Graph fetch)
 * is not preceded by an applyRedirect call in the same function.
 *
 * # Caching: deliberately NONE. Single indexed-PK lookup per send is
 * cheap at current volume. Caching would let a real-send disposition
 * linger after a panic-flip-to-ON, which is anti-safety. When scale
 * eventually demands a cache, the design constraint is: the cache must
 * NEVER delay a flip TO redirect-ON (TTL-bounded staleness only on
 * flip-to-real, never on flip-to-redirect). Follow-up.
 */
import { PrismaClient } from '@prisma/client';
import type { ChannelType, OutboundMessage } from '@growth/connector-contracts';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

// ─────────────────────────────────────────────
// KAN-1005 M2-6a — Prisma singleton for the per-tenant lookup.
// Mirrors apps/connectors/src/repository/connection-repository.ts:7
// pattern (module-level new PrismaClient()). Lightweight; one client per
// connectors container is plenty for this read load.
// ─────────────────────────────────────────────
let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!_prisma) _prisma = new PrismaClient();
  return _prisma;
}

/**
 * Test seam: inject a PrismaClient mock so unit tests can exercise the
 * DB-lookup branches without spinning a real client. Resets to null →
 * the next getPrisma() will lazy-init.
 */
export function __setPrismaForTest(client: PrismaClient | null): void {
  _prisma = client;
}

/**
 * Misconfiguration error — throw when SEND_REDIRECT_ENABLED=true and
 * the channel-appropriate target env is missing. The subscriber catches,
 * logs the structured alert, and ACKs (no retry — a missing redirect
 * target is persistent until env is fixed; retrying just storms).
 *
 * Sibling to the KAN-1018 "persistent → ack, no retry" posture.
 */
export class SendRedirectMisconfiguredError extends Error {
  constructor(
    public readonly channel: ChannelType,
    public readonly missingEnv: string,
  ) {
    super(
      `[SEND_REDIRECT_ENABLED=true] missing ${missingEnv} for channel=${channel} — refusing to fall through to real recipient. ` +
        `Set the env var OR explicitly set SEND_REDIRECT_ENABLED=false (production-only, documented decision).`,
    );
    this.name = 'SendRedirectMisconfiguredError';
  }
}

const REDIRECT_PREFIX_EMAIL_SUBJECT = '[TEST REDIRECT — intended: '; // closing bracket appended with recipient
const REDIRECT_PREFIX_SMS_BODY = '[TEST REDIRECT] ';

/** Banner prepended to email body (HTML + plain text). */
function emailBannerHtml(originalEmail: string): string {
  // Inline-styled so it survives any aggressive CSS-stripping client.
  return (
    `<div style="background:#fff3cd;border:1px solid #ffeeba;padding:10px 12px;` +
    `font-family:sans-serif;font-size:13px;color:#856404;margin-bottom:12px;">` +
    `<strong>⚠ TEST REDIRECT</strong> — this message was intended for ` +
    `<code>${escapeHtml(originalEmail)}</code> ` +
    `but the SEND_REDIRECT guardrail rerouted it to the founder's test inbox. ` +
    `If you're not Frédéric, you weren't supposed to see this.` +
    `</div>`
  );
}

function emailBannerText(originalEmail: string): string {
  return (
    `===== TEST REDIRECT =====\n` +
    `Intended recipient: ${originalEmail}\n` +
    `Rerouted to the founder's test inbox by the SEND_REDIRECT guardrail.\n` +
    `=========================\n\n`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * KAN-1005 M2-6a — per-tenant lookup. Reads Tenant.sendRedirectEnabled.
 * Returns the column value when the row exists; returns `null` on any
 * failure (DB error, row not found, missing tenantId). The caller maps
 * `null` → redirect-ON (fail-safe).
 *
 * Read at every send time. NO caching by design — see module docstring.
 */
async function readTenantRedirectDisposition(
  tenantId: string | undefined,
): Promise<boolean | null> {
  if (!tenantId) return null;
  try {
    const tenant = await getPrisma().tenant.findUnique({
      where: { id: tenantId },
      select: { sendRedirectEnabled: true },
    });
    if (!tenant) return null;
    return tenant.sendRedirectEnabled;
  } catch (err) {
    logger.error(
      {
        type: 'send_redirect_tenant_lookup_failed',
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      },
      '[send-redirect] tenant lookup failed — fail-safe redirect-ON',
    );
    return null;
  }
}

/**
 * Resolve the effective redirect disposition using the precedence ladder
 * (see module docstring). Returns true when redirect-ON, false when
 * real-send. Pure function over the inputs; safe to call without DB.
 *
 * Exported for unit-level testing of the precedence semantics.
 */
export function resolveRedirectDisposition(opts: {
  envEnabled: boolean;
  tenantDisposition: boolean | null;
}): { redirectOn: boolean; reason: string } {
  // 1. Global force-ON master (env). When true → redirect-ON regardless
  //    of per-tenant value. This is the merge-day path (PROD env=true)
  //    AND the incident-response panic switch.
  if (opts.envEnabled) {
    return { redirectOn: true, reason: 'env_force_global' };
  }
  // 2. env explicitly false → per-tenant column governs.
  if (opts.tenantDisposition === true) {
    return { redirectOn: true, reason: 'tenant_explicit_true' };
  }
  if (opts.tenantDisposition === false) {
    return { redirectOn: false, reason: 'tenant_explicit_false' };
  }
  // 3. Fail-safe: missing tenantId / DB error / row not found.
  //    Hardcoded redirect-ON. Ignores env (already false here) — the
  //    safety direction overrides the production posture when we can't
  //    determine the tenant's intent.
  return { redirectOn: true, reason: 'fail_safe_no_tenant_disposition' };
}

/**
 * Apply the redirect to an OutboundMessage. Pure transform (plus one
 * structured log line and at most one DB read as side-effects). Returns
 * a NEW message object; never mutates the input.
 *
 * MUST be called as the FIRST line of every ChannelAdapter.send()
 * implementation — before any recipient validation, suppression check,
 * or provider SDK call. The structural no-bypass CI gate enforces this.
 *
 * KAN-1005 M2-6a — now ASYNC (was sync pre-M2-6a). Every caller awaits.
 *
 * @throws SendRedirectMisconfiguredError when redirect-ON and the
 *   channel's target env is missing — fail-closed, never falls through.
 */
export async function applyRedirect(
  msg: OutboundMessage,
  channel: ChannelType,
): Promise<OutboundMessage> {
  // KAN-1005 M2-6a — read per-tenant disposition ONLY when env force-ON
  // is OFF. Skips the DB read entirely on the merge-day / incident path
  // (no perf cost when env globally forces redirect). When env is false,
  // the per-tenant column governs and the DB read fires.
  const tenantDisposition = env.SEND_REDIRECT_ENABLED
    ? null
    : await readTenantRedirectDisposition(msg.tenantId);

  const resolution = resolveRedirectDisposition({
    envEnabled: env.SEND_REDIRECT_ENABLED,
    tenantDisposition,
  });

  if (!resolution.redirectOn) {
    // Explicit per-tenant real-send (env=false AND tenant=false). Log a
    // single line per send so PROD audit trail shows the guard was off
    // when this message went out. Same loud-signal posture as
    // autoApproveEnabled. PRECONDITION (founder discipline): no tenant
    // in PROD has sendRedirectEnabled=false unless KAN-808 (CAN-SPAM/
    // CASL compliance) is verified live for that tenant.
    logger.warn(
      {
        type: 'send_redirect_disabled',
        channel,
        actionId: msg.actionId,
        tenantId: msg.tenantId,
        reason: resolution.reason,
        recipient: { email: msg.recipient.email, phone: msg.recipient.phone },
      },
      '[send-redirect] guard OFF (tenant_explicit_false) — message going to real recipient',
    );
    return msg;
  }

  if (channel === 'EMAIL') {
    const originalEmail = msg.recipient.email ?? '(no original email on message)';
    const target = env.SEND_REDIRECT_EMAIL;
    if (!target) {
      throw new SendRedirectMisconfiguredError(channel, 'SEND_REDIRECT_EMAIL');
    }
    const redirected: OutboundMessage = {
      ...msg,
      recipient: {
        ...msg.recipient,
        email: target,
        // Clear displayName so the To: header reads as the test inbox,
        // not "Real Customer <fred@axisone.ca>" which is misleading.
        displayName: undefined,
      },
      content: {
        ...msg.content,
        subject: `${REDIRECT_PREFIX_EMAIL_SUBJECT}${originalEmail}] ${msg.content.subject ?? '(no subject)'}`,
        body: emailBannerText(originalEmail) + msg.content.body,
        html: msg.content.html
          ? emailBannerHtml(originalEmail) + msg.content.html
          : emailBannerHtml(originalEmail) + `<pre>${escapeHtml(msg.content.body)}</pre>`,
      },
    };
    logger.info(
      {
        type: 'send_redirected',
        channel,
        actionId: msg.actionId,
        tenantId: msg.tenantId,
        originalRecipient: originalEmail,
        redirectedTo: target,
        // KAN-1005 M2-6a — precedence-attribution. Audit can grep
        // which of the 3 ladder rules fired.
        reason: resolution.reason,
      },
      'send_redirected',
    );
    return redirected;
  }

  if (channel === 'SMS' || channel === 'WHATSAPP') {
    const originalPhone = msg.recipient.phone ?? '(no original phone on message)';
    const target = env.SEND_REDIRECT_PHONE;
    if (!target) {
      throw new SendRedirectMisconfiguredError(channel, 'SEND_REDIRECT_PHONE');
    }
    const redirected: OutboundMessage = {
      ...msg,
      recipient: {
        ...msg.recipient,
        phone: target,
        displayName: undefined,
      },
      content: {
        ...msg.content,
        // Short prefix only — SMS 160-char budget. Full originalRecipient
        // lives in the structured log below (and the action audit row).
        body: REDIRECT_PREFIX_SMS_BODY + msg.content.body,
      },
    };
    logger.info(
      {
        type: 'send_redirected',
        channel,
        actionId: msg.actionId,
        tenantId: msg.tenantId,
        originalRecipient: originalPhone,
        redirectedTo: target,
        reason: resolution.reason,
      },
      'send_redirected',
    );
    return redirected;
  }

  // MESSENGER (or any future channel) — fail-closed. No target env defined
  // for non-email/non-phone channels in M1. If/when Messenger returns as
  // a proper ChannelAdapter, define SEND_REDIRECT_MESSENGER_PAGE_ID + a
  // case here.
  throw new SendRedirectMisconfiguredError(
    channel,
    `(no SEND_REDIRECT_* target defined for channel=${channel})`,
  );
}
