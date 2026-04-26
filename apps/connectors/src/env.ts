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
  ENABLE_RESEND: z.coerce.boolean().default(false),
  ENABLE_META: z.coerce.boolean().default(false),

  // KAN-687 / RFC 8058. When true, the Resend adapter includes an HTTPS
  // one-click URL in `List-Unsubscribe`. Until DNS for growth.axisone.ca
  // → public unsubscribe endpoint is wired AND the unsubscribe-signing-key
  // secret is bound, leave false — flipping to true with a non-resolving
  // URL would let Microsoft penalize the One-Click claim.
  UNSUBSCRIBE_URL_LIVE: z.coerce.boolean().default(false),

  // KAN-684. Svix signing secret for Resend webhook signature verification.
  // Optional at boot — the webhook handler returns 503 if a request lands
  // before the secret is bound. Set on Cloud Run via:
  //   gcloud run services update growth-connectors \
  //     --update-secrets=RESEND_WEBHOOK_SIGNING_SECRET=growth-resend-webhook-secret:latest
  RESEND_WEBHOOK_SIGNING_SECRET: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
