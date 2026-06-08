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
}

export type NormalizerInput =
  | { source: 'email_inbox'; tenantId: string; payload: EmailPayload }
  | { source: 'meta_lead_ads'; tenantId: string; payload: unknown }
  | { source: 'sms'; tenantId: string; payload: unknown }
  | { source: 'whatsapp'; tenantId: string; payload: unknown }
  | { source: 'voice'; tenantId: string; payload: unknown }
  | { source: 'lead_api'; tenantId: string; payload: unknown };

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
 * Source-aware dispatch. V1 supports 'email' only; non-email sources throw
 * NotImplementedError naming the future epic that will add them.
 */
export async function normalizeInbound(input: NormalizerInput): Promise<NormalizedLead> {
  switch (input.source) {
    case 'email_inbox':
      return normalizeInboundEmail(input.tenantId, input.payload);
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
    case 'lead_api':
      throw new NotImplementedError(
        'lead_api source not implemented in Phase 1 — see KAN-799+ (Phase 4 connectors)',
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

  return {
    source: 'email_inbox',
    senderEmail,
    senderNameGuess,
    subject,
    bodyText,
    metadata: {
      attachmentCount: payload.attachmentCount ?? 0,
      ...(payload.rawHeaders ? { rawHeaders: payload.rawHeaders } : {}),
    },
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
- Be conservative: prefer null over guessing. Wrong data is worse than missing data.`;

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
  const userPrompt = `${EXTRACTION_PROMPT_HEADER}

## Sender
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
