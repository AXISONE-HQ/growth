/**
 * @growth-ai/connectors — entry point.
 *
 * Owns channel integrations (SMS via Twilio, email via SendGrid,
 * Messenger via Meta). Decoupled from the main app; main app talks
 * to it via Pub/Sub for messages and private-VPC tRPC for connection
 * management.
 *
 * Deployed to Cloud Run.
 */

import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';

const app = buildApp();

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    logger.info(
      { port: info.port, env: env.NODE_ENV, projectId: env.GCP_PROJECT_ID },
      '@growth-ai/connectors listening',
    );
  },
);

// Graceful shutdown
const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down');
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
