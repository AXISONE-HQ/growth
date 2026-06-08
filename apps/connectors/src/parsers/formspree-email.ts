/**
 * KAN-954 — Formspree-forwarded email parser.
 *
 * Form submissions from the growth landing page (Formspree form `mkoynpbr`)
 * arrive as emails forwarded by Formspree:
 *   From: noreply@formspree.io (Strict DKIM ON — can't be spoofed)
 *   Reply-To: <real submitter email>
 *   Body: vertical Label:\nValue\n\n blocks
 *
 * This parser extracts the real prospect's identity + form fields and
 * produces a structured result that the resend-inbound webhook handler
 * uses to override the From-keyed defaults. Pure function, no I/O.
 *
 * Specimen for the regex shape (verified live 2026-05-20 19:47:52 UTC,
 * `resend_email_id = a35ff56c-d5df-4190-8e69-272c35dfb9bb`):
 *
 *     formSource:
 *     growth-landing-v1
 *
 *     leadType:
 *     early_access_request
 *
 *     name:
 *     Cowork Pipeline Test
 *
 *     email:
 *     cowork-pipeline-test@e2etest.co
 *
 *     company:
 *     E2E Test Co
 *
 *     role:
 *     Founder / CEO
 *
 *     monthlyLeadVolume:
 *     100-500
 *
 *     biggestPain:
 *     COWORK E2E PIPELINE TEST — submitted 2026-05-20T19:47:46.033Z to verify ...
 *
 *
 *     Submitted 07:47 PM - 20 May 2026
 *
 * Returns null when:
 *   - Input doesn't look like a Formspree-forwarded email
 *   - No senderEmail can be extracted (neither reply_to[0] nor a body `email:`)
 *
 * On null, the webhook handler MUST fall back to current behavior (land
 * the lead mis-attributed but flagged) — never drop the lead.
 *
 * Second-provider extension seam: detection is a single boolean predicate
 * (`isFormspreeSource`). To add Tally / Typeform later, introduce a
 * vendor-discriminating dispatcher above this; no change to the parser
 * shape itself.
 */

export interface FormspreeParseInput {
  /** Raw From header value (e.g. `'"Formspree" <noreply@formspree.io>'` or `'noreply@formspree.io'`). */
  fromHeader: string;
  /** Subject (used as fallback detection signal — Formspree renders the form's hidden `_subject` here). */
  subject: string | null;
  /** Plain text body fetched via the Resend Receiving API. */
  text: string | null;
  /** Reply-To addresses from the Receiving API top-level field. Primary identity signal. */
  replyTo: string[];
}

export interface FormspreeParseResult {
  /** The real prospect's email (from reply_to[0]; falls back to body `email:` line). */
  senderEmail: string;
  /** First name (best-effort split on first space in `name:` value). */
  firstName: string | null;
  /** Last name (everything after the first space; null if `name:` is a single token). */
  lastName: string | null;
  /** From `company:` line. */
  companyName: string | null;
  /** Free-shape map of every other form field. Includes `formSource` + `leadType` + `role` + `monthlyLeadVolume` + `biggestPain` + any other vertical-block field present. */
  customFields: Record<string, string>;
  /** Computed deal name seed — `Early-access — {company}` → `Early-access — {firstName lastName}` → `Early-access lead`. */
  dealNameSeed: string;
  /** Echoed for downstream attribution (event metadata + Contact.customFields). */
  formSource: string | null;
  /** Same. */
  leadType: string | null;
}

const FORMSPREE_DOMAINS = ["formspree.io", "email.formspree.io"];

/**
 * Detection — does this email look Formspree-forwarded? Checks From-domain
 * primarily. Subject is a defense-in-depth secondary; we don't require it.
 */
