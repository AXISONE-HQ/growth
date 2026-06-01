/**
 * KAN-1046 — `republishActionDecidedEvent` unit tests.
 *
 * Background: pre-KAN-1046 the deferred-send cron replayed engine-path
 * rows by calling `publishActionDecided` (the builder), which rebuilds
 * the envelope from a *flat* `PublishActionInput`. The stashed payload
 * is the previously-built *nested* envelope, so every replay threw
 * `ZodError` at the schema parse and rows were left `pending` forever.
 *
 * `republishActionDecidedEvent` is the replay-path-correct counterpart:
 *   - takes the already-built nested envelope verbatim
 *   - `safeParse`s it against `ActionDecidedEventSchema` for defense in
 *     depth (corrupted JSON rows surface cleanly via the caller's audit
 *     row rather than throwing through the cron's outer catch)
 *   - publishes verbatim on success
 *
 * Coverage:
 *   1. Valid envelope → safeParse passes → publishes to ACTION_DECIDED_TOPIC
 *      with the correct attributes → returns {published:true, messageId}
 *   2. Corrupted envelope (missing decision.confidenceScore) → safeParse
 *      fails → returns {published:false, messageId:null}, no client.publish
 *   3. client.publish throws → caught → returns {published:false, messageId:null}
 */
import { describe, it, expect, vi } from 'vitest';
import {
  republishActionDecidedEvent,
  type PubSubClient,
} from '../action-decided-publisher.js';

function makeValidEnvelope(): Record<string, unknown> {
  return {
    eventId: 'evt-1046-1',
    eventType: 'action.decided',
    version: '1.0',
    publishedAt: '2026-06-01T01:00:00.000Z',
    tenantId: 'tenant-x',
    contactId: 'contact-x',
    objectiveId: 'obj-x',
    decisionId: 'decision-x',
    action: {
      actionType: 'send_followup_email',
      channel: 'email',
      payload: { instruction: 'follow up' },
    },
    decision: {
      selectedStrategy: 'agentic',
      confidenceScore: 80,
      strategyReasoning: 'r',
      actionReasoning: 'a',
    },
    routing: {
      agentType: 'communication',
      priority: 'normal',
      maxRetries: 3,
      timeoutMs: 15000,
    },
  };
}

describe('KAN-1046 — republishActionDecidedEvent', () => {
  it('valid stashed envelope → safeParse passes → publishes verbatim to action.decided', async () => {
    const publishMock = vi.fn(async () => 'pubsub_msg_1046');
    const client: PubSubClient = { publish: publishMock };
    const envelope = makeValidEnvelope();

    const result = await republishActionDecidedEvent(client, envelope);

    expect(result.published).toBe(true);
    expect(result.messageId).toBe('pubsub_msg_1046');
    expect(publishMock).toHaveBeenCalledTimes(1);
    const [topic, data, attributes] = publishMock.mock.calls[0]!;
    // Unprefixed topic per KAN-661 (same as publishActionDecided's path).
    expect(topic).toBe('action.decided');
    // Attribute set must mirror the existing publishActionDecided
    // shape so the subscriber's pull contract is unchanged.
    expect(attributes).toMatchObject({
      eventType: 'action.decided',
      tenantId: 'tenant-x',
      version: '1.0',
    });
    // The published JSON is the verbatim parsed envelope — same shape
    // downstream consumers (action-decided-push.ts) read for the
    // load-bearing decision.* fields.
    const publishedJson = JSON.parse((data as Buffer).toString());
    expect(publishedJson).toMatchObject({
      eventId: 'evt-1046-1',
      decision: {
        selectedStrategy: 'agentic',
        confidenceScore: 80,
        strategyReasoning: 'r',
        actionReasoning: 'a',
      },
      action: { actionType: 'send_followup_email', channel: 'email' },
    });
  });

  it('corrupted envelope (missing decision.confidenceScore) → safeParse fails → returns published:false, no client.publish', async () => {
    const publishMock = vi.fn(async () => 'should_not_be_called');
    const client: PubSubClient = { publish: publishMock };
    const corrupted = makeValidEnvelope();
    // Strip a required field from the decision sub-object — exactly the
    // shape KAN-1046's root-cause Zod errors flagged in PROD.
    delete (corrupted.decision as Record<string, unknown>).confidenceScore;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await republishActionDecidedEvent(client, corrupted);

    expect(result.published).toBe(false);
    expect(result.messageId).toBe(null);
    expect(publishMock).not.toHaveBeenCalled();
    // safeParse failure logged so it's greppable in the cron logs.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('client.publish throws → caught → returns published:false, messageId:null', async () => {
    const publishMock = vi.fn(async () => {
      throw new Error('pubsub down');
    });
    const client: PubSubClient = { publish: publishMock };
    const envelope = makeValidEnvelope();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await republishActionDecidedEvent(client, envelope);

    expect(result.published).toBe(false);
    expect(result.messageId).toBe(null);
    expect(publishMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
