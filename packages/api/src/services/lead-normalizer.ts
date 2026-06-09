/**
 * KAN-792 — AI Lead Normalizer (MVP).
 *
 * Phase 1 epic 2 of 3. See docs/prds/phase-1-deal-engagement.md §4 KAN-792 row.
 *
 * Source-aware pre-parser + AI extraction step. Produces a `NormalizedLead`
 * shape that KAN-793's Track A consumer feeds into Contact + Deal + inbound
 * Engagement creation (KAN-793 wires the writer; KAN-792 stops at extraction).
 *
 * Sources (V1 = email only; future epics named below):
 *   - email           (Track A inbound — KAN-741 Resend webhook payload)
 *   - meta_lead_ads   (Phase 4 — KAN-799)
 *   - sms             (Phase 4 — KAN-800)
 *   - whatsapp        (Phase 4 — KAN-802)
 *   - voice           (Phase 4 — KAN-803)
 *   - lead_api        (Sprint 3.8 KAN-742 already ships an API key surface;
 *                      Phase 1 doesn't normalize API-side yet — KAN-799+)
 *
 * Module-function exports per sibling-service convention (matches
 * engagement-service.ts, agentic-tools.ts, csv-import-haiku-mapping.ts —
 * which is the closest analogue, also Haiku field extraction).
 *
 * LLM tier: 'cheap' (Haiku) per llm-client TIER_MAP — high-volume use case,
 * canonical fields are well-bounded, doesn't require reasoning depth.
 * Cost-optimization (escalation to 'reasoning' for hard cases) deferred to
 * KAN-806 (Phase 5 cost & observability).
 *
 * Failure-isolation: LLM extraction failures (malformed JSON, network errors,
 * empty responses) produce a NormalizedLead with `extractionConfidence: 'low'`
 * + only pre-parser fields populated. Caller (KAN-793) decides whether to
 * write minimal Contact (email only) or skip per its own policy.
 */
import { complete as llmComplete } from './llm-client.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

// KAN-1140 PR 0 — `email` renamed to `email_inbox` to align with the locked
// canonical (ContactSourceEnum at packages/shared/src/enums.ts:80-91; KAN-1000
// lock at audience-router.ts:329; published wire value at apps/connectors/
// src/app.ts:80). The normalizer's `'email'` was the only outlier among 4
// vocabularies for the same concept.
export type NormalizerSource =
  | 'email_inbox'
  | 'meta_lead_ads'
  | 'sms'
  | 'whatsapp'
  | 'voice'
  | 'lead_api';

/**
 * Track A email payload — matches the LeadReceivedEvent.metadata shape
 * published by `apps/connectors/src/webhooks/resend-inbound.ts` per KAN-741
 * (see reference_lead_inbox.md). bodyPreview is ~256 chars; full-body fetch
 * is deferred to a separate follow-up (KAN-INBOX-resend-body-fetch).
 */
export interface EmailPayload {
  fromAddress: string;
  subject?: string | null;
  bodyPreview?: string | null;
  attachmentCount?: number;
  /** Optional raw header string for future expansion (Resend doesn't surface
   *  full headers in the webhook payload yet; placeholder for Track A v2). */
  rawHeaders?: string | null;
  /**
   * KAN-1140 Phase 2 — Resolved language (ISO 639-1, e.g. `en` / `fr` /
   * `es`). Threaded from the inbound producer (webhook calls
   * `resolveLanguage()` with tenant supportedLanguages/defaultLanguage,
   * stashes on `LeadReceivedEvent.metadata.language`; consumer pulls into
   * this payload). Drives a Q5(b) single-multilingual-prompt locale block
   * in `runAIExtraction()`: when present the Haiku is asked to emit
   * `intentSummary` + `qualificationSignals` in this language. Absent →
   * Haiku defaults to English (current behavior).
   */
  locale?: string | null;
}

