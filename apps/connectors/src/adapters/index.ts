/**
 * Adapter registration.
 *
 * Register every production adapter here. Order doesn't matter.
 * Feature flags gate real adapters; NoOp is always registered in
 * non-production for local testing.
 *
 * When adding a new adapter (KAN-491 Twilio, KAN-510 Meta, etc):
 *   1. Create the adapter file under src/adapters/<provider>/
 *   2. Import and register it below
 *   3. Add its feature flag to src/env.ts
 *   4. Add its webhook route in src/webhooks/
 */

import { env } from '../env.js';
import { logger } from '../logger.js';
import { verifierRegistry } from '../webhooks/verifier.js';
import { NoopAdapter } from './noop.js';
import { registry } from './registry.js';
import { TwilioAdapter } from './twilio/index.js';
import { TwilioRealSignatureVerifier } from './twilio/signature.js';
import { ResendAdapter } from './resend/index.js';
import { MetaAdapter } from './meta/index.js';
import { MetaRealSignatureVerifier } from './meta/signature.js';

export function registerAdapters(): void {
  if (env.NODE_ENV !== 'production') {
    registry.register(new NoopAdapter());
  }

  // KAN-472 — Twilio SMS
  if (env.ENABLE_TWILIO) {
    registry.register(new TwilioAdapter());
    // Real HMAC-SHA1 verifier replaces the fail-safe stub (KAN-575)
    verifierRegistry.register(new TwilioRealSignatureVerifier());
  }

  // Email — Resend (replaces SendGrid; KAN-473 epic re-scope pending).
  // Webhook signature verifier deferred to KAN-684 alongside the Resend
  // event-webhook handler.
  if (env.ENABLE_RESEND) {
    registry.register(new ResendAdapter());
  }

  // KAN-474 — Meta Messenger
  if (env.ENABLE_META) {
    registry.register(new MetaAdapter());
    // Real HMAC-SHA256 verifier replaces the fail-safe stub (KAN-626)
    verifierRegistry.register(new MetaRealSignatureVerifier());
  }

  // TODO(KAN-510): Meta Messenger adapter
  // if (env.ENABLE_META) registry.register(new MetaAdapter(...))

  const adapters = registry.list();
  logger.info(
    { count: adapters.length, adapters: adapters.map((a) => `${a.channel}:${a.provider}`) },
    'Adapters registered',
  );
}

export { registry } from './registry.js';
