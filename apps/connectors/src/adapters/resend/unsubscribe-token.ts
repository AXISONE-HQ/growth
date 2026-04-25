/**
 * One-click unsubscribe token — embedded in the `List-Unsubscribe` header
 * for RFC 8058 compliance. Resurrected from the SendGrid-era code (deleted
 * in PR #26) since the signing/verification logic is provider-agnostic.
 *
 * Format:    `${base64url(payload)}.${base64url(hmac-sha256(payload, secret))}`
 * Lifetime:  180 days (CAN-SPAM minimum window for honoring unsubscribes)
 * Secret:    `unsubscribe-signing-key:latest` in Secret Manager.
 *            Cached in-process for 30 minutes after first read.
 *
 * The secret loader is injectable for unit tests — pass a fixed-value loader
 * to avoid touching Secret Manager.
 *
 * KAN-687 / RFC 8058 — fix List-Unsubscribe header to include an HTTPS URL.
 */

import crypto from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

const TOKEN_LIFETIME_SEC = 180 * 86_400;
const SECRET_CACHE_MS = 30 * 60 * 1_000;

export interface UnsubscribeTokenPayload {
  tenantId: string;
  email: string;
  actionId?: string;
  iat: number;
}

const secretManager = new SecretManagerServiceClient();
let cachedSecret: string | null = null;
let cachedAt = 0;

export type SecretLoader = () => Promise<string>;

async function defaultLoadSigningSecret(): Promise<string> {
  if (cachedSecret && Date.now() - cachedAt < SECRET_CACHE_MS) return cachedSecret;
  const name = `projects/${env.GCP_PROJECT_ID}/secrets/unsubscribe-signing-key/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name });
  const secret = version.payload?.data?.toString().trim();
  if (!secret) throw new Error('unsubscribe-signing-key secret missing or empty');
  cachedSecret = secret;
  cachedAt = Date.now();
  return secret;
}

export async function generateUnsubscribeToken(
  payload: Omit<UnsubscribeTokenPayload, 'iat'>,
  loadSecret: SecretLoader = defaultLoadSigningSecret,
): Promise<string> {
  const secret = await loadSecret();
  const body = JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) });
  const encoded = Buffer.from(body).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export async function verifyUnsubscribeToken(
  token: string,
  loadSecret: SecretLoader = defaultLoadSigningSecret,
): Promise<UnsubscribeTokenPayload | null> {
  try {
    const [encoded, providedSig] = token.split('.');
    if (!encoded || !providedSig) return null;

    const secret = await loadSecret();
    const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    const a = Buffer.from(expectedSig);
    const b = Buffer.from(providedSig);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as UnsubscribeTokenPayload;

    if (
      typeof payload.tenantId !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.iat !== 'number'
    ) {
      return null;
    }

    if (Math.floor(Date.now() / 1000) - payload.iat > TOKEN_LIFETIME_SEC) {
      logger.warn({ email: payload.email, iat: payload.iat }, 'expired unsubscribe token');
      return null;
    }

    return payload;
  } catch (err) {
    logger.warn({ err }, 'unsubscribe token verify failed');
    return null;
  }
}

/**
 * Build the full `List-Unsubscribe` HTTPS URL for a given token.
 * Hostname is the public-facing domain Microsoft / Gmail will POST to.
 */
export function buildUnsubscribeUrl(token: string): string {
  return `https://growth.axisone.ca/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Build the `mailto:` fallback URL. Per KAN-687 PR description this is a
 * placeholder — receiving the email and processing the body to suppress is
 * tracked separately. Until then, the mailto sits as a no-op for receivers
 * that prefer the email path.
 */
export function buildUnsubscribeMailto(token: string): string {
  return `mailto:unsubscribe@growth.axisone.ca?subject=unsubscribe&body=${encodeURIComponent(
    token,
  )}`;
}