/**
 * KAN-1141 PR 0 — Lead-API caller payload shape.
 *
 * Direct REST inbound via POST /api/v1/leads (KAN-742). The API caller sends
 * structured data; the normalizer's lead_api path is pure pre-parser (no LLM,
 * per KAN-1140 Q3a(i)) — callers contracting to send structured data should
 * not pay LLM latency/cost.
 *
 * `apiKeyTag` is threaded through from the route's authenticated API key
 * prefix for forensic attribution at the wire layer.
 */
export interface LeadApiPayload {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Arbitrary structured JSON from the API caller. Top-level keys may carry
   *  convention fields (companyName / phone) but the shape is caller-defined. */
  metadata?: Record<string, unknown>;
  /** API key prefix (KAN-742 plaintext-indexed lookup field). Threaded
   *  through for forensic posture/rate-limit attribution on the wire event. */
  apiKeyTag?: string | null;
}

export type NormalizerInput =
  | { source: 'email_inbox'; tenantId: string; payload: EmailPayload }
  | { source: 'meta_lead_ads'; tenantId: string; payload: unknown }
  | { source: 'sms'; tenantId: string; payload: unknown }
  | { source: 'whatsapp'; tenantId: string; payload: unknown }
  | { source: 'voice'; tenantId: string; payload: unknown }
  | { source: 'lead_api'; tenantId: string; payload: LeadApiPayload };

/**
 * Intermediate output of the per-source pre-parser. Stable structured form
 * before the AI extraction step. Test fixtures + observability hook into
 * this shape.
 */
