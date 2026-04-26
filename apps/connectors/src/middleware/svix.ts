/**
 * Svix signature verification middleware (KAN-684) — Resend uses Svix as its
 * webhook delivery infrastructure, so signature verification follows Svix's
 * scheme rather than a Resend-specific one.
 *
 * Headers Svix sets on every webhook POST:
 *   svix-id            unique message id (also used as our idempotency key)
 *   svix-timestamp     unix seconds; old timestamps rejected to bound replay window
 *   svix-signature     hmac signatures (space-separated for key rotation)
 *
 * The `svix` npm package's `Webhook.verify()` does the actual crypto + replay
 * window check (default ±5 min). We just adapt its raw-body / headers
 * contract to Hono.
 *
 * Failure → 400 (NOT 401). Resend retries on 5xx and gives up on 4xx, so a
 * 400 short-circuits the retry storm that a 401 would trigger if a key
 * rotation lagged on our side. Any successful verification stashes the
 * parsed payload in `c.set('svixPayload', ...)` for the handler to pick up.
 *
 * Verifier is injectable for unit tests — pass a stub that throws or returns
 * a fixed payload.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { Webhook } from 'svix';
import { env } from '../env.js';
import { logger } from '../logger.js';

export type SvixVerifyFn = (
  rawBody: string,
  headers: Record<string, string>,
) => unknown;

/** Adapter type so route handlers can read the parsed payload + svix-id. */
export interface SvixContext {
  payload: Record<string, unknown>;
  svixId: string;
  svixTimestamp: string;
}

export function buildSvixMiddleware(opts: {
  signingSecret?: string;
  verifier?: SvixVerifyFn;
} = {}): MiddlewareHandler {
  return async (c, next) => {
    const secret = opts.signingSecret ?? env.RESEND_WEBHOOK_SIGNING_SECRET;
    if (!secret) {
      logger.error('[svix] RESEND_WEBHOOK_SIGNING_SECRET unset — cannot verify webhook');
      return c.json({ error: 'webhook verification unavailable' }, 503);
    }

    const svixId = c.req.header('svix-id');
    const svixTimestamp = c.req.header('svix-timestamp');
    const svixSignature = c.req.header('svix-signature');
    if (!svixId || !svixTimestamp || !svixSignature) {
      logger.warn(
        { hasId: !!svixId, hasTs: !!svixTimestamp, hasSig: !!svixSignature },
        '[svix] missing required signature headers',
      );
      return c.json({ error: 'missing svix headers' }, 400);
    }

    const rawBody = await c.req.text();
    const headers = {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    };

    let payload: unknown;
    try {
      const verify: SvixVerifyFn =
        opts.verifier ??
        ((body, hdrs) => new Webhook(secret).verify(body, hdrs));
      payload = verify(rawBody, headers);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), svixId },
        '[svix] signature verification failed',
      );
      return c.json({ error: 'svix signature verification failed' }, 400);
    }

    if (!payload || typeof payload !== 'object') {
      return c.json({ error: 'svix payload is not an object' }, 400);
    }

    const ctx: SvixContext = {
      payload: payload as Record<string, unknown>,
      svixId,
      svixTimestamp,
    };
    c.set('svix', ctx as unknown as never);
    return next();
  };
}

export function getSvixContext(c: Context): SvixContext {
  const ctx = c.get('svix' as never) as SvixContext | undefined;
  if (!ctx) throw new Error('svix middleware did not run before handler');
  return ctx;
}
