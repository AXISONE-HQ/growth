/**
 * Real Twilio HMAC-SHA1 signature verifier.
 * Replaces the fail-safe stub in webhooks/verifier.ts once Twilio adapter ships.
 *
 * KAN-575: Status callback HMAC verification
 *
 * Twilio signs webhook requests with:
 *   base64( HMAC-SHA1( authToken, url + sorted(body_params) ) )
 * and sends it in `X-Twilio-Signature`.
 *
 * Critical: signing uses the subaccount auth token, not the master token.
 * We look up the tenant via the incoming request (query param or
 * `AccountSid` field) and fetch the right token from Secret Manager.
 */

import crypto from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { SignatureVerifier } from '../../webhooks/verifier.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

const secretManager = new SecretManagerServiceClient();

export class TwilioRealSignatureVerifier implements SignatureVerifier {
  readonly provider = 'twilio';

  async verify(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const signatureHeader = headers['x-twilio-signature'];
    if (!signatureHeader) return false;

    // Twilio webhook bodies are form-urlencoded (x-www-form-urlencoded)
    const params = new URLSearchParams(rawBody);
    const accountSid = params.get('AccountSid');
    if (!accountSid) {
      logger.warn('twilio webhook missing AccountSid — cannot resolve tenant');
      return false;
    }

    // The URL Twilio signed against is the public webhook URL. In Cloud Run
    // behind a load balancer, we need the original URL from the X-Forwarded-* headers.
    const host = headers['x-forwarded-host'] ?? headers.host;
    const proto = headers['x-forwarded-proto'] ?? 'https';
    const path = headers['x-original-uri'] ?? '/webhooks/twilio';
    const fullUrl = `${proto}://${host}${path}`;

    // Look up subaccount auth token by AccountSid → tenant mapping.
    // We store a reverse-lookup secret: twilio-subaccount-{accountSid} → authToken.
    const authToken = await fetchAuthTokenForSubaccount(accountSid);
    if (!authToken) {
      logger.warn({ accountSid }, 'twilio subaccount not recognized');
      return false;
    }

    // Compute expected signature: HMAC-SHA1 of URL + sorted body params
    const sortedKeys = [...params.keys()].sort();
    const concat = sortedKeys.reduce((acc, key) => acc + key + params.get(key), fullUrl);
    const expected = crypto.createHmac('sha1', authToken).update(concat, 'utf8').digest('base64');

    // Timing-safe comparison
    if (expected.length !== signatureHeader.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  }
}

async function fetchAuthTokenForSubaccount(accountSid: string): Promise<string | null> {
  try {
    const name = `projects/${env.GCP_PROJECT_ID}/secrets/twilio-subaccount-${accountSid}/versions/latest`;
    const [version] = await secretManager.accessSecretVersion({ name });
    return version.payload?.data?.toString() ?? null;
  } catch (err) {
    logger.error({ err, accountSid }, 'failed to fetch twilio subaccount auth token');
    return null;
  }
}