export interface PreParsedLead {
  source: NormalizerSource;
  senderEmail: string;
  senderNameGuess: string | null;
  subject: string | null;
  bodyText: string | null;
  /**
   * KAN-1140 Phase 2 — Optional resolved language (ISO 639-1). When set,
   * `runAIExtraction()` injects a `## Email language` block into the
   * Haiku userPrompt and asks the model to emit natural-language fields
   * in this locale. lead_api path leaves this undefined (structured
   * caller; no body-text to detect against).
   */
  locale?: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Output of the AI extraction step. Canonical Contact + Deal fields the
 * Track A consumer (KAN-793) writes into the schema.
 */
export interface ExtractedFields {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone: string | null;
  /** 1-sentence summary of the lead's stated intent (max ~140 chars). */
  intentSummary: string | null;
  /** Bounded set of qualification signals the AI detected, e.g.
   *  ['asking about pricing', 'demo request', 'complaint', 'enterprise tier']. */
  qualificationSignals: string[];
}

export type ExtractionConfidence = 'high' | 'medium' | 'low';

export interface NormalizedLead {
  source: NormalizerSource;
  /** Always populated — the pre-parser output. KAN-793 uses this even when
   *  AI extraction fails (extractionConfidence: 'low'). */
  preParsed: PreParsedLead;
  /** Canonical Contact + Deal fields. May contain nulls if the AI extraction
   *  partially failed (extractionConfidence: 'medium') or failed entirely
   *  (extractionConfidence: 'low' → all fields null + qualificationSignals: []). */
  extracted: ExtractedFields;
  extractionConfidence: ExtractionConfidence;
  /** When extraction failed, brief reason for observability (LLM error message,
   *  JSON parse error, etc.). Null on 'high'/'medium' confidence. */
  extractionError: string | null;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Source-aware dispatch. V1 supports 'email_inbox' + 'lead_api'; the 4
 * remaining non-email channels (meta_lead_ads / sms / whatsapp / voice)
 * throw NotImplementedError naming the future epic that will add them.
 *
 * KAN-1141 PR 0 dispatcher framework (Q3 disposition (c) — defer registry):
 * switch/case for now; revisit registry extraction when a 4th case lands
 * (memo 26 — doctrine-driven LoC stays near naive; memo 32 — defer
 * infrastructure until projected scale materializes).
 */
export async function normalizeInbound(input: NormalizerInput): Promise<NormalizedLead> {
  switch (input.source) {
    case 'email_inbox':
      return normalizeInboundEmail(input.tenantId, input.payload);
    case 'lead_api':
      return normalizeInboundLeadApi(input.tenantId, input.payload);
    case 'meta_lead_ads':
      throw new NotImplementedError(
        'meta_lead_ads source not implemented in Phase 1 — see KAN-799 (Phase 4 connectors)',
      );
    case 'sms':
      throw new NotImplementedError(
        'sms source not implemented in Phase 1 — see KAN-800 (Phase 4 connectors)',
      );
    case 'whatsapp':
      throw new NotImplementedError(
        'whatsapp source not implemented in Phase 1 — see KAN-802 (Phase 4 connectors)',
      );
    case 'voice':
      throw new NotImplementedError(
        'voice source not implemented in Phase 1 — see KAN-803 (Phase 4 connectors)',
      );
  }
}

/**
 * Email source — runs the email pre-parser then the AI extraction step.
 * Exported separately for callers that already know the source is email
 * (e.g. tests, future per-source dispatch in KAN-793 if needed).
 */
export async function normalizeInboundEmail(
  tenantId: string,
  payload: EmailPayload,
): Promise<NormalizedLead> {
  const preParsed = preParseEmail(payload);

  const { extracted, confidence, error } = await runAIExtraction(tenantId, preParsed);

  return {
    source: 'email_inbox',
    preParsed,
    extracted,
    extractionConfidence: confidence,
    extractionError: error,
  };
}

// ─────────────────────────────────────────────
// Email pre-parser (no LLM — pure shape extraction)
// ─────────────────────────────────────────────

/**
 * Extract sender / subject / body from a Resend Inbound webhook payload shape.
 * Pure function — no IO. Exported for test introspection.
 */
export function preParseEmail(payload: EmailPayload): PreParsedLead {
  const fromRaw = (payload.fromAddress ?? '').trim();
  const { senderEmail, senderNameGuess } = parseFromAddress(fromRaw);
  const subject = (payload.subject ?? '').trim() || null;
  const bodyText = (payload.bodyPreview ?? '').trim() || null;
  // KAN-1140 Phase 2 — pass-through resolved locale. Normalize trim +
  // empty-string-to-null so the runAIExtraction prompt block is gated on
  // a meaningful value.
  const locale = payload.locale?.trim() || null;

  return {
    source: 'email_inbox',
    senderEmail,
    senderNameGuess,
    subject,
    bodyText,
    locale,
    metadata: {
      attachmentCount: payload.attachmentCount ?? 0,
      ...(payload.rawHeaders ? { rawHeaders: payload.rawHeaders } : {}),
    },
  };
}

// ─────────────────────────────────────────────
// Lead-API pre-parser + normalizer (KAN-1141 PR 0; no LLM per Q3a(i))
// ─────────────────────────────────────────────

/**
 * KAN-1141 PR 0 — Lead-API pre-parser. Pure function — no IO, no LLM.
 *
 * The API caller sends structured data via POST /api/v1/leads. Top-level
 * fields (email / firstName / lastName) map directly to the canonical
 * `PreParsedLead` shape; the arbitrary `metadata` blob is preserved on the
 * intermediate shape for the route's downstream `customFields` mapping
 * (per Q5(a) silent-drop fix at the wire layer).
 *
 * `senderNameGuess` derives from firstName + lastName concatenation.
 * `subject` / `bodyText` are intentionally null — Lead-API has no
 * subject/body concept (structured data, not free text).
 */
export function preParseLeadApi(payload: LeadApiPayload): PreParsedLead {
  const senderEmail = (payload.email ?? '').trim().toLowerCase();
  const nameParts = [payload.firstName, payload.lastName].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
  const senderNameGuess = nameParts.length > 0 ? nameParts.join(' ').trim() : null;

  return {
    source: 'lead_api',
    senderEmail,
    senderNameGuess,
    subject: null,
    bodyText: null,
    metadata: {
      attachmentCount: 0,
      ...(payload.apiKeyTag ? { apiKeyTag: payload.apiKeyTag } : {}),
      ...(payload.metadata ? { rawApiMetadata: payload.metadata } : {}),
    },
  };
}

/**
 * KAN-1141 PR 0 — Lead-API source normalizer wrapper.
 *
 * Mirrors `normalizeInboundEmail` shape (pre-parser + return `NormalizedLead`)
 * but skips the AI extraction step entirely. Per KAN-1140 Q3a(i): API callers
 * contracting to send structured data should not pay LLM latency/cost. If a
 * caller needs LLM extraction on API-submitted leads, file as an opt-in
 * per-API-key flag separately.
 *
 * `extractionConfidence` is 'high' because the data IS the source of truth
 * — no extraction happened, so nothing was inferred. `extracted` carries
 * the direct payload values for firstName / lastName. Phone / companyName /
 * intentSummary / qualificationSignals are left null/empty — callers wanting
 * those should populate via `metadata` (which flows to wire `customFields`
 * downstream).
 *
 * Failure mode (Q2 locked from KAN-1140): pure pre-parser; practically never
 * throws. Defensive try/catch at the caller (lead-api route) catches any
 * unexpected error path.
 */
export async function normalizeInboundLeadApi(
  _tenantId: string,
  payload: LeadApiPayload,
): Promise<NormalizedLead> {
  const preParsed = preParseLeadApi(payload);

  return {
    source: 'lead_api',
    preParsed,
    extracted: {
      firstName: payload.firstName?.trim() || null,
      lastName: payload.lastName?.trim() || null,
      companyName: null,
      phone: null,
      intentSummary: null,
      qualificationSignals: [],
    },
    extractionConfidence: 'high',
    extractionError: null,
  };
}

/**
 * Parse RFC 5322 sender shapes:
 *   "Display Name <user@example.com>" → { senderEmail: 'user@example.com', senderNameGuess: 'Display Name' }
 *   "user@example.com"                → { senderEmail: 'user@example.com', senderNameGuess: null }
 *   bare-quotes display name handled. Empty/malformed → senderEmail = '', null name.
 */
function parseFromAddress(raw: string): {
  senderEmail: string;
  senderNameGuess: string | null;
} {
  const angleMatch = raw.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (angleMatch) {
    return {
      senderEmail: angleMatch[2].trim().toLowerCase(),
      senderNameGuess: angleMatch[1].trim() || null,
    };
  }
  // Bare email (no display name)
  if (raw.includes('@')) {
    return { senderEmail: raw.trim().toLowerCase(), senderNameGuess: null };
  }
  return { senderEmail: '', senderNameGuess: null };
}

// ─────────────────────────────────────────────
// AI extraction step (Haiku via llm-client tier='cheap')
// ─────────────────────────────────────────────

const EXTRACTION_PROMPT_HEADER = `You are a lead intake assistant. Given an inbound email's sender, subject, and body, extract canonical contact + deal fields.

Return ONLY a JSON object matching this exact shape (no other text):
{
  "firstName": string | null,
  "lastName": string | null,
  "companyName": string | null,
  "phone": string | null,
  "intentSummary": string | null,
  "qualificationSignals": string[]
}

Rules:
- firstName/lastName: extract from sender's display name, signature, or body greeting. null if not found.
- companyName: extract from email domain (if not free webmail), signature, or body mention. null if not found.
- phone: only if the sender mentions one in the body. null otherwise (don't fabricate).
- intentSummary: ≤140 chars, 1 sentence. Capture WHAT they want (pricing, demo, complaint, etc.).
- qualificationSignals: short tags like "asking about pricing", "demo request", "complaint", "enterprise tier", "urgent". 0-5 items. Empty array if no clear signals.
- Free-webmail domains (gmail.com, hotmail.com, outlook.com, yahoo.com, icloud.com, etc.) → companyName = null
- Be conservative: prefer null over guessing. Wrong data is worse than missing data.
- KAN-1140 Phase 2 — If an "Email language" section is present below, emit \`intentSummary\` and \`qualificationSignals\` in that language. The structural fields (firstName/lastName/companyName/phone) stay as written in the source. If no language section is present, default to English.`;

interface RawExtraction {
  firstName?: unknown;
  lastName?: unknown;
  companyName?: unknown;
  phone?: unknown;
  intentSummary?: unknown;
  qualificationSignals?: unknown;
}

async function runAIExtraction(
  tenantId: string,
  preParsed: PreParsedLead,
): Promise<{
  extracted: ExtractedFields;
  confidence: ExtractionConfidence;
  error: string | null;
}> {
  // KAN-1140 Phase 2 — locale block: present only when the producer
  // resolved a language (webhook detection + Q4(c') hierarchy). Absence is
  // the legacy English-default path.
  const localeBlock = preParsed.locale
    ? `## Email language\n${preParsed.locale}\n\n`
    : '';

  const userPrompt = `${EXTRACTION_PROMPT_HEADER}

${localeBlock}## Sender
- email: ${preParsed.senderEmail}
- displayName: ${preParsed.senderNameGuess ?? '(not provided)'}

## Subject
${preParsed.subject ?? '(empty)'}

## Body (preview, may be truncated)
${preParsed.bodyText ?? '(empty)'}

## Response (JSON only, no other text):`;

  let response: Awaited<ReturnType<typeof llmComplete>>;
  try {
    response = await llmComplete({
      tenantId,
      tier: 'cheap',
      userPrompt,
      maxTokens: 512,
      callerTag: 'lead-normalizer:email-extraction',
    });
  } catch (err) {
    return {
      extracted: emptyExtractedFields(),
      confidence: 'low',
      error: `llm-call-failed: ${(err as Error).message ?? String(err)}`,
    };
  }

  const jsonText = response.text.trim();
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      extracted: emptyExtractedFields(),
      confidence: 'low',
      error: 'no-json-object-in-llm-response',
    };
  }

