/**
 * Send-redirect guardrail — founder mandate 2026-05-25.
 *
 * The final recipient override. Sits BELOW every other safety control
 * (kill-switch, send-policy, threshold-gate). Even an approved, executed
 * send gets redirected to the founder's test contacts while this is on.
 *
 * Defaults: ENABLED=true. Disabling for real production sends is an
 * explicit env change (SEND_REDIRECT_ENABLED=false), documented in
 * deploy-connectors.yml — same posture as the autoApproveEnabled
 * kill-switch.
 *
 * Fail-closed: when ENABLED=true and the channel-target is missing/empty,
 * applyRedirect THROWS — the caller (adapter) returns/propagates and
 * the subscriber logs+ACKs. Never falls through to the real recipient.
 *
 * Unbypassable enforcement: the no-bypass CI gate at
 *   adapters/_shared/__tests__/send-redirect-no-bypass.test.ts
 * scans every provider SDK call site under apps/connectors/src/adapters
 * and apps/api/src/integrations and fails CI if any provider call (Resend
 * emails.send / Twilio client.messages.create / FB Graph fetch) is not
 * preceded by an applyRedirect call in the same function.
 */
import type { ChannelType, OutboundMessage } from '@growth/connector-contracts';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

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
 * Apply the redirect to an OutboundMessage. Pure transform (plus one
 * structured log line as a side-effect). Returns a NEW message object;
 * never mutates the input.
 *
 * MUST be called as the FIRST line of every ChannelAdapter.send()
 * implementation — before any recipient validation, suppression check,
 * or provider SDK call. The structural no-bypass CI gate enforces this.
 *
 * @throws SendRedirectMisconfiguredError when ENABLED=true and the
 *   channel's target env is missing — fail-closed, never falls through.
 */
export function applyRedirect(
  msg: OutboundMessage,
  channel: ChannelType,
): OutboundMessage {
  if (!env.SEND_REDIRECT_ENABLED) {
    // Explicit production disable — log a single line per send so PROD
    // audit trail shows the guard was off when this message went out.
    // Same loud-signal posture as autoApproveEnabled.
    logger.warn(
      {
        type: 'send_redirect_disabled',
        channel,
        actionId: msg.actionId,
        tenantId: msg.tenantId,
        recipient: { email: msg.recipient.email, phone: msg.recipient.phone },
      },
      '[SEND_REDIRECT_ENABLED=false] guard OFF — message going to real recipient',
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
