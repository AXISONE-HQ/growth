/**
 * Environment configuration — validated at startup via Zod.
 * Fail-fast if any required env var is missing or malformed.
 */

import { z } from 'zod';
import 'dotenv/config';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8081),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // GCP
  GCP_PROJECT_ID: z.string().min(1),
  PUBSUB_EMULATOR_HOST: z.string().optional(), // local dev only

  // Database (shared with @growth-ai/api)
  DATABASE_URL: z.string().url(),

  // Redis / Memorystore
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // tRPC private VPC endpoint
  INTERNAL_TRPC_AUTH_TOKEN: z.string().min(32), // IAM-authenticated in prod

  // Public base URL for provider webhook callbacks
  // e.g. https://connectors.growth.axisone.com
  PUBLIC_WEBHOOK_BASE_URL: z.string().url().optional(),

  // Feature flags — default all channels off so the service boots clean before adapters land
  ENABLE_TWILIO: z.coerce.boolean().default(false),
  ENABLE_SENDGRID: z.coerce.boolean().default(false),
  ENABLE_META: z.coerce.boolean().default(false),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