  let raw: RawExtraction;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return {
      extracted: emptyExtractedFields(),
      confidence: 'low',
      error: `json-parse-failed: ${(err as Error).message ?? String(err)}`,
    };
  }

  const extracted = sanitizeExtraction(raw);
  const confidence = classifyConfidence(extracted);

  return { extracted, confidence, error: null };
}

function emptyExtractedFields(): ExtractedFields {
  return {
    firstName: null,
    lastName: null,
    companyName: null,
    phone: null,
    intentSummary: null,
    qualificationSignals: [],
  };
}

function sanitizeExtraction(raw: RawExtraction): ExtractedFields {
  return {
    firstName: typeof raw.firstName === 'string' && raw.firstName.trim() ? raw.firstName.trim() : null,
    lastName: typeof raw.lastName === 'string' && raw.lastName.trim() ? raw.lastName.trim() : null,
    companyName: typeof raw.companyName === 'string' && raw.companyName.trim() ? raw.companyName.trim() : null,
    phone: typeof raw.phone === 'string' && raw.phone.trim() ? raw.phone.trim() : null,
    intentSummary:
      typeof raw.intentSummary === 'string' && raw.intentSummary.trim()
        ? raw.intentSummary.trim().slice(0, 140)
        : null,
    qualificationSignals: Array.isArray(raw.qualificationSignals)
      ? raw.qualificationSignals
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 5)
      : [],
  };
}

function classifyConfidence(extracted: ExtractedFields): ExtractionConfidence {
  const populatedFields = [
    extracted.firstName,
    extracted.lastName,
    extracted.companyName,
    extracted.intentSummary,
  ].filter((v) => v !== null).length;

  // 'high' = 3-4 of the canonical fields populated (firstName, lastName, companyName, intentSummary)
  // 'medium' = 1-2 populated (some signal, but partial)
  // 'low' = 0 populated (handled separately by caller for failure paths;
  //         this branch is reached when LLM returned valid JSON but with all nulls)
  if (populatedFields >= 3) return 'high';
  if (populatedFields >= 1) return 'medium';
  return 'low';
}
