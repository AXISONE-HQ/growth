/**
 * KAN-1005 M2-6b — dispatch-path fix-PR tests.
 *
 * The autonomy flip surfaced two latent bugs in the M2 dispatch chain:
 *   Bug 1: composer body never carried the 'unsubscribe' keyword → M1
 *          guardrail CAN-SPAM check (guardrail-layer.ts:317-333) blocked
 *          every autonomous email.
 *   Bug 2: action-decided event builders generated synthetic
 *          `dec_<uuid>` IDs → downstream Escalation writes (guardrail-
 *          block + M2-5 sample fork) FK-violated against decisions.id.
 *
 * Proves four properties so a regression makes the file fail:
 *   1. composeMessage body contains the literal 'unsubscribe' keyword
 *      + the canonical `/unsubscribe/<contactId>` URL.
 *   2. The composed body passes runGuardrailGate's compliance check
 *      (decision !== 'block'). This is the unblock that lets M2 fire.
 *   3. buildActionDecidedEvent uses input.decisionId VERBATIM (no
 *      synthetic prefix, no fallback generator). Required field —
 *      omitting it is a compile error (covered by ts-expect-error
 *      type-level test in the same file).
 *   4. buildEscalationTriggeredEvent + buildDecisionLoggedEvent use
 *      input.decisionId verbatim too (sibling guards on the two other
 *      event builders that wrote synthetic IDs pre-M2-6b).
 *
 * Note on infra: real-DB FK-resolves verification requires Prisma + a
 * test DB which packages/api lacks (KAN-692). The compile-time
 * required-decisionId enforcement (TS error on omission) plus the
 * verbatim-pass-through assertions below cover the regression-prevent
 * contract; the post-deploy smoke (S1 retry) is the live FK proof.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { composeMessage } from '../message-composer.js';
import {
  buildActionDecidedEvent,
  buildEscalationTriggeredEvent,
  buildDecisionLoggedEvent,
  type PublishActionInput,
  type PublishEscalationInput,
  type PublishDecisionLogInput,
} from '../action-decided-publisher.js';
import { runGuardrailGate } from '../communication-agent.js';

// ─────────────────────────────────────────────
// Bug 1 — composer body unsubscribe append
// ─────────────────────────────────────────────

vi.mock('../llm-client.js', () => ({
  complete: vi.fn(async () => ({
    text: JSON.stringify({
      subject: 'Hi Sarah, quick question',
      // Body deliberately OMITS the word 'unsubscribe' — mirrors what
      // Haiku produced in the live S1 smoke that the autonomy flip
      // ran. Post-fix, the composer appends the footer regardless.
      body: 'Just following up on our previous conversation. Looking forward to hearing your thoughts soon.',
    }),
    llmInputTokens: 100,
    llmOutputTokens: 50,
    modelTier: 'cheap',
  })),
}));

function makeStubPrisma(): PrismaClient {
  return {
    contact: {
      findFirst: vi.fn(async () => ({
        firstName: 'Sarah',
        lastName: 'Test',
        email: 'sarah@test.local',
      })),
    },
    brainSnapshot: {
      findFirst: vi.fn(async () => null),
    },
  } as unknown as PrismaClient;
}

describe('KAN-1005 M2-6b — composer body unsubscribe footer (Bug 1)', () => {
  it('appended footer makes the body contain literal "unsubscribe" keyword', async () => {
    const composed = await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'decision-a',
      instruction: 'follow up on prior outreach',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
    });
    expect(composed.body.toLowerCase()).toContain('unsubscribe');
  });

  it('appended footer renders the canonical /unsubscribe/<contactId> URL', async () => {
    const composed = await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'decision-a',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
    });
    expect(composed.body).toContain('https://growth.axisone.ca/unsubscribe/contact-a');
    expect(composed.unsubscribeUrl).toBe('https://growth.axisone.ca/unsubscribe/contact-a');
  });

  it('appended footer makes guardrail CAN-SPAM compliance check pass (decision !== block)', async () => {
    const composed = await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'decision-a',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
    });
    const gate = await runGuardrailGate({
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'decision-a',
      channel: 'email',
      message: {
        subject: composed.subject,
        body: composed.body,
        to: 'sarah@test.local',
        from: 'hello@growth.axisone.ca',
      },
    });
    // Pre-M2-6b: this gate's decision was 'block' because the body
    // lacked the unsubscribe keyword. Post-M2-6b: footer carries the
    // keyword → CAN-SPAM compliance violation never fires.
    expect(gate.decision).not.toBe('block');
    const complianceBlocks = gate.result.violations.filter(
      (v) => v.checkType === 'compliance' && (v.severity === 'block' || v.severity === 'regenerate'),
    );
    expect(complianceBlocks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Bug 2 — event builders use input.decisionId VERBATIM
// ─────────────────────────────────────────────

describe('KAN-1005 M2-6b — buildActionDecidedEvent uses input.decisionId verbatim (Bug 2)', () => {
  const REAL_DECISION_ID = '6f9c9a30-1b1a-4ec1-8f5e-9e2b7c4d1a01';

  function makeActionInput(overrides: Partial<PublishActionInput> = {}): PublishActionInput {
    return {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      objectiveId: 'obj-a',
      decisionId: REAL_DECISION_ID,
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      selectedStrategy: 'direct',
      confidenceScore: 80,
      strategyReasoning: 'r',
      actionReasoning: 'r',
      ...overrides,
    };
  }

  it('event.decisionId equals input.decisionId byte-for-byte (no synthetic dec_ prefix)', () => {
    const event = buildActionDecidedEvent(makeActionInput());
    expect(event.decisionId).toBe(REAL_DECISION_ID);
    expect(event.decisionId.startsWith('dec_')).toBe(false);
  });

  it('two builds with the SAME input.decisionId emit the SAME event.decisionId (deterministic, not generated)', () => {
    const a = buildActionDecidedEvent(makeActionInput());
    const b = buildActionDecidedEvent(makeActionInput());
    expect(a.decisionId).toBe(b.decisionId);
    // Sanity: eventIds are still per-emit unique (only decisionId is
    // pinned-by-caller; the rest of the event-identity surface is fresh).
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe('KAN-1005 M2-6b — buildEscalationTriggeredEvent uses input.decisionId verbatim (Bug 2 sibling)', () => {
  const REAL_DECISION_ID = '6f9c9a30-1b1a-4ec1-8f5e-9e2b7c4d1a02';

  function makeEscalationInput(): PublishEscalationInput {
    return {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      objectiveId: 'obj-a',
      decisionId: REAL_DECISION_ID,
      reason: 'guardrail_block: test',
      riskFlags: [],
      proposedAction: { actionType: 'send_message', channel: 'email', payload: {} },
      strategy: 'direct',
      confidenceScore: 80,
      reasoning: 'r',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  it('event.decisionId equals input.decisionId byte-for-byte', () => {
    const event = buildEscalationTriggeredEvent(makeEscalationInput());
    expect(event.decisionId).toBe(REAL_DECISION_ID);
    expect(event.decisionId.startsWith('dec_')).toBe(false);
  });
});

describe('KAN-1005 M2-6b — buildDecisionLoggedEvent uses input.decisionId verbatim (Bug 2 sibling)', () => {
  const REAL_DECISION_ID = '6f9c9a30-1b1a-4ec1-8f5e-9e2b7c4d1a03';

  function makeDecisionLogInput(): PublishDecisionLogInput {
    return {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      objectiveId: 'obj-a',
      decisionId: REAL_DECISION_ID,
      gateDecision: 'approved',
      selectedStrategy: 'direct',
      actionType: 'send_message',
      channel: 'email',
      confidenceScore: 80,
      riskFlags: [],
      reasoning: 'r',
      processingTimeMs: 12,
    };
  }

  it('event.decisionId equals input.decisionId byte-for-byte', () => {
    const event = buildDecisionLoggedEvent(makeDecisionLogInput());
    expect(event.decisionId).toBe(REAL_DECISION_ID);
    expect(event.decisionId.startsWith('dec_')).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Compile-time guarantee — required decisionId
// ─────────────────────────────────────────────
//
// The TS strictness check below is the structural prevention: if a
// future refactor makes decisionId optional again or adds an internal
// fallback, the @ts-expect-error here will START succeeding (no error
// to expect) and tsc will fail. So the regression discipline rides
// on tsc, not vitest — but documented here next to the runtime
// assertions for one-stop reading.

describe('KAN-1005 M2-6b — PublishActionInput.decisionId is REQUIRED at compile time', () => {
  it('omitting decisionId is a TS error (regression catcher)', () => {
    // @ts-expect-error — PublishActionInput.decisionId is required;
    //                    omission MUST fail tsc to prove the field
    //                    has not silently regressed to optional.
    const _bad: PublishActionInput = {
      tenantId: 't',
      contactId: 'c',
      objectiveId: 'o',
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      selectedStrategy: 'direct',
      confidenceScore: 80,
      strategyReasoning: 'r',
      actionReasoning: 'r',
    };
    expect(_bad).toBeDefined(); // runtime assertion is incidental;
                                 // the load-bearing check is tsc.
  });
});
