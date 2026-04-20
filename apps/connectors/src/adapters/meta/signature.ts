/**
 * Real Meta webhook signature verifier — HMAC-SHA256 with App Secret.
 *
 * Meta signs every webhook request with:
 *   X-Hub-Signature-256: sha256={hex}
 * where the hex is HMAC-SHA256(rawBody, appSecret).
 *
 * Also handles the GET subscription challenge flow (hub.mode=subscribe)
 * — though that's a webhook ROUTER concern, not signature verification.
 *
 * KAN-626: Meta HMAC-SHA256 via App Secret
 */

import crypto from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { SignatureVerifier } from '../../webhooks/verifier.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

const secretManager = new SecretManagerServiceClient();

let cachedSecret: string | null = null;
let cachedAt = 0;
const SECRET_TTL_MS = 30 * 60 * 1000;

async function loadAppSecret(): Promise<string | null> {
  if (cachedSecret && Date.now() - cachedAt < SECRET_TTL_MS) return cachedSecret;
  try {
    const name = `projects/${env.GCP_PROJECT_ID}/secrets/axisone/meta-app/app-secret/versions/latest`;
    const [version] = await secretManager.accessSecretVersion({ name });
    const secret = version.payload?.data?.toString().trim();
    if (!secret) return null;
    cachedSecret = secret;
    cachedAt = Date.now();
    return cachedSecret;
  } catch (err) {
    logger.error({ err }, 'failed to load Meta App Secret');
    return null;
  }
}

export class MetaRealSignatureVerifier implements SignatureVerifier {
  readonly provider = 'meta';

  async verify(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const header = headers['x-hub-signature-256'];
    if (!header) return false;
    if (!header.startsWith('sha256=')) return false;

    const providedHex = header.slice('sha256='.length);
    const appSecret = await loadAppSecret();
    if (!appSecret) return false;

    const expectedHex = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody, 'utf8')
      .digest('hex');

    if (expectedHex.length !== providedHex.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(providedHex, 'hex'));
  }
}

/** Load the webhook verify token used for the GET subscription challenge. */
export async function loadWebhookVerifyToken(): Promise<string | null> {
  try {
    const name = `projects/${env.GCP_PROJECT_ID}/secrets/axisone/meta-app/webhook-verify-token/versions/latest`;
    const [version] = await secretManager.accessSecretVersion({ name });
    return version.payload?.data?.toString().trim() ?? null;
  } catch (err) {
    logger.error({ err }, 'failed to load Meta webhook verify token');
    return null;
  }
}
