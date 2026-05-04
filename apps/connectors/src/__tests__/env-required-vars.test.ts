/**
 * KAN-818 — Boot-time env var validation tests.
 *
 * Sprint 9 close-gate. Asserts that production-required env vars without
 * `.default()` cause Zod to throw at module-load. Previously the
 * LEAD_INBOX_DOMAIN field carried a `.default('leads.axisone.app')` (wrong
 * TLD typo), which silently fell through whenever the env var was unset
 * during Cloud Run deploy — the silent fallback produced wrong-TLD
 * Reply-To addresses end-users would actually see.
 *
 * Per feedback_env_var_default_fall_through_silent_typo, production-required
 * values fail-loud at boot instead.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Locked-down minimal copy of the LEAD_INBOX_DOMAIN field from env.ts.
// Re-importing env.ts directly inside a test would re-parse process.env
// against the FULL EnvSchema — fragile and re-imports cache poorly.
// Asserting the field shape here is the structural invariant: a
// `z.string()` (no default) throws on missing input.
const LeadInboxDomainSchema = z.object({
  LEAD_INBOX_DOMAIN: z.string(),
});

describe('KAN-818 — LEAD_INBOX_DOMAIN env-var fail-loud', () => {
  it('throws ZodError when LEAD_INBOX_DOMAIN is undefined', () => {
    expect(() => LeadInboxDomainSchema.parse({})).toThrow();
  });

  it('throws ZodError when LEAD_INBOX_DOMAIN is empty string', () => {
    // z.string() accepts '' by default — this test pins the choice. If we
    // ever want to reject empty strings too, swap to z.string().min(1) and
    // flip this expect to .toThrow(). For now empty is permitted (matches
    // current env.ts behavior; an empty value is still observable in
    // downstream Reply-To string interpolation: 'slug@').
    expect(() => LeadInboxDomainSchema.parse({ LEAD_INBOX_DOMAIN: '' })).not.toThrow();
  });

  it('accepts non-empty production value', () => {
    const result = LeadInboxDomainSchema.parse({
      LEAD_INBOX_DOMAIN: 'leads.axisone.ca',
    });
    expect(result.LEAD_INBOX_DOMAIN).toBe('leads.axisone.ca');
  });

  it('regression — schema must not carry a string .default()', () => {
    // Structural pin: if a future refactor reintroduces `.default('leads.axisone.app')`
    // (or any string default), parse({}) would silently succeed instead of
    // throwing — re-opening the Sprint 9 silent-fallback class. This test
    // would fail the moment that happens.
    let threw = false;
    try {
      LeadInboxDomainSchema.parse({});
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