export function isFormspreeSource(fromHeader: string): boolean {
  const m = fromHeader.match(/<([^>]+)>/);
  const addr = m ? m[1] : fromHeader.trim();
  const domain = addr.split("@")[1]?.toLowerCase() ?? "";
  return FORMSPREE_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

/**
 * Body parser — Formspree's vertical Label:\nValue\n\n format.
 *
 * Strategy: split body on blank-line separators (`\n\n+`), keep blocks whose
 * first line is `<label>:` and whose remainder is the value. Stop at the
 * "Submitted ..." footer line or the unsubscribe footer.
 */
function parseVerticalBody(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip the introductory banner + footer so we don't accidentally treat
  // their colon-bearing lines as form fields.
  const cleaned = text
    .replace(/^[\s\S]*?Here's what they had to say:\s*/i, "")
    .replace(/\n\s*Submitted\s+[^\n]+\n[\s\S]*$/i, "")
    .replace(/\n\s*---\s*\n[\s\S]*$/i, "")
    .trim();

  // Each form field is a block of `Label:\nValue` separated by blank lines.
  for (const block of cleaned.split(/\n\s*\n+/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // First line up to the first `:` is the label; rest is the value.
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*):\s*\n([\s\S]+)$/);
    if (!match) continue;
    const [, label, value] = match;
    const labelKey = label.trim();
    if (!labelKey) continue;
    out[labelKey] = value.trim();
  }

  return out;
}

/** Best-effort name split — first space wins. Single-token names → firstName only. */
function splitName(full: string): { firstName: string | null; lastName: string | null } {
  const cleaned = full.trim();
  if (!cleaned) return { firstName: null, lastName: null };
  const idx = cleaned.indexOf(" ");
  if (idx < 0) return { firstName: cleaned, lastName: null };
  return {
    firstName: cleaned.slice(0, idx).trim() || null,
    lastName: cleaned.slice(idx + 1).trim() || null,
  };
}

/** Build the deal name seed per D7 — graceful degradation never lands on "Untitled deal". */
function dealName(
  company: string | null,
  firstName: string | null,
  lastName: string | null,
): string {
  if (company) return `Early-access — ${company}`;
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (name) return `Early-access — ${name}`;
  return "Early-access lead";
}

/**
 * Main entry. Returns null when the email isn't Formspree-shaped OR when
 * the parser can't find a senderEmail (no reply_to[0] AND no body
 * `email:` field). Caller MUST fall back to current behavior on null.
 */
export function parseFormspreeEmail(input: FormspreeParseInput): FormspreeParseResult | null {
  if (!isFormspreeSource(input.fromHeader)) return null;
  // Body is required to extract form fields. (reply_to alone gives us
  // sender email but no name/company — useless attribution.)
  if (!input.text) return null;

  const fields = parseVerticalBody(input.text);

  // Sender email: reply_to[0] preferred (Formspree-native), body `email:` fallback.
  const senderEmail = (input.replyTo[0]?.trim() || fields.email?.trim() || "").toLowerCase();
  if (!senderEmail) return null;

  const { firstName, lastName } = splitName(fields.name ?? "");
  const companyName = fields.company?.trim() || null;
  const formSource = fields.formSource?.trim() || null;
  const leadType = fields.leadType?.trim() || null;

  // customFields = everything from the body verbatim, plus the two hidden
  // attribution fields hoisted up. We keep ALL fields including name /
  // email / company so the Contact-level columns + customFields stay in
  // sync as a record of what the form submitted.
  const customFields: Record<string, string> = { ...fields };

  return {
    senderEmail,
    firstName,
    lastName,
    companyName,
    customFields,
    dealNameSeed: dealName(companyName, firstName, lastName),
    formSource,
    leadType,
  };
}

// ─────────────────────────────────────────────
// KAN-1140 Phase 1 PR 4 — VendorHandler adapter
// ─────────────────────────────────────────────

import type {
  VendorDetectionInput,
  VendorExtractionInput,
  VendorExtraction,
  VendorHandler,
} from "./registry.js";

/**
 * Plugin-pattern adapter wrapping the legacy `isFormspreeSource` +
 * `parseFormspreeEmail` exports. The webhook handler dispatches via
 * `vendorRegistry.detect(payload)`; this handler self-identifies on
 * Formspree-shaped From-domains.
 *
 * Legacy exports (`isFormspreeSource`, `parseFormspreeEmail`) are preserved
 * for back-compat — older callers + existing tests continue to work.
 */
export const formspreeHandler: VendorHandler = {
  name: "formspree",
  detect(payload: VendorDetectionInput): boolean {
    return isFormspreeSource(payload.fromHeader);
  },
  extract(payload: VendorExtractionInput): VendorExtraction | null {
    const result = parseFormspreeEmail({
      fromHeader: payload.fromHeader,
      subject: payload.subject,
      text: payload.text,
      replyTo: payload.replyTo,
    });
    if (!result) return null;
    return {
      senderEmail: result.senderEmail,
      firstName: result.firstName,
      lastName: result.lastName,
      companyName: result.companyName,
      vendor: "formspree",
      formSource: result.formSource,
      leadType: result.leadType,
      dealName: result.dealNameSeed,
      customFields: result.customFields,
    };
  },
};
