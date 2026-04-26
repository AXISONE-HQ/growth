/**
 * Hono app composition — routes, middleware, tRPC mount.
 */

import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { logger as pinoLogger } from './logger.js';
import { registerAdapters } from './adapters/index.js';
import { webhooksApp } from './webhooks/index.js';
import { resendWebhookApp } from './webhooks/resend.js';
import { actionSendPushApp } from './subscribers/action-send-push.js';
import { unsubscribeApp } from './routes/unsubscribe.js';
import { buildOidcMiddleware } from './middleware/oidc.js';
import { connectorsRouter } from './trpc/index.js';
import { createContext } from './trpc/context.js';

export function buildApp(): Hono {
  registerAdapters();

  const app = new Hono();

  // Request logging middleware
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    pinoLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - start,
      },
      'request',
    );
  });

  // Health endpoints (Cloud Run probes)
  app.get('/healthz', (c) => c.json({ status: 'ok', service: '@growth-ai/connectors' }));
  app.get('/readyz', (c) => c.json({ ready: true }));

  // KAN-684 — Resend-specific webhook handler. Mounted BEFORE the generic
  // /webhooks/:provider dispatcher so the more-specific path wins routing
  // (Hono honors registration order). Svix-signed; public; no OIDC.
  app.route('/webhooks/resend', resendWebhookApp);

  // Public webhook ingress (generic dispatcher for Twilio / Meta — Resend
  // is handled above by its own dedicated handler).
  app.route('/webhooks', webhooksApp);

  // Public unsubscribe landing (no auth — capability URL) — KAN-661
  app.route('/unsubscribe', unsubscribeApp);

  // Pub/Sub push subscriptions — OIDC verified at app-layer middleware (KAN-688).
  // Companion to PR #29's RFC 8058 work: the service is `--allow-unauthenticated`
  // so RFC 8058 one-click POSTs from Microsoft / Gmail filters reach `/unsubscribe`,
  // which means anything sensitive (Pub/Sub push, etc.) needs its own auth check.
  app.use('/pubsub/*', buildOidcMiddleware());
  app.route('/pubsub', actionSendPushApp);

  // Private VPC tRPC endpoint for Connection Manager
  app.use(
    '/trpc/*',
    trpcServer({
      router: connectorsRouter,
      createContext: (_opts, c) => createContext({ req: c.req.raw }),
    }),
  );

  // Catch-all 404
  app.notFound((c) => c.json({ error: 'Not Found' }, 404));

  app.onError((err, c) => {
    pinoLogger.error({ err }, 'unhandled error');
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}
