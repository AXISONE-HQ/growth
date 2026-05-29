/**
 * M3-2.5a — shared email-provider type tests.
 *
 * Pinned behaviors:
 *   - KNOWN_EMAIL_PROVIDERS reference list complete (resend + 4 anticipated)
 *   - EmailProviderSchema is a soft validator (accepts any non-empty string)
 *   - Empty string rejected
 *   - EngagementEmailMetadataRecord shape compiles + matches sidecar columns
 */
import { describe, it, expect } from 'vitest';
import {
  KNOWN_EMAIL_PROVIDERS,
  EmailProviderSchema,
  type KnownEmailProvider,
  type EngagementEmailMetadataRecord,
} from '../email-providers.js';

describe('M3-2.5a — KNOWN_EMAIL_PROVIDERS reference list', () => {
  it('includes resend as the live provider', () => {
    expect(KNOWN_EMAIL_PROVIDERS).toContain('resend');
  });

  it('includes the 4 anticipated future providers (postmark, mailgun, ses, sendgrid)', () => {
    expect(KNOWN_EMAIL_PROVIDERS).toEqual(
      expect.arrayContaining(['postmark', 'mailgun', 'ses', 'sendgrid']),
    );
  });

  it('KnownEmailProvider type narrows correctly', () => {
    const provider: KnownEmailProvider = 'resend';
    expect(provider).toBe('resend');
  });
});

describe('M3-2.5a — EmailProviderSchema soft validator', () => {
  it('accepts known providers', () => {
    for (const p of KNOWN_EMAIL_PROVIDERS) {
      expect(() => EmailProviderSchema.parse(p)).not.toThrow();
    }
  });

  it('accepts UNKNOWN providers (soft, not gate) — forward-compat for future adapters', () => {
    expect(() => EmailProviderSchema.parse('totally-new-provider-2027')).not.toThrow();
    expect(() => EmailProviderSchema.parse('custom-internal-relay')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => EmailProviderSchema.parse('')).toThrow();
  });

  it('rejects non-string', () => {
    expect(() => EmailProviderSchema.parse(null)).toThrow();
    expect(() => EmailProviderSchema.parse(123)).toThrow();
  });
});

describe('M3-2.5a — EngagementEmailMetadataRecord shape', () => {
  it('outbound shape: inReplyTo null, referencesArray empty', () => {
    const outbound: EngagementEmailMetadataRecord = {
      engagementId: 'eng-1',
      provider: 'resend',
      providerMessageId: 'pid-abc123',
      inReplyTo: null,
      referencesArray: [],
      createdAt: new Date(),
    };
    expect(outbound.inReplyTo).toBeNull();
    expect(outbound.referencesArray).toEqual([]);
  });

  it('inbound shape (M3-2.5b will populate): inReplyTo + referencesArray non-null', () => {
    const inbound: EngagementEmailMetadataRecord = {
      engagementId: 'eng-2',
      provider: 'resend',
      providerMessageId: 'pid-inbound-xyz',
      inReplyTo: '<pid-abc123@resend.dev>',
      referencesArray: ['<pid-abc123@resend.dev>', '<pid-older@resend.dev>'],
      createdAt: new Date(),
    };
    expect(inbound.inReplyTo).toBe('<pid-abc123@resend.dev>');
    expect(inbound.referencesArray.length).toBe(2);
  });
});
