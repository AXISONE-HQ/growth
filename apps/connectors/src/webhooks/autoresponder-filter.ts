/**
 * KAN-1037-PR2 — Autoresponder / OOO / mailer-daemon filter.
 *
 * Pure synchronous helper invoked from `resend-inbound.ts` BEFORE the
 * `lead.received` Pub/Sub publish. Detect-and-drop at the webhook layer
 * prevents downstream engine consumers (post-PR3: `contact.replied` →
 * `decision.run`) from wasting inference on machine-generated replies,
 * and structurally rules out engine ↔ autoresponder ping-pong loops.
 *
 * Filter signals (highest confidence → lowest):
 *   1. RFC 3834 + MS-XAUTORESPONSE headers — `Auto-Submitted: auto-replied
 *      | auto-generated`, `Precedence: bulk | junk | list`,
 *      `X-Autoresponder` presence, `X-Auto-Response-Suppress` presence.
 *   2. Sender local-part denylist — bounce / noreply / mailer-daemon /
 *      postmaster / autoreply variants.
 *   3. Subject regex — EN ("Out of Office", "OOO", "Vacation", "Automatic
 *      Reply") + FR ("Absence du bureau", "Réponse automatique") for
 *      AxisOne's Canadian market.
 *   4. Body-text sentence patterns — common "I am out of the office until
 *      ..." phrasings in EN and FR.
 *
 * **Posture: false-negative-tolerant.** Better to occasionally drop a
 * genuine reply (degrades to today's pre-filter behavior: the engine
 * sees nothing, operator can spot the LeadInboxEvent with status
 * `rejected_autoresponder` and dismiss the false-positive) than to
 * under-filter (engine wastes inference, real risk of ping-pong loop
 * with the responder). PRD §7 risk register documents this trade-off.
 *
 * **Header keys assumption:** the input `headers` map is the
 * `fetchedContent.headers` shape from `inbound-fetch.ts:86-90`, which
 * normalizes all keys to lowercase at the fetch site. The helper looks
 * up by lower-case key directly — no case-insensitive iteration needed.
 *
 * Pure function: no DB reads, no I/O, deterministic on input shape.
 * Returns either `{ filtered: false }` or `{ filtered: true; reason }`
 * where `reason` is a tagged string (e.g. `header:auto-submitted=auto-
 * replied`, `sender-local-part:mailer-daemon`, `subject-pattern`,
 * `body-pattern:...`) for forensic-analysis grep on
 * `LeadInboxEvent.rejection_reason`.
 */

export type AutoresponderFilterResult =
  | { filtered: false }
  | { filtered: true; reason: string };

/**
 * RFC 3834 §5: `Auto-Submitted` values indicating a machine-generated
 * reply. The literal `no` explicitly means "this is NOT an auto-reply"
 * and MUST pass through; anything else in this set fails the filter.
 */
const AUTO_SUBMITTED_VALUES = new Set(["auto-replied", "auto-generated"]);

/**
 * Legacy precedence values used historically (and still common) to
 * mark machine-generated / list-fanout mail. `bulk` covers list and
 * mailer-daemon variants; `list` covers explicit mailing-list traffic.
 */
const PRECEDENCE_VALUES = new Set(["bulk", "junk", "list"]);

/**
 * Sender local-parts (the bit before @) that are conventionally used
 * for automated systems. Lowercased + exact match against the parsed
 * From address's local-part. Conservative: covers the canonical
 * Postfix/Exim/Sendmail conventions without overreaching into common
 * human local-parts.
 */
const SENDER_LOCAL_PART_DENYLIST = new Set([
  "bounce",
  "bounces",
  "no-reply",
  "noreply",
  "no_reply",
  "mailer-daemon",
  "mailerdaemon",
  "postmaster",
  "auto-reply",
  "autoreply",
]);

/**
 * Subject-line regex covering EN + FR Canadian-market autoresponder
 * patterns. Anchored at start (with optional `Re: ` prefix because
 * autoresponders often quote the inbound subject and prepend `Re: `).
 *
 * Patterns:
 *   - `automatic reply`, `auto: ...`, `automatic: ...`
 *   - `out of office` / `OOO`
 *   - `away`, `vacation`
 *   - `absence du bureau` (FR)
 *   - `réponse automatique` (FR, with é OR e for tolerant matching)
 */
