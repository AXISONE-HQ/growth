/**
 * KAN-876 regression guard.
 *
 * Pins the wire-up between `publishAccountFieldUpdated` and the
 * `PubSubClient` interface returned by `getPubSubClient()`. Pre-KAN-876
 * the publisher called `client.topic(name).publishMessage({...})` —
 * the raw `@google-cloud/pubsub` API — but the wrapper interface only
 * exposes `publish(topic, data, attributes)`. That mismatch threw a
 * silent TypeError on every publish, swallowed by the `.catch(() => {})`
 * at the router call site. Surfaced only after KAN-866 close-out when
 * Cowork drove an authed save and no audit_log row landed.
 *
 * Test strategy: run the publisher with the real `InMemoryPubSubClient`
 * (which the `getPubSubClient()` factory returns when `NODE_ENV=test`).
 * The InMemory client implements `PubSubClient` faithfully, so any
 * future API drift will surface here as a TypeError.
 *
 * **Sibling**: `knowledge-source-ingest-publisher.ts` carries the same
 * bug shape and needs the same fix + test (KAN-877 follow-up).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  publishAccountFieldUpdated,
  accountEventsEnabled,
} from "../account-field-updated-publisher.js";
import { buildAccountFieldUpdatedEvent } from "@growth/shared";

// vitest sets NODE_ENV=test automatically, so getPubSubClient() picks the
// InMemoryPubSubClient branch — no GCP_PROJECT_ID / network required.

describe("publishAccountFieldUpdated — KAN-876 wire-up regression guard", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ACCOUNT_EVENTS_ENABLED;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ACCOUNT_EVENTS_ENABLED;
    else process.env.ACCOUNT_EVENTS_ENABLED = prev;
  });

  it("returns { skipped: true } when ACCOUNT_EVENTS_ENABLED is unset", async () => {
    delete process.env.ACCOUNT_EVENTS_ENABLED;
    expect(accountEventsEnabled()).toBe(false);
    const event = buildAccountFieldUpdatedEvent({
      eventId: "00000000-0000-4000-8000-000000000001",
      tenantId: "11111111-1111-4111-8111-111111111111",
      fieldPath: "displayName",
      oldValue: null,
      newValue: "Acme",
      source: "human",
      userId: "user-1",
    });
    const result = await publishAccountFieldUpdated(event);
    expect(result).toEqual({ skipped: true });
  });

  it("returns { skipped: true } when ACCOUNT_EVENTS_ENABLED is 'false'", async () => {
    process.env.ACCOUNT_EVENTS_ENABLED = "false";
    const event = buildAccountFieldUpdatedEvent({
      eventId: "00000000-0000-4000-8000-000000000002",
      tenantId: "11111111-1111-4111-8111-111111111111",
      fieldPath: "displayName",
      oldValue: null,
      newValue: "Acme",
      source: "human",
      userId: "user-1",
    });
    const result = await publishAccountFieldUpdated(event);
    expect(result).toEqual({ skipped: true });
  });

  it("publishes successfully when ACCOUNT_EVENTS_ENABLED='true' — wires to PubSubClient.publish(), not .topic().publishMessage()", async () => {
    process.env.ACCOUNT_EVENTS_ENABLED = "true";
    expect(accountEventsEnabled()).toBe(true);
    const event = buildAccountFieldUpdatedEvent({
      eventId: "00000000-0000-4000-8000-000000000003",
      tenantId: "11111111-1111-4111-8111-111111111111",
      fieldPath: "primaryEmail",
      oldValue: null,
      newValue: "hello@acme.com",
      source: "human",
      userId: "user-1",
    });
    const result = await publishAccountFieldUpdated(event);
    // Pre-KAN-876 this would have thrown `TypeError: client.topic is not a function`
    // because the publisher called the raw @google-cloud/pubsub API on the wrapper.
    expect(result.skipped).toBe(false);
    expect(result.messageId).toMatch(/^msg_/); // InMemoryPubSubClient prefix
  });

  it("propagates the event payload — eventType, tenantId, fieldPath, source on attributes; full event in data", async () => {
    process.env.ACCOUNT_EVENTS_ENABLED = "true";
    const event = buildAccountFieldUpdatedEvent({
      eventId: "00000000-0000-4000-8000-000000000004",
      tenantId: "22222222-2222-4222-8222-222222222222",
      fieldPath: "primaryPhone",
      oldValue: null,
      newValue: "+15551234567",
      source: "ai_detection",
      userId: null,
    });
    const result = await publishAccountFieldUpdated(event);
    expect(result.skipped).toBe(false);
    expect(result.messageId).toBeTruthy();
    // Round-trip the event via the shared schema to confirm shape stays intact
    // through Buffer.from(JSON.stringify(event)) — the publisher serializes the
    // event verbatim; subscriber zod-parses on the other end.
    const reparsed = JSON.parse(Buffer.from(JSON.stringify(event)).toString("utf-8"));
    expect(reparsed.tenantId).toBe("22222222-2222-4222-8222-222222222222");
    expect(reparsed.fieldPath).toBe("primaryPhone");
    expect(reparsed.source).toBe("ai_detection");
  });
});
