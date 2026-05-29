/**
 * M3-2.5b — RFC 5322 Message-ID + References normalization tests.
 *
 * Pinned behaviors:
 *   - stripMessageIdBrackets handles `<id@domain>`, `<id>`, `id@domain`, `id`
 *   - Returns null on empty / null / undefined / non-string
 *   - parseReferencesHeader space-splits + per-id strips + filters empties
 *   - Multi-bracket / double-angle edge cases don't leak
 */
import { describe, it, expect } from 'vitest';
import { stripMessageIdBrackets, parseReferencesHeader } from '../email-headers.js';

describe('M3-2.5b — stripMessageIdBrackets', () => {
  it('strips angle brackets + @domain — canonical case', () => {
    expect(stripMessageIdBrackets('<abc@resend.dev>')).toBe('abc');
  });

  it('strips when id contains hyphens (Resend UUID shape)', () => {
    expect(
      stripMessageIdBrackets('<4afbb368-4f8c-4a6e-8b88-addb4d60dd69@resend.dev>'),
    ).toBe('4afbb368-4f8c-4a6e-8b88-addb4d60dd69');
  });

  it('strips real fixture-shape Message-ID', () => {
    // Sourced from formspree-2026-05-20.ts:78 — empirical Resend Receiving shape.
    expect(stripMessageIdBrackets('<4vzJC7QWSuOSGeF727eIIg@geopod-ismtpd-60>')).toBe(
      '4vzJC7QWSuOSGeF727eIIg',
    );
  });

  it('handles bracketless id (Resend send-response shape)', () => {
    // Resend's `result.data.id` already-stripped form — should pass through.
    expect(stripMessageIdBrackets('abc')).toBe('abc');
  });

  it('handles bracketless id@domain', () => {
    expect(stripMessageIdBrackets('abc@host')).toBe('abc');
  });

  it('handles angle brackets without @domain', () => {
    expect(stripMessageIdBrackets('<abc>')).toBe('abc');
  });

  it('trims whitespace', () => {
    expect(stripMessageIdBrackets('  <abc@d>  ')).toBe('abc');
  });

  it('returns null on empty string', () => {
    expect(stripMessageIdBrackets('')).toBeNull();
  });

  it('returns null on whitespace-only', () => {
    expect(stripMessageIdBrackets('   ')).toBeNull();
  });

  it('returns null on null/undefined', () => {
    expect(stripMessageIdBrackets(null)).toBeNull();
    expect(stripMessageIdBrackets(undefined)).toBeNull();
  });

  it('returns null on non-string', () => {
    expect(stripMessageIdBrackets(123)).toBeNull();
    expect(stripMessageIdBrackets({})).toBeNull();
    expect(stripMessageIdBrackets([])).toBeNull();
  });

  it('returns null when the input strips to empty', () => {
    expect(stripMessageIdBrackets('<>')).toBeNull();
    expect(stripMessageIdBrackets('<@domain>')).toBeNull();
    expect(stripMessageIdBrackets('@domain')).toBeNull();
  });

  it('handles multi-angle (defensive)', () => {
    expect(stripMessageIdBrackets('<<<abc@d>>>')).toBe('abc');
  });
});

describe('M3-2.5b — parseReferencesHeader', () => {
  it('parses RFC 5322 space-separated References — canonical case', () => {
    expect(parseReferencesHeader('<id1@d1> <id2@d2> <id3@d3>')).toEqual([
      'id1',
      'id2',
      'id3',
    ]);
  });

  it('parses single Reference', () => {
    expect(parseReferencesHeader('<only@d>')).toEqual(['only']);
  });

  it('handles tab/multi-space separators', () => {
    expect(parseReferencesHeader('<a@d>\t<b@d>  <c@d>')).toEqual(['a', 'b', 'c']);
  });

  it('filters empties from malformed input', () => {
    expect(parseReferencesHeader('<a@d>   <>   <c@d>')).toEqual(['a', 'c']);
  });

  it('returns empty array on null/undefined/non-string', () => {
    expect(parseReferencesHeader(null)).toEqual([]);
    expect(parseReferencesHeader(undefined)).toEqual([]);
    expect(parseReferencesHeader(42)).toEqual([]);
  });

  it('returns empty array on empty/whitespace-only', () => {
    expect(parseReferencesHeader('')).toEqual([]);
    expect(parseReferencesHeader('   ')).toEqual([]);
  });

  it('parses bracketless ids', () => {
    expect(parseReferencesHeader('a@d b@d c@d')).toEqual(['a', 'b', 'c']);
  });
});
