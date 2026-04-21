/**
 * Real SendGrid webhook signature verifier — ECDSA with SendGrid's
 * public key.
 *
 * Flow: signed request = SHA256 hash of (timestamp + rawBody), signed with
 * SendGrid's ECDSA private key. We verify against the configured public
 * key (shown in SendGrid dashboard → Mail Settings → Event Webhook).
 *
 * Header map:
 *   X-Twilio-Email-Event-Webhook-Signature → base64 ECDSA signature
 *   X-Twilio-Email-Event-Webhook-Timestamp → Unix epoch seconds
 *
 * (Names are legacy — SendGrid is now a Twilio product.)
 *
 * KAN-599: ECDSA signature verification for SendGrid events
 */

import crypto from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { SignatureVerifier } from '../../webhooks/verifier.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

const secretManager = new SecretManagerServiceClient();

// Cache the decoded public key so we don't re-import on every request.
let cachedPublicKey: crypto.KeyObject | null = null;
let cachedAt = 0;
const KEY_TTL_MS = 30 * 60 * 1000; // 30 min

async function loadPublicKey(): Promise<crypto.KeyObject | null> {
  if (cachedPublicKey && Date.now() - cachedAt < KEY_TTL_MS) return cachedPublicKey;
  try {
    const name = `projects/${env.GCP_PROJECT_ID}/secrets/sendgrid-webhook-public-key/versions/latest`;
    const [version] = await secretManager.accessSecretVersion({ name });
    const payload = version.payload?.data?.toString().trim();
    if (!payload) return null;
    // The stored key is a base64 DER or PEM. SendGrid provides PEM in the dashboard.
    cachedPublicKey = crypto.createPublicKey(payload);
    cachedAt = Date.now();
    return cachedPublicKey;
  } catch (err) {
    logger.error({ err }, 'failed to load SendGrid webhook public key');
    return null;
  }
}

export class SendGridRealSignatureVerifier implements SignatureVerifier {
  readonly provider = 'sendgrid';

  async verify(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const signature = headers['x-twilio-email-event-webhook-signature'];
    const timestamp = headers['x-twilio-email-event-webhook-timestamp'];
    if (!signature || !timestamp) return false;

    // Reject timestamps more than 10 min old (replay protection)
    const ts = Number.parseInt(timestamp, 10);
    if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 600) {
      logger.warn({ ts }, 'sendgrid webhook timestamp out of window');
      return false;
    }

    const pubKey = await loadPublicKey();
    if (!pubKey) return false;

    // Signed payload: timestamp + rawBody
    const signedPayload = timestamp + rawBody;
    try {
      const verifier = crypto.createVerify('SHA256');
      verifier.update(signedPayload);
      verifier.end();
      return verifier.verify(pubKey, signature, 'base64');
    } catch (err) {
      logger.warn({ err }, 'sendgrid signature verify threw');
      return false;
    }
  }
}
