/**
 * KAN-954 — Resend inbound email body / metadata hydration.
 *
 * Resend's `email.received` webhook payload is metadata-only (verified
 * against the docs at https://resend.com/docs/webhooks/emails/received.md
 * and empirically — all 8 pre-KAN-954 `lead_inbox_events` rows had
 * `body_preview` length 0). To get `text` / `html` / `reply_to[]` / `headers`,
 * the handler must call the Receiving API:
 *
 *     GET https://api.resend.com/emails/receiving/{email_id}
 *
 * This module is the thin REST client. It's pure I/O + JSON decode — no
 * parsing, no business logic. Parsing lives in
 * `apps/connectors/src/parsers/formspree-email.ts`; the webhook handler
 * orchestrates the call → parse → upsert chain.
 *
 * Auth: uses RESEND_API_KEY_RW (separate from the send-only RESEND_API_KEY;
 * the send-only key returns 401 on read). See `env.ts` for binding shape.
 *
 * Failure mode: any non-2xx response or network error returns null. The
 * caller MUST fall through to the current empty-body path on null — never
 * drop the lead.
 */
import { logger } from "../../logger.js";

const RECEIVING_BASE = "https://api.resend.com/emails/receiving";
const FETCH_TIMEOUT_MS = 5000;

export interface InboundEmailContent {
  text: string | null;
  html: string | null;
  // Reply-To addresses. Formspree sets this to the form submitter; for
  // non-Formspree mail it may be empty or echo the From address.
  replyTo: string[];
  // Lower-cased header keys → string values. (Resend may also return a
  // hash with mixed-case keys; we normalize to lower-case here so callers
  // can lookup deterministically.)
  headers: Record<string, string>;
  // Direct echo of useful Resend fields for downstream logging.
  messageId: string | null;
}

/**
 * Fetch the body + headers of a received inbound email via the Resend
 * Receiving API. Returns null on any failure (4xx, 5xx, network, timeout,
 * malformed JSON) — caller falls through to empty-body behavior.
 */
export async function fetchInboundEmailContent(
  emailId: string,
  apiKey: string | undefined,
): Promise<InboundEmailContent | null> {
  if (!apiKey) {
    logger.warn(
      { emailId },
      "[resend-inbound-fetch] RESEND_API_KEY_RW unset — skipping body hydration",
    );
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${RECEIVING_BASE}/${encodeURIComponent(emailId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn(
        { emailId, status: res.status },
        "[resend-inbound-fetch] non-2xx from Resend Receiving API",
      );
      return null;
    }

    const json = (await res.json()) as Record<string, unknown>;

    // Headers come back as a key/value object. Normalize keys to lower-case.
    // Resend has been observed to send `reply-to` as a header AND `reply_to`
    // as a top-level array; we trust the top-level array (typed) primarily.
    const headersRaw = (json.headers ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersRaw)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }

    const replyToRaw = json.reply_to;
    const replyTo: string[] = Array.isArray(replyToRaw)
      ? replyToRaw.filter((x): x is string => typeof x === "string")
      : [];

    return {
      text: typeof json.text === "string" ? json.text : null,
      html: typeof json.html === "string" ? json.html : null,
      replyTo,
      headers,
      messageId: typeof json.message_id === "string" ? json.message_id : null,
    };
  } catch (err) {
    logger.warn(
      { emailId, err },
      "[resend-inbound-fetch] fetch threw — falling back to empty body",
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
