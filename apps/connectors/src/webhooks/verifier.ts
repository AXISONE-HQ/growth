/**
 * Webhook signature verification — plugin architecture.
 * Each provider plugs in its own verifier; the webhook router
 * looks up by provider name and rejects (401) on mismatch.
 *
 * KAN-530: Signature verifier plugin architecture
 */

export interface SignatureVerifier {
  readonly provider: string;
  verify(rawBody: string, headers: Record<string, string>): Promise<boolean>;
}

class VerifierRegistry {
  private readonly verifiers = new Map<string, SignatureVerifier>();

  register(v: SignatureVerifier): void {
    this.verifiers.set(v.provider, v);
  }

  get(provider: string): SignatureVerifier | undefined {
    return this.verifiers.get(provider);
  }
}

export const verifierRegistry = new VerifierRegistry();

// All three production verifiers (Twilio/SendGrid/Meta) register themselves from
// their adapter bootstraps. No fail-safe stubs remain.

// No stubs registered. Real verifiers register themselves from their adapter bootstraps
// (see apps/connectors/src/adapters/{twilio,sendgrid,meta}/signature.ts).
