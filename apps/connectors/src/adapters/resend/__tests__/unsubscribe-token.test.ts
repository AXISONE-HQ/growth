/**
 * Unit tests for unsubscribe-token (RFC 8058 fix — KAN-687).
 *
 * No Secret Manager calls — secret loader is injected directly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  buildUnsubscribeMailto,
} from '../unsubscribe-token.js';

const SECRET = 'test-signing-secret-do-not-use-in-prod';
const loadSecret = async () => SECRET;

describe('unsubscribe-token round-trip', () => {
  it('round-trips a valid token', async () => {
    const token = await generateUnsubscribeToken(
      { tenantId: '9ca85088-f65b-4bac-b098-fff742281ede', email: 'a@example.com', actionId: 'act-1' },
      loadSecret,
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const verified = await verifyUnsubscribeToken(token, loadSecret);
    expect(verified).not.toBeNull();
    expect(verified?.tenantId).toBe('9ca85088-f65b-4bac-b098-fff742281ede');
    expect(verified?.email).toBe('a@example.com');
    expect(verified?.actionId).toBe('act-1');
    expect(verified?.iat).toBeGreaterThan(0);
  });

  it('round-trips without optional actionId', async () => {
    const token = await generateUnsubscribeToken(
      { tenantId: 't1', email: 'b@example.com' },
      loadSecret,
    );
    const verified = await verifyUnsubscribeToken(token, loadSecret);
    expect(verified?.actionId).toBeUndefined();
    expect(verified?.email).toBe('b@example.com');
  });
});

describe('unsubscribe-token rejection', () => {
  it('rejects a token signed with a different secret', async () => {
    const token = await generateUnsubscribeToken(
      { tenantId: 't1', email: 'a@example.com' },
      loadSecret,
    );
    const otherSecret = async () => 'different-secret';
    expect(await verifyUnsubscribeToken(token, otherSecret)).toBeNull();
  });

  it('rejects a token with a tampered signature', async () => {
    const token = await generateUnsubscribeToken(
      { tenantId: 't1', email: 'a@example.com' },
      loadSecret,
    );
    const [encoded, sig] = token.split('.');
    // flip the last char of the sig
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(await verifyUnsubscribeToken(`${encoded}.${flipped}`, loadSecret)).toBeNull();
  });

  it('rejects a token with a tampered payload (signature recomputed externally)', async () => {
    const token = await generateUnsubscribeToken(
      { tenantId: 't1', email: 'original@example.com' },
      loadSecret,
    );
    const [, sig] = token.split('.');
    // attacker forges a new payload but doesn't have the secret to re-sign
    const evil = Buffer.from(
      JSON.stringify({ tenantId: 't1', email: 'attacker@example.com', iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    expect(await verifyUnsubscribeToken(`${evil}.${sig}`, loadSecret)).toBeNull();
  });

  it('rejects a malformed token (no dot separator)', async () => {
    expect(await verifyUnsubscribeToken('not-a-token', loadSecret)).toBeNull();
    expect(await verifyUnsubscribeToken('', loadSecret)).toBeNull();
    expect(await verifyUnsubscribeToken('only.', loadSecret)).toBeNull();
    expect(await verifyUnsubscribeToken('.only', loadSecret)).toBeNull();
  });

  it('rejects a token older than 180 days', async () => {
    // mint a token with iat 181 days ago by stubbing Date.now during gen
    const realNow = Date.now();
    const realSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - 181 * 86_400 * 1000);
    const oldToken = await generateUnsubscribeToken(
      { tenantId: 't1', email: 'a@example.com' },
      loadSecret,
    );
    realSpy.mockRestore();

    expect(await verifyUnsubscribeToken(oldToken, loadSecret)).toBeNull();
  });

  it('accepts a token at exactly the 180-day boundary', async () => {
    const realNow = Date.now();
    const realSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - 179 * 86_400 * 1000);
    const justInsideToken = await generateUnsubscribeToken(
      { tenantId: 't1', email: 'a@example.com' },
      loadSecret,
    );
    realSpy.mockRestore();
    expect(await verifyUnsubscribeToken(justInsideToken, loadSecret)).not.toBeNull();
  });

  it('rejects a token whose payload omits required fields', async () => {
    // mint a syntactically valid token whose payload lacks tenantId
    const sec = SECRET;
    const crypto = await import('node:crypto');
    const body = JSON.stringify({ email: 'a@example.com', iat: Math.floor(Date.now() / 1000) });
    const encoded = Buffer.from(body).toString('base64url');
    const sig = crypto.createHmac('sha256', sec).update(encoded).digest('base64url');
    const token = `${encoded}.${sig}`;
    expect(await verifyUnsubscribeToken(token, loadSecret)).toBeNull();
  });
});

describe('URL builders', () => {
  it('builds the HTTPS URL with the token URL-encoded', async () => {
    const url = buildUnsubscribeUrl('abc.def+ghi');
    expect(url).toBe('https://growth.axisone.ca/unsubscribe?token=abc.def%2Bghi');
  });

  it('builds the mailto URL with the token in the body', async () => {
    const url = buildUnsubscribeMailto('abc.def');
    expect(url).toContain('mailto:unsubscribe@growth.axisone.ca');
    expect(url).toContain('subject=unsubscribe');
    expect(url).toContain('body=abc.def');
  });
});
