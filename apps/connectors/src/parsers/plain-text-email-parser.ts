/**
 * KAN-1140 Phase 1 PR 1 — Plain-text email pre-parser.
 *
 * Purpose: when the format-detector classifies an inbound as `plain-text`,
 * lightly clean it for downstream LLM extraction:
 *   - Strip signature blocks (lines starting with `--`, `Sent from my iPhone`)
 *   - Strip quoted reply blocks (`On <date> <person> wrote:` ... onwards)
 *   - Try to extract `Label: value` lines as customFields (lower-confidence
 *     than the HTML parser's table heuristics)
 *
 * Pure function — no I/O. No DOM library needed.
 */

export interface PlainTextParseResult {
  /** Body text with signature + quoted-reply blocks stripped. */
  cleanedText: string;
  /** Label:value pairs extracted from common plain-text form patterns
   *  (`Name: Alice\n`). */
  customFields: Record<string, string>;
}

export interface PlainTextParseInput {
  text: string;
}

const SIGNATURE_MARKERS = [
  /^--\s*$/m,                              // RFC 3676 signature delimiter
  /^Sent from my (iPhone|iPad|Android|mobile)/im,
  /^Sent from Outlook/im,
  /^Get Outlook for/im,
  /^Sent from Yahoo Mail/im,
];

const QUOTED_REPLY_MARKERS = [
  /^On .{1,100}wrote:$/im,                 // "On Tue, Jun 8, 2026 at 1:00 PM Alice <alice@x.com> wrote:"
  /^-----Original Message-----/im,         // Outlook
  /^________________________________$/m,   // Outlook horizontal divider
  /^From: .+?[\r\n]+Sent: /im,             // Outlook header block
];

const LABEL_VALUE_LINE = /^([A-Za-z][\w\s\-\/]{0,40})\s*[:=]\s*(.+?)\s*$/;

export function parsePlainTextEmail(input: PlainTextParseInput): PlainTextParseResult | null {
  const text = input.text?.trim();
  if (!text || text.length === 0) return null;

  // ── Strip signature + quoted-reply blocks
  let cleaned = text;
  for (const marker of [...SIGNATURE_MARKERS, ...QUOTED_REPLY_MARKERS]) {
    const match = cleaned.match(marker);
    if (match && typeof match.index === 'number') {
      cleaned = cleaned.slice(0, match.index).trimEnd();
    }
  }

  // ── Extract Label: value lines
  const customFields: Record<string, string> = {};
  const lines = cleaned.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 200) continue;
    const match = LABEL_VALUE_LINE.exec(trimmed);
    if (!match) continue;
    const label = normalizeLabel(match[1]);
    const value = match[2].trim();
    if (label && value && !customFields[label]) {
      customFields[label] = value;
    }
  }

  return {
    cleanedText: cleaned.trim(),
    customFields,
  };
}

function normalizeLabel(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned.length > 0 && cleaned.length <= 50 ? cleaned : null;
}
