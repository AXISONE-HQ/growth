/**
 * M3-1b — composeMessage gapContext + CAN-SPAM footer preservation.
 *
 * Pins:
 *   - gapContext present → user prompt contains the "Discovery Target" block
 *     with compound-default phrasing ("weave naturally; do NOT lead")
 *   - compound=false → dedicated phrasing
 *   - gapContext present + partial state → partial signal note rendered
 *   - gapContext omitted → prompt identical to pre-M3-1b (no Discovery Target block)
 *   - CAN-SPAM unsubscribe footer (M2-6b) preserved bit-for-bit on the
 *     discovery path (footer is post-LLM post-parse; gapContext only
 *     affects the user prompt input)
 *
 * Strategy: mock llm-client.complete to capture the userPrompt argument,
 * assert against substring patterns.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Mock BEFORE composer import so the spy replaces the real client.
const completeMock = vi.fn(async (input: { userPrompt: string }) => {
  void input.userPrompt; // captured via mock.calls
  return {
    text: JSON.stringify({
      subject: 'Quick question, Sarah',
      body: 'Just following up. Looking forward to hearing your thoughts.',
    }),
    llmInputTokens: 100,
    llmOutputTokens: 50,
    modelTier: 'cheap',
  };
});
vi.mock('../llm-client.js', () => ({ complete: completeMock }));

const { composeMessage } = await import('../message-composer.js');

function makeStubPrisma(): PrismaClient {
  return {
    contact: {
      findFirst: async () => ({
        firstName: 'Sarah',
        lastName: 'Test',
        email: 'sarah@test.local',
      }),
    },
    brainSnapshot: { findFirst: async () => null },
  } as unknown as PrismaClient;
}

function lastUserPrompt(): string {
  const callArgs = completeMock.mock.calls.at(-1)![0] as { userPrompt: string };
  return callArgs.userPrompt;
}

describe('M3-1b composeMessage — gapContext renders Discovery Target block', () => {
  it('gapContext present + compound default → user prompt contains discovery block with weave-naturally instruction', async () => {
    completeMock.mockClear();
    await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      gapContext: {
        subObjectiveKey: 'timeline',
        label: 'When are they looking to start?',
        currentState: 'unknown',
      },
    });
    const prompt = lastUserPrompt();
    expect(prompt).toMatch(/Discovery Target/);
    expect(prompt).toMatch(/Topic: When are they looking to start\?/);
    expect(prompt).toMatch(/COMPOUND/);
    expect(prompt).toMatch(/weave this discovery naturally/);
    expect(prompt).toMatch(/Do NOT lead/);
  });

  it('compound=false → DEDICATED phrasing renders instead', async () => {
    completeMock.mockClear();
    await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      gapContext: {
        subObjectiveKey: 'budget',
        label: "What's their budget range?",
        currentState: 'unknown',
        compound: false,
      },
    });
    const prompt = lastUserPrompt();
    expect(prompt).toMatch(/DEDICATED/);
    expect(prompt).toMatch(/make this discovery the primary intent/);
    expect(prompt).not.toMatch(/COMPOUND/);
  });

  it('partial state with signal → renders partial-signal note ("don\'t restart")', async () => {
    completeMock.mockClear();
    await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      gapContext: {
        subObjectiveKey: 'need',
        label: 'What problem are they solving?',
        currentState: 'partial',
        valueIfPartial: 'growing team',
      },
    });
    const prompt = lastUserPrompt();
    expect(prompt).toMatch(/partial signal so far: "growing team"/);
    expect(prompt).toMatch(/confirm or refine, don't restart/);
  });

  it('gapContext omitted → user prompt has NO Discovery Target block (legacy behavior preserved)', async () => {
    completeMock.mockClear();
    await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
    });
    const prompt = lastUserPrompt();
    expect(prompt).not.toMatch(/Discovery Target/);
    expect(prompt).not.toMatch(/COMPOUND/);
    expect(prompt).not.toMatch(/DEDICATED/);
  });
});

describe('M3-1b composeMessage — CAN-SPAM unsubscribe footer (M2-6b) preserved on discovery path', () => {
  it('discovery composition still appends unsubscribe footer (post-LLM, untouched by gapContext)', async () => {
    completeMock.mockClear();
    const composed = await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      gapContext: {
        subObjectiveKey: 'timeline',
        label: 'When are they looking to start?',
        currentState: 'unknown',
      },
    });
    expect(composed.body.toLowerCase()).toContain('unsubscribe');
    expect(composed.body).toContain('https://growth.axisone.ca/unsubscribe/contact-a');
    expect(composed.unsubscribeUrl).toBe('https://growth.axisone.ca/unsubscribe/contact-a');
  });

  it('discovery composition body still passes the M1 guardrail CAN-SPAM body keyword check', async () => {
    completeMock.mockClear();
    const composed = await composeMessage(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      gapContext: {
        subObjectiveKey: 'timeline',
        label: 'When are they looking to start?',
        currentState: 'unknown',
      },
    });
    const { runGuardrailGate } = await import('../communication-agent.js');
    const gate = await runGuardrailGate({
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      channel: 'email',
      message: {
        subject: composed.subject,
        body: composed.body,
        to: 'sarah@test.local',
        from: 'hello@growth.axisone.ca',
      },
    });
    expect(gate.decision).not.toBe('block');
    const complianceBlocks = gate.result.violations.filter(
      (v) => v.checkType === 'compliance' && (v.severity === 'block' || v.severity === 'regenerate'),
    );
    expect(complianceBlocks).toHaveLength(0);
  });
});
