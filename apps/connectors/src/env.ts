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

  // KAN-741 / Sprint 6. Separate Svix signing secret for the inbound
  // (`email.received`) webhook at /webhooks/resend-inbound. Resend's dashboard
  // issues a distinct Svix signing secret per webhook endpoint, so inbound
  // and outbound (delivery events on /webhooks/resend) cannot share one.
  // Optional at boot — when unset, the inbound middleware falls back to
  // RESEND_WEBHOOK_SIGNING_SECRET via buildSvixMiddleware() (legacy shared-
  // secret behavior, preserved for back-compat). Bind via:
  //   --update-secrets=RESEND_INBOUND_WEBHOOK_SIGNING_SECRET=resend-inbound-webhook-secret:latest
  RESEND_INBOUND_WEBHOOK_SIGNING_SECRET: z.string().optional(),

  // KAN-954. Read-scoped Resend API key for the inbound Receiving API
  // (`GET /emails/receiving/{email_id}`). Required because the `email.received`
  // webhook is metadata-only — body / reply_to / headers must be fetched
  // separately. Kept distinct from the send-only `growth-resend-key` (defense
  // in depth). Optional at boot — if unset, the handler skips body hydration
  // and falls back to current empty-body behavior (no regression for inbound
  // already working in metadata-only mode). Bind via:
  //   --update-secrets=RESEND_API_KEY_RW=growth-resend-key-rw:latest
  RESEND_API_KEY_RW: z.string().optional(),

  // KAN-741. Domain that forms per-tenant inbox addresses as
  // <tenant.inboxSlug>@<LEAD_INBOX_DOMAIN>. Apps/web also reads this for
  // address display; both services should resolve to the same value.
  LEAD_INBOX_DOMAIN: z.string().default('leads.axisone.app'),

  // KAN-741. Audience the lead.received push subscriber uses to verify
  // OIDC tokens on incoming Pub/Sub deliveries. Per KAN-731 lesson —
  // audience MUST exactly match what the subscription is configured with.
  // Set on the consumer (assignment worker, KAN-705) Cloud Run service via:
  //   --set-env-vars=LEAD_RECEIVED_AUDIENCE=https://growth-api-biut5gfhuq-uc.a.run.app/pubsub/lead-received
  LEAD_RECEIVED_AUDIENCE: z.string().optional(),

  // ── Send-redirect guardrail (founder mandate 2026-05-25) ────────────
  // Default-ON test-recipient override applied inside every ChannelAdapter
  // .send() as the FIRST line, before any provider SDK call. Even an
  // approved, executed send gets redirected while enabled. Disabling for
  // real production sends is an explicit env change to `false` —
  // documented loudly in deploy-connectors.yml and the runbook (same
  // posture as the autoApproveEnabled kill-switch).
  //
  // When ENABLED=true (the default) AND the channel-target is missing/empty,
  // applyRedirect THROWS SendRedirectMisconfiguredError — fail-closed,
  // never falls through to the real recipient. Subscriber catches → logs
  // → ACK (no retry; persistent class per KAN-1018 posture).
  //
  // Structural CI gate at adapters/_shared/__tests__/send-redirect-no-bypass.test.ts
  // proves no provider SDK call exists outside applyRedirect's reach.
  // NB: `z.coerce.boolean()` has a footgun — `Boolean('false') === true`
  // because any non-empty string is truthy. We use explicit string-token
  // parsing so an env value of "false" actually disables the guard.
  // Default 'true' means: undefined → enabled. Any value other than
  // 'false'/'0' → enabled (safe-default-on posture).
  SEND_REDIRECT_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  SEND_REDIRECT_EMAIL: z.string().email().optional(),
  SEND_REDIRECT_PHONE: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
