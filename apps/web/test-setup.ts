/**
 * KAN-829 sub-cohort 2 — vitest test setup for apps/web component tests.
 *
 * Imports jest-dom matchers via expect.extend (the `/vitest` subpath has a
 * known testPath getter incompat with vitest 1.x — pin pattern below works
 * across vitest 0.x / 1.x / 2.x). Registers toBeInTheDocument + class/style
 * matchers globally so test files don't need to import them individually.
 */
import { expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────
// KAN-866 — EventSource stub for SSE consumer tests (jsdom doesn't
// ship one). First consumer: scanning-state-card.tsx. Reusable for
// any future EventSource-driven UI.
//
// Tests get full control over the stream by reaching for the latest
// instance via `MockEventSource.lastInstance` and dispatching events
// directly: `MockEventSource.lastInstance?.dispatch('progress', {...})`.
// ─────────────────────────────────────────────────────────────────
type MockEventListener = (ev: MessageEvent) => void;

class MockEventSource {
  static lastInstance: MockEventSource | null = null;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState = MockEventSource.OPEN;
  onmessage: MockEventListener | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private listeners = new Map<string, Set<MockEventListener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }

  addEventListener(type: string, listener: MockEventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: MockEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
    this.listeners.clear();
  }

  /** Test seam — dispatch a typed SSE event to all registered listeners. */
  dispatch(type: string, data: unknown): void {
    const ev = { data: JSON.stringify(data) } as MessageEvent;
    this.listeners.get(type)?.forEach((l) => l(ev));
    if (type === "message" && this.onmessage) this.onmessage(ev);
  }
}

(globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource =
  MockEventSource;
export { MockEventSource };
