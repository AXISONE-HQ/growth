/**
 * M3-1b follow-up — recommendations.accept auto-carry of discoveryTarget.
 *
 * Pre-fix gap (discovered via code inspection during M3-1b live verification
 * prep): the accept route assigned `publishInput.actionPayload =
 * input.modifiedAction.payload` unconditionally. Operator accepting a
 * discovery escalation through the standard UI (which doesn't echo back
 * the engine's discoveryTarget) stripped the discovery directive →
 * composeMessage downstream got no gapContext → routine body produced.
 *
 * Fix: read the original Decision's metadata.action.actionPayload.
 * discoveryTarget; merge into publishInput.actionPayload IFF operator's
 * payload doesn't already include it. Operator-override-wins on conflict.
 *
 * Three pinned behaviors:
 *   - AUTO-CARRY: Decision has discoveryTarget; operator's payload omits → published payload carries the original
 *   - OPERATOR OVERRIDE: Decision has target A; operator's payload has target B → published payload carries B (no shadow)
 *   - NO-OP: Decision has no discoveryTarget; operator's payload omits → published payload also omits (additive only, never injects)
 */
import { describe, it, expect, vi } from 'vitest';
import { acceptRecommendation } from '../recommendations.js';

const TENANT = 't-1';
const CONTACT = 'c-1';
const DECISION_ID = '11111111-1111-1111-1111-111111111111';
const ESC_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const ORIGINAL_DISCOVERY_TARGET = {
  subObjectiveKey: 'timeline',
  label: 'When are they looking to start?',
  triggerType: 'soft' as const,
  priorityWeight: 0.9,
  requiredAtStage: 'qualified',
};

const OPERATOR_OVERRIDE_TARGET = {
  subObjectiveKey: 'budget',
  label: "What's their budget range?",
  triggerType: 'hard' as const,
  priorityWeight: 0.85,
  requiredAtStage: 'proposal-ready',
};

function makePrisma(decisionMetadata: unknown) {
  return {
    escalation: {
      findFirst: vi.fn(async () => ({
        id: ESC_ID,
        tenantId: TENANT,
        contactId: CONTACT,
        decisionId: DECISION_ID,
        severity: 'medium',
        status: 'open',
        triggerType: 'AGENTIC_GATE_DECISION',
        triggerReason: 'low confidence',
        aiSuggestion: 'send_email via email',
        context: { objectiveId: 'obj-1' },
        decision: {
          id: DECISION_ID,
          strategySelected: 'direct',
          confidence: 0.4,
          reasoning: 'discovery directive...',
          metadata: decisionMetadata,
        },
      })),
      update: vi.fn(async () => ({})),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  } as never;
}

function makePubsub() {
  return { publish: vi.fn(async () => 'msg-123') } as never;
}

describe('M3-1b follow-up — accept-route discoveryTarget auto-carry', () => {
  it('AUTO-CARRY: Decision has discoveryTarget; modifiedAction.payload omits → published payload carries the original', async () => {
    const prisma = makePrisma({
      action: { actionPayload: { discoveryTarget: ORIGINAL_DISCOVERY_TARGET } },
    });
    const pubsubClient = makePubsub();

    await acceptRecommendation(
      { prisma, tenantId: TENANT, actor: 'uid-fred', pubsubClient },
      {
        id: ESC_ID,
        modifiedAction: {
          actionType: 'send_message',
          channel: 'email',
          payload: { instruction: 'Follow up about their interest.' },
          // discoveryTarget intentionally OMITTED — simulates standard UI accept
        },
      },
    );

    expect((pubsubClient as { publish: ReturnType<typeof vi.fn> }).publish).toHaveBeenCalledTimes(1);
    const callTuple = (pubsubClient as { publish: ReturnType<typeof vi.fn> }).publish.mock.calls[0] as unknown as [string, Buffer];
    const event = JSON.parse(callTuple[1].toString());
    expect(event.action.payload.discoveryTarget).toEqual(ORIGINAL_DISCOVERY_TARGET);
    expect(event.action.payload.instruction).toBe('Follow up about their interest.');
  });

  it('OPERATOR OVERRIDE: Decision has target A; modifiedAction.payload has target B → published payload carries B (original not shadowed)', async () => {
    const prisma = makePrisma({
      action: { actionPayload: { discoveryTarget: ORIGINAL_DISCOVERY_TARGET } },
    });
    const pubsubClient = makePubsub();

    await acceptRecommendation(
      { prisma, tenantId: TENANT, actor: 'uid-fred', pubsubClient },
      {
        id: ESC_ID,
        modifiedAction: {
          actionType: 'send_message',
          channel: 'email',
          payload: {
            instruction: 'Ask about their budget instead.',
            discoveryTarget: OPERATOR_OVERRIDE_TARGET,
          },
        },
      },
    );

    expect((pubsubClient as { publish: ReturnType<typeof vi.fn> }).publish).toHaveBeenCalledTimes(1);
    const callTuple = (pubsubClient as { publish: ReturnType<typeof vi.fn> }).publish.mock.calls[0] as unknown as [string, Buffer];
    const event = JSON.parse(callTuple[1].toString());
    expect(event.action.payload.discoveryTarget).toEqual(OPERATOR_OVERRIDE_TARGET);
    expect(event.action.payload.discoveryTarget.subObjectiveKey).toBe('budget'); // not 'timeline'
  });

  it('NO-OP: Decision has no discoveryTarget; modifiedAction.payload omits → published payload also omits (auto-carry never injects)', async () => {
    const prisma = makePrisma({
      action: { actionPayload: { instruction: 'baseline' } }, // no discoveryTarget on the Decision either
    });
    const pubsubClient = makePubsub();

    await acceptRecommendation(
      { prisma, tenantId: TENANT, actor: 'uid-fred', pubsubClient },
      {
        id: ESC_ID,
        modifiedAction: {
          actionType: 'send_message',
          channel: 'email',
          payload: { instruction: 'Follow up.' },
        },
      },
    );

    expect((pubsubClient as { publish: ReturnType<typeof vi.fn> }).publish).toHaveBeenCalledTimes(1);
    const callTuple = (pubsubClient as { publish: ReturnType<typeof vi.fn> }).publish.mock.calls[0] as unknown as [string, Buffer];
    const event = JSON.parse(callTuple[1].toString());
    expect(event.action.payload.discoveryTarget).toBeUndefined();
  });

  it('NO-OP: Decision metadata absent (e.g. legacy decision) → no crash, no injection', async () => {
    const prisma = makePrisma(null); // metadata null entirely
    const pubsubClient = makePubsub();

    await acceptRecommendation(
      { prisma, tenantId: TENANT, actor: 'uid-fred', pubsubClient },
      {
        id: ESC_ID,
        modifiedAction: {
          actionType: 'send_message',
          channel: 'email',
          payload: { instruction: 'Follow up.' },
        },
      },
    );

    expect((pubsubClient as { publish: ReturnType<typeof vi.fn> }).publish).toHaveBeenCalledTimes(1);
    const callTuple = (pubsubClient as { publish: ReturnType<typeof vi.fn> }).publish.mock.calls[0] as unknown as [string, Buffer];
    const event = JSON.parse(callTuple[1].toString());
    expect(event.action.payload.discoveryTarget).toBeUndefined();
  });
});
