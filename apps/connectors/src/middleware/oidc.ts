/**
 * App-layer OIDC middleware for Pub/Sub push routes (KAN-688).
 *
 * Cloud Run service-level auth is all-or-nothing — flipping the service to
 * `--allow-unauthenticated` (required so RFC 8058 one-click POSTs from
 * Microsoft / Gmail filters reach `/unsubscribe`) would otherwise expose
 * `/pubsub/*` routes to anonymous publishers. This middleware enforces
 * Pub/Sub OIDC at the app layer instead, mounted on `/pubsub/*` only.
 *
 * Verifies four claims against Google's published keys:
 *   - signature + expiry valid (delegated to OAuth2Client.verifyIdToken)
 *   - iss === 'https://accounts.google.com'
 *   - aud === PUBLIC_WEBHOOK_BASE_URL (matches the audience Pub/Sub sets
 *     on the subscription's pushConfig.oidcToken)
 *   - email === pubsub-invoker@growth-493400.iam.gserviceaccount.com
 *     (the SA we configured Pub/Sub to mint tokens with)
 *
 * 401 + JSON body on any failure. Skip via PUBSUB_PUSH_SKIP_AUTH=true
 * (test-only; local dev), or NODE_ENV=test.
 */
import type { MiddlewareHandler } from 'hono';
import { OAuth2Client, type LoginTicket, type TokenPayload } from 'google-auth-library';
import { logger } from '../logger.js';

const EXPECTED_ISS = 'https://accounts.google.com';
const EXPECTED_EMAIL = 'pubsub-invoker@growth-493400.iam.gserviceaccount.com';

const oauth = new OAuth2Client();

export type VerifyFn = (params: { idToken: string; audience: string }) => Promise<LoginTicket>;

/**
 * Build the middleware. The verifier is injectable for unit tests so they
 * don't have to mock module imports — pass a stub that resolves to a fixed
 * payload.
 */
export function buildOidcMiddleware(opts: {
  expectedAudience?: string;
  expectedEmail?: string;
  verifier?: VerifyFn;
} = {}): MiddlewareHandler {
  const expectedEmail = opts.expectedEmail ?? EXPECTED_EMAIL;
  const verifier: VerifyFn =
    opts.verifier ?? ((p) => oauth.verifyIdToken(p));

  return async (c, next) => {
    if (process.env.NODE_ENV === 'test' || process.env.PUBSUB_PUSH_SKIP_AUTH === 'true') {
      return next();
    }

    const audience = opts.expectedAudience ?? process.env.PUBLIC_WEBHOOK_BASE_URL;
    if (!audience) {
      logger.error('[oidc] PUBLIC_WEBHOOK_BASE_URL unset — cannot verify OIDC audience');
      return c.json({ error: 'server misconfigured', reason: 'audience unset' }, 500);
    }

    const authHeader = c.req.header('authorization');
    if (!authHeader) {
      return c.json({ error: 'oidc verification failed', reason: 'no authorization header' }, 401);
    }
    if (!authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'oidc verification failed', reason: 'malformed authorization header' }, 401);
    }
    const idToken = authHeader.slice('Bearer '.length).trim();
    if (!idToken) {
      return c.json({ error: 'oidc verification failed', reason: 'empty bearer token' }, 401);
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await verifier({ idToken, audience });
      payload = ticket.getPayload();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[oidc] verifyIdToken threw');
      return c.json({ error: 'oidc verification failed', reason: 'invalid signature or expired token' }, 401);
    }

    if (!payload) {
      return c.json({ error: 'oidc verification failed', reason: 'token has no payload' }, 401);
    }
    if (payload.iss !== EXPECTED_ISS) {
      logger.warn({ iss: payload.iss }, '[oidc] unexpected issuer');
      return c.json({ error: 'oidc verification failed', reason: 'wrong issuer' }, 401);
    }
    if (payload.aud !== audience) {
      logger.warn({ aud: payload.aud, expected: audience }, '[oidc] unexpected audience');
      return c.json({ error: 'oidc verification failed', reason: 'wrong audience' }, 401);
    }
    if (payload.email !== expectedEmail) {
      logger.warn({ email: payload.email, expected: expectedEmail }, '[oidc] unexpected service account');
      return c.json({ error: 'oidc verification failed', reason: 'wrong service account' }, 401);
    }

    return next();
  };
}
