/**
 * KAN-1140 Phase 1 PR 1 — Generic HTML email pre-parser.
 *
 * Purpose: when the format-detector classifies an inbound as `html` or
 * `html-in-text`, extract a clean text representation + any label:value
 * patterns that look like form-style content (e.g., `Name: Alice`,
 * `<td>Email</td><td>alice@example.com</td>`).
 *
 * Strategy:
 *   1. cheerio.load(html) — DOM parse
 *   2. Strip `<script>`, `<style>`, `<head>` — they're not content
 *   3. Walk for table-based label/value pairs (common email-template shape)
 *   4. Extract overall text content for the downstream LLM extraction step
 *
 * NOT a replacement for `formspree-email.ts` (vendor-specific). This
 * module handles GENERIC HTML emails — anything that doesn't match a
 * vendor-specific parser falls through here.
 *
 * Pure function — no I/O.
 */
import { load as loadCheerio } from 'cheerio';

export interface HtmlParseResult {
  /** Stripped + normalized text content. Downstream LLM extraction uses this. */
  extractedText: string;
  /** Label:value pairs extracted from common email-template patterns
   *  (tables, `<dt>/<dd>`, `<strong>Label:</strong> value`). Caller maps
   *  this verbatim into wire `customFields`. */
  customFields: Record<string, string>;
}

export interface HtmlParseInput {
  /** Raw HTML body from the email. */
  html: string;
}

const LABEL_VALUE_TABLE_PATTERN = /^([A-Za-z][\w\s\-\/]{0,40})\s*$/;

export function parseHtmlEmail(input: HtmlParseInput): HtmlParseResult | null {
  const html = input.html?.trim();
  if (!html || html.length === 0) return null;

  let $: ReturnType<typeof loadCheerio>;
  try {
    $ = loadCheerio(html);
  } catch {
    return null;
  }

  // Strip non-content tags up front
  $('script, style, head, link, meta').remove();

  const customFields: Record<string, string> = {};

  // ── Pattern 1: <dl><dt>Label</dt><dd>value</dd></dl>
  $('dl').each((_, dl) => {
    const $dl = $(dl);
    const dts = $dl.find('dt').toArray();
    const dds = $dl.find('dd').toArray();
    const pairs = Math.min(dts.length, dds.length);
    for (let i = 0; i < pairs; i += 1) {
      const label = normalizeLabel($(dts[i]).text());
      const value = $(dds[i]).text().trim();
      if (label && value) customFields[label] = value;
    }
  });

  // ── Pattern 2: <table><tr><td>Label</td><td>value</td></tr></table>
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (cells.length < 2) return;
    const labelRaw = $(cells[0]).text().trim();
    const valueRaw = $(cells[1]).text().trim();
    if (!labelRaw || !valueRaw) return;
    // Heuristic: the label cell looks like a label (short, no full sentence)
    if (!LABEL_VALUE_TABLE_PATTERN.test(labelRaw)) return;
    const label = normalizeLabel(labelRaw);
    if (label) customFields[label] = valueRaw;
  });

  // ── Pattern 3: <strong>Label:</strong> value (inline)
  $('strong, b').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (!text.endsWith(':')) return;
    const label = normalizeLabel(text.slice(0, -1));
    if (!label) return;
    // Take the next text node sibling as value
    const next = $el[0]?.nextSibling;
    if (!next) return;
    const value = (typeof (next as { data?: string }).data === 'string'
      ? (next as { data: string }).data
      : ''
    ).trim();
    if (value && !customFields[label]) customFields[label] = value;
  });

  // ── Body text — flat extraction for the downstream LLM
  const extractedText = $('body').length > 0 ? $('body').text() : $.root().text();
  const normalizedText = extractedText
    .replace(/\s+/g, ' ')
    .trim();

  return {
    extractedText: normalizedText,
    customFields,
  };
}

/**
 * Normalize a label string to a snake_case `customFields` key. Drops
 * punctuation; lowercases; spaces → underscores.
 *
 *   "First Name" → "first_name"
 *   "Email Address:" → "email_address"
 *   "" / null → null
 */
function normalizeLabel(raw: string): string | null {
  const cleaned = raw
    .replace(/[:.\-]+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned.length > 0 && cleaned.length <= 50 ? cleaned : null;
}

/**
 * Lightweight presence check — true when the input string contains common
 * HTML markers. Mirrors `isAdfPayload` precedent.
 */
export function isHtmlPayload(html: string | null | undefined): boolean {
  if (!html) return false;
  const trimmed = html.trim();
  return /<html\b/i.test(trimmed) || /<body\b/i.test(trimmed) || /<!doctype\s+html\b/i.test(trimmed);
}
