/**
 * Adapter registry — the DI container for ChannelAdapters.
 * Adapters self-register at startup; the outbound consumer + webhook
 * router look them up by (channel, provider).
 */

import type {
  AdapterRegistry,
  ChannelAdapter,
  ChannelType,
  Provider,
} from '@growth/connector-contracts';

class InMemoryAdapterRegistry implements AdapterRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  private key(channel: ChannelType, provider: Provider): string {
    return `${channel}:${provider}`;
  }

  register(adapter: ChannelAdapter): void {
    const k = this.key(adapter.channel, adapter.provider);
    if (this.adapters.has(k)) {
      throw new Error(
        `Adapter already registered for ${k}. Check adapters/index.ts for duplicates.`,
      );
    }
    this.adapters.set(k, adapter);
  }

  get(channel: ChannelType, provider: Provider): ChannelAdapter {
    const adapter = this.adapters.get(this.key(channel, provider));
    if (!adapter) {
      throw new Error(
        `No adapter registered for channel=${channel} provider=${provider}. ` +
          `Did you forget to register it in adapters/index.ts?`,
      );
    }
    return adapter;
  }

  list(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export const registry: AdapterRegistry = new InMemoryAdapterRegistry();
