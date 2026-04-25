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

// Production verifiers (Twilio/Meta) register themselves from their adapter
// bootstraps. The Resend verifier (KAN-684) lands with the Resend webhook
// handler. No fail-safe stubs remain.

// (see apps/connectors/src/adapters/{twilio,meta}/signature.ts).
