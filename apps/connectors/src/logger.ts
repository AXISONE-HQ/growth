/**
 * Structured logger. Cloud Logging picks up Pino JSON via stdout.
 * Every log includes traceId, tenantId, channel, provider when available.
 */

import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: '@growth-ai/connectors',
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ severity: label.toUpperCase() }),
  },
});

export type Logger = typeof logger;
