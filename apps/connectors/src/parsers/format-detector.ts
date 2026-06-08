/**
 * KAN-1140 Phase 1 PR 1 — Email body format detector.
 *
 * Pure function — body-sniffing classifier over the Resend Receiving API's
 * pre-classified `text` / `html` fields (per KAN-954). There is no
 * `Content-Type` header to dispatch on at this layer; Resend pre-splits
 * the original MIME multipart into separate top-level fields, so detection
 * is content-shape sniffing only.
 *
 * Detection order (highest-confidence-first):
 *   1. ADF — `text` starts with `<?xml` / `<?ADF` PI or contains `<adf>` root
 *   2. HTML-only — `html` populated, `text` empty
 *   3. HTML-in-text — `text` contains `<html>` / `<!doctype html>`
 *   4. Plain-text — text populated, no structured markers
 *   5. Unknown — both empty
 *
 * Ordinal confidence (high / medium / low) supports the Phase 3
 * confidence-escalation queue (per KAN-1140 Phase 1 PR 1 Q6 deferred
 * schema decision: detection result is stored in customFields temporarily
 * until Phase 3 wire schema lands).
 *
 * NOTE on form-vendor detection: Formspree (KAN-954) detection is performed
 * upstream of this classifier via `isFormspreeSource(fromAddress)`. When
 * the webhook handler detects Formspree, it skips the format-detector
 * entirely. This module assumes form-vendor inputs are already routed
 * elsewhere.
 */

export type DetectedFormat = 'adf' | 'html' | 'html-in-text' | 'plain-text' | 'unknown';
export type FormatConfidence = 'high' | 'medium' | 'low';

export interface FormatDetection {
  format: DetectedFormat;
  confidence: FormatConfidence;
  reason: string;
}

export interface FormatDetectorInput {
  text: string | null;
  html: string | null;
}

const XML_PROLOG_RE = /^\s*<\?xml\b/i;
const ADF_PROLOG_RE = /^\s*<\?ADF\b/i;
const ADF_ROOT_RE = /<adf\b/i;
const HTML_TAG_RE = /<html\b/i;
const HTML_DOCTYPE_RE = /<!doctype\s+html\b/i;

export function detectEmailFormat(input: FormatDetectorInput): FormatDetection {
  const text = (input.text ?? '').trim();
  const html = (input.html ?? '').trim();

  // 1. ADF — most structured; prolog or root tag is a high-confidence signal
  if (text.length > 0 && (XML_PROLOG_RE.test(text) || ADF_PROLOG_RE.test(text) || ADF_ROOT_RE.test(text))) {
    const reason = ADF_PROLOG_RE.test(text)
      ? 'adf-processing-instruction'
      : XML_PROLOG_RE.test(text)
        ? 'xml-prolog'
        : 'adf-root-tag';
    return { format: 'adf', confidence: 'high', reason };
  }

  // 2. HTML-only — Resend gave us html but no text part
  if (html.length > 0 && text.length === 0) {
    return { format: 'html', confidence: 'high', reason: 'html-field-only' };
  }

  // 3. HTML embedded in text-field (uncommon; some clients send HTML as text)
  if (text.length > 0 && (HTML_TAG_RE.test(text) || HTML_DOCTYPE_RE.test(text))) {
    return { format: 'html-in-text', confidence: 'medium', reason: 'html-markers-in-text-field' };
  }

  // 4. Both empty — caller falls back to whatever empty-body path applies
  if (text.length === 0 && html.length === 0) {
    return { format: 'unknown', confidence: 'low', reason: 'empty-body' };
  }

  // 5. Plain text fallback — text populated, no structured markers
  return { format: 'plain-text', confidence: 'high', reason: 'no-structured-markers' };
}
