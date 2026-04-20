/**
 * NoOp adapter — reference implementation for testing.
 *
 * Shows the minimal shape a real adapter needs. Used for:
 *   - Integration smoke tests (no provider creds required)
 *   - CI pipeline validation
 *   - Local development when no real channel is connected
 *
 * Do NOT register this in production builds.
 */

import type {
  ChannelAdapter,
  ChannelConnection,
  ConnectInput,
  HealthStatus,
  InboundEvent,
  OutboundMessage,
  SendResult,
  TenantRef,
} from '@growth/connector-contracts';

export class NoopAdapter implements ChannelAdapter {
  readonly channel = 'SMS' as const;
  readonly provider = 'noop';

  async connect(_tenant: TenantRef, input: ConnectInput): Promise<ChannelConnection> {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      channelType: input.channel,
      provider: this.provider,
      providerAccountId: `noop-${input.tenantId}`,
      status: 'ACTIVE',
      metadata: { note: 'NoOp adapter — no real provider resources created' },
      complianceStatus: null,
      connectedAt: now,
      lastHealthCheck: now,
      healthStatus: 'healthy',
      createdAt: now,
      updatedAt: now,
    };
  }

  async disconnect(_connection: ChannelConnection): Promise<void> {
    // No-op
  }

  async healthCheck(_connection: ChannelConnection): Promise<HealthStatus> {
    return {
      healthy: true,
      checkedAt: new Date().toISOString(),
    };
  }

  async send(_connection: ChannelConnection, msg: OutboundMessage): Promise<SendResult> {
    return {
      providerMessageId: `noop-${msg.actionId}`,
      status: 'sent',
    };
  }

  async handleWebhook(_payload: unknown, _signature: string): Promise<InboundEvent[]> {
    return [];
  }
}
