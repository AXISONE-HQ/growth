/**
 * Adapter registration.
 *
 * Register every production adapter here. Order doesn't matter.
 * Feature flags gate real adapters; NoOp is always registered in
 * non-production for local testing.
 *
 * When adding a new adapter (KAN-491 Twilio, KAN-499 SendGrid, KAN-510 Meta):
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
import { SendGridAdapter } from './sendgrid/index.js';
import { SendGridRealSignatureVerifier } from './sendgrid/signature.js';
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

  // KAN-473 — SendGrid Email
  if (env.ENABLE_SENDGRID) {
    registry.register(new SendGridAdapter());
    // Real ECDSA verifier replaces the fail-safe stub (KAN-599)
    verifierRegistry.register(new SendGridRealSignatureVerifier());
  }

  // KAN-474 — Meta Messenger
  if (env.ENABLE_META) {
    registry.register(new MetaAdapter());
    // Real HMAC-SHA256 verifier replaces the fail-safe stub (KAN-626)
    verifierRegistry.register(new MetaRealSignatureVerifier());
  }

  // TODO(KAN-499): SendGrid adapter
  // if (env.ENABLE_SENDGRID) registry.register(new SendGridAdapter(...))

  // TODO(KAN-510): Meta Messenger adapter
  // if (env.ENABLE_META) registry.register(new MetaAdapter(...))

  const adapters = registry.list();
  logger.info(
    { count: adapters.length, adapters: adapters.map((a) => `${a.channel}:${a.provider}`) },
    'Adapters registered',
  );
}

export { registry } from './registry.js';