const SUBJECT_REGEX =
  /^(re:\s*)?(auto(matic)?(\s+reply)?:?|out\s+of\s+office|ooo|away|vacation|absence\s+du\s+bureau|r[eé]ponse\s+automatique)\b/i;

/**
 * Body-text patterns matching the canonical "I am out of the office"
 * sentences in EN + FR. Each pattern is tagged for the audit reason
 * so over-filter forensics can identify which sentence shape fired.
 *
 * Conservative: each pattern is anchored to specific verb phrases
 * ("I am", "I will be", "je suis", "je serai") — won't false-positive
 * on substantive replies that incidentally mention vacation context
 * ("we should grab coffee after my vacation").
 */
const BODY_PATTERNS: ReadonlyArray<{ pattern: RegExp; tag: string }> = [
  { pattern: /\bi\s+am\s+(currently\s+)?out\s+of\s+the\s+office\b/i, tag: "en-out-of-office" },
  { pattern: /\bi\s+will\s+be\s+away\b/i, tag: "en-will-be-away" },
  { pattern: /\bi\s+am\s+(currently\s+)?on\s+vacation\b/i, tag: "en-on-vacation" },
  { pattern: /\bautomatic(ally)?\s+(generated|reply|response)\b/i, tag: "en-automatic-reply" },
  { pattern: /\bje\s+suis\s+(actuellement\s+)?absent[e]?\b/i, tag: "fr-absent" },
  { pattern: /\bje\s+serai\s+de\s+retour\b/i, tag: "fr-de-retour" },
  { pattern: /\br[eé]ponse\s+automatique\b/i, tag: "fr-reponse-automatique" },
];

export interface DetectAutoresponderInput {
  /**
   * Inbound mail headers, lower-case-keyed (as normalized by
   * `inbound-fetch.ts`). Empty object when the Resend Receiving API
   * was unreachable; the filter falls through to non-header signals.
   */
  headers: Record<string, string>;
  /** Sender email — the From-header parsed local-part is checked. */
  fromAddress: string;
  /** Subject line (post-trim); empty string when absent. */
  subject: string;
  /** Body text (post-strip); empty string when absent. */
  bodyText: string;
}

export function detectAutoresponder(input: DetectAutoresponderInput): AutoresponderFilterResult {
  // ── 1. Header markers (highest confidence — explicit RFC signals) ──

  const autoSubmitted = input.headers["auto-submitted"];
  if (autoSubmitted) {
    // RFC 3834: value is a structured field (`type; param=value`). Pull
    // the leading type token; lowercase + trim for set lookup. Literal
    // `no` is the RFC-blessed "this is NOT an auto-reply" marker — MUST
    // pass through.
    const head = autoSubmitted.toLowerCase().split(";")[0]?.trim() ?? "";
    if (head !== "no" && AUTO_SUBMITTED_VALUES.has(head)) {
      return { filtered: true, reason: `header:auto-submitted=${head}` };
    }
  }

  const precedence = input.headers["precedence"];
  if (precedence) {
    const value = precedence.toLowerCase().trim();
    if (PRECEDENCE_VALUES.has(value)) {
      return { filtered: true, reason: `header:precedence=${value}` };
    }
  }

  if (input.headers["x-autoresponder"]) {
    return { filtered: true, reason: "header:x-autoresponder-present" };
  }
  if (input.headers["x-auto-response-suppress"]) {
    return { filtered: true, reason: "header:x-auto-response-suppress-present" };
  }

  // ── 2. Sender local-part denylist ──

  const atIdx = input.fromAddress.indexOf("@");
  const localPart =
    (atIdx > 0 ? input.fromAddress.slice(0, atIdx) : input.fromAddress).toLowerCase().trim();
  if (SENDER_LOCAL_PART_DENYLIST.has(localPart)) {
    return { filtered: true, reason: `sender-local-part:${localPart}` };
  }

  // ── 3. Subject-line regex ──

  if (SUBJECT_REGEX.test(input.subject)) {
    return { filtered: true, reason: "subject-pattern" };
  }

  // ── 4. Body-text sentence patterns ──

  for (const { pattern, tag } of BODY_PATTERNS) {
    if (pattern.test(input.bodyText)) {
      return { filtered: true, reason: `body-pattern:${tag}` };
    }
  }

  return { filtered: false };
}
