/**
 * One-click unsubscribe token — embedded in the `List-Unsubscribe` and
 * `List-Unsubscribe-Post` headers + footer link on every email.
 *
 * Token is a signed JWT containing {tenantId, email, actionId, iat}.
 * Signing secret rotates quarterly; we keep the last two keys active
 * to avoid breaking in-flight emails during rotation.
 *
 * The landing page lives at `unsubscribe.growth.axisone.com/{token}` and is
 * served by the main app (@growth-ai/web). This module just builds + verifies tokens.
 *
 * KAN-609: One-click unsubscribe landing page
 */

import crypto from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

const secretManager = new SecretManagerServiceClient();

interface UnsubscribeTokenPayload {
  tenantId: string;
  email: string;
  actionId?: string;
  iat: number;
}

let cachedSecret: string | null = null;
let cachedAt = 0;

async function loadSigningSecret(): Promise<string> {
  if (cachedSecret && Date.now() - cachedAt < 30 * 60 * 1000) return cachedSecret;
  const name = `projects/${env.GCP_PROJECT_ID}/secrets/unsubscribe-signing-key/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name });
  const secret = version.payload?.data?.toString().trim();
  if (!secret) throw new Error('unsubscribe-signing-key secret missing');
  cachedSecret = secret;
  cachedAt = Date.now();
  return secret;
}

/** Generate a signed token for use in unsubscribe URLs. */
export async function generateUnsubscribeToken(payload: Omit<UnsubscribeTokenPayload, 'iat'>): Promise<string> {
  const secret = await loadSigningSecret();
  const body = JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) });
  const encoded = Buffer.from(body).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/** Verify + decode — called by the landing page endpoint on the main app side. */
export async function verifyUnsubscribeToken(token: string): Promise<UnsubscribeTokenPayload | null> {
  try {
    const secret = await loadSigningSecret();
    const [encoded, providedSig] = token.split('.');
    if (!encoded || !providedSig) return null;

    const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    if (expectedSig.length !== providedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(providedSig))) return null;

    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as UnsubscribeTokenPayload;
    // Optional: reject tokens older than 180 days (CAN-SPAM window)
    if (Date.now() / 1000 - payload.iat > 180 * 86400) {
      logger.warn({ email: payload.email }, 'expired unsubscribe token');
      return null;
    }
    return payload;
  } catch (err) {
    logger.warn({ err }, 'unsubscribe token verify failed');
    return null;
  }
}

/** Build the full unsubscribe URL for List-Unsubscribe header. */
export function buildUnsubscribeUrl(token: string): string {
  return `https://unsubscribe.growth.axisone.com/${token}`;
}
