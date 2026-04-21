/**
 * The ChannelAdapter interface.
 *
 * Every provider integration (Twilio, SendGrid, Meta, WhatsApp, ...)
 * implements this interface. The Connectors Service routes all I/O
 * through this single shape, which means adding a new provider is a
 * new file, not a framework change.
 *
 * Implementation checklist for a new adapter:
 *   [ ] Implement all methods below
 *   [ ] Register in apps/connectors/src/adapters/index.ts
 *   [ ] Add webhook route + signature verifier in src/webhooks/
 *   [ ] Store secrets at Secret Manager path `{tenant_id}/{provider}/*`
 *   [ ] Add integration tests against provider sandbox
 *   [ ] Document provisioning UX in the PRD
 */

import type {
  ChannelConnection,
  ChannelType,
  ConnectInput,
  HealthStatus,
  InboundEvent,
  OutboundMessage,
  Provider,
  SendResult,
  TenantRef,
} from './types.js';

export interface ChannelAdapter {
  /** Channel this adapter handles — used by the registry. */
  readonly channel: ChannelType;

  /** Provider identifier, e.g. "twilio", "sendgrid", "meta". */
  readonly provider: Provider;

  /**
   * Provision a new connection for a tenant.
   * Responsible for:
   *   - Calling provider APIs (subaccount/subuser/OAuth exchange)
   *   - Storing credentials in Secret Manager
   *   - Creating the ChannelConnection row
   * Returns the provisioned connection. Must be idempotent.
   */
  connect(tenant: TenantRef, input: ConnectInput): Promise<ChannelConnection>;

  /**
   * Tear down a connection.
   * Responsible for:
   *   - Revoking provider-side subscriptions (webhooks, etc.)
   *   - Deleting or rotating credentials
   *   - Marking the ChannelConnection as REVOKED
   */
  disconnect(connection: ChannelConnection): Promise<void>;

  /**
   * Check the connection is still usable.
   * Examples:
   *   - Twilio: ping the subaccount
   *   - SendGrid: verify domain auth still valid
   *   - Meta: introspect Page Access Token
   */
  healthCheck(connection: ChannelConnection): Promise<HealthStatus>;

  /**
   * Send a message via the provider.
   * The Agent Dispatcher publishes `action.send`; the Connectors
   * Service loads the connection, calls this method, and publishes
   * `action.executed` with the result.
   *
   * MUST classify errors into transient vs permanent in the SendResult
   * so the retry policy can act appropriately.
   */
  send(connection: ChannelConnection, msg: OutboundMessage): Promise<SendResult>;

  /**
   * Convert a raw provider webhook payload into normalized InboundEvents.
   * Signature verification happens BEFORE this method is called.
   * A single payload may contain multiple events (e.g., SendGrid batches).
   */
  handleWebhook(payload: unknown, signature: string): Promise<InboundEvent[]>;
}

/** Registry contract — the Connectors Service wires these up at startup. */
export interface AdapterRegistry {
  register(adapter: ChannelAdapter): void;
  get(channel: ChannelType, provider: Provider): ChannelAdapter;
  list(): ChannelAdapter[];
}
