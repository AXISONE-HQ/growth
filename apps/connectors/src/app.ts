/**
 * Hono app composition — routes, middleware, tRPC mount.
 */

import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { logger as pinoLogger } from './logger.js';
import { registerAdapters } from './adapters/index.js';
import { webhooksApp } from './webhooks/index.js';
import { pubsubApp } from './pubsub/subscriber.js';
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

  // Public webhook ingress
  app.route('/webhooks', webhooksApp);

  // Pub/Sub push subscriptions (IAM-authed by Cloud Run)
  app.route('/pubsub', pubsubApp);

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
