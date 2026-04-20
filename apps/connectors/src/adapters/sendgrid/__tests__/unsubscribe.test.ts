/**
 * Unit tests for unsubscribe token generation + verification.
 * Uses mocked Secret Manager via vi.mock.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const TEST_SIGNING_KEY = 'test-signing-key-0123456789abcdef';

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    async accessSecretVersion() {
      return [{ payload: { data: Buffer.from(TEST_SIGNING_KEY) } }];
    }
  },
}));

vi.mock('../../../env.js', () => ({
  env: {
    GCP_PROJECT_ID: 'test',
    NODE_ENV: 'test',
    PORT: 8081,
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    INTERNAL_TRPC_AUTH_TOKEN: 'x'.repeat(32),
  },
}));

beforeEach(() => {
  vi.resetModules();
});

describe('unsubscribe tokens', () => {
  it('round-trips payload', async () => {
    const { generateUnsubscribeToken, verifyUnsubscribeToken } = await import('../unsubscribe.js');
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const token = await generateUnsubscribeToken({
      tenantId,
      email: 'user@example.com',
      actionId: '22222222-2222-2222-2222-222222222222',
    });
    const decoded = await verifyUnsubscribeToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.tenantId).toBe(tenantId);
    expect(decoded?.email).toBe('user@example.com');
  });

  it('rejects tampered tokens', async () => {
    const { generateUnsubscribeToken, verifyUnsubscribeToken } = await import('../unsubscribe.js');
    const token = await generateUnsubscribeToken({
      tenantId: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
    });
    // Flip a byte in the payload portion
    const [payload, sig] = token.split('.');
    const tampered = `${payload.slice(0, -1)}X.${sig}`;
    const result = await verifyUnsubscribeToken(tampered);
    expect(result).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    const { verifyUnsubscribeToken } = await import('../unsubscribe.js');
    expect(await verifyUnsubscribeToken('not-a-token')).toBeNull();
    expect(await verifyUnsubscribeToken('')).toBeNull();
  });
});
