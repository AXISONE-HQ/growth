/**
 * PubSub client factory — env-gated between InMemory (tests + emulator) and
 * real Cloud Pub/Sub (prod/staging on Cloud Run).
 *
 * Single source of truth for PubSub client instantiation across the API.
 * Singleton per process — the client itself is cheap to construct, but
 * memoization matches the pattern used for the other adapters (audit pubsub,
 * context cache) in run-decision-for-contact.ts.
 *
 * Env contract:
 *   - PUBSUB_EMULATOR_HOST set     → InMemoryPubSubClient (local dev via emulator)
 *   - NODE_ENV === 'test'          → InMemoryPubSubClient (vitest / unit tests)
 *   - otherwise                    → CloudPubSubClient (GCP_PROJECT_ID required)
 */

import {
  CloudPubSubClient,
  InMemoryPubSubClient,
  type PubSubClient,
} from '../services/action-decided-publisher';

let cached: PubSubClient | null = null;

export function getPubSubClient(): PubSubClient {
  if (cached) return cached;
  if (process.env.PUBSUB_EMULATOR_HOST || process.env.NODE_ENV === 'test') {
    cached = new InMemoryPubSubClient();
    return cached;
  }
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      'GCP_PROJECT_ID env var is required when not in test/emulator mode',
    );
  }
  cached = new CloudPubSubClient(projectId);
  return cached;
}
