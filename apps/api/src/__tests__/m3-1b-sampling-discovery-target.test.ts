/**
 * M3-1b — M2-5 sampling carries discoveryTarget through to the
 * AUTO_APPROVE_SAMPLE Escalation row's context.
 *
 * Pins the PRD §6 sampling carry-through contract: when an auto-
 * approved discovery dispatch gets sampled, the operator reviewing
 * the sample queue must see the engine's discovery judgment alongside
 * its routine action, not just the routine markers.
 *
 * Strategy: call maybeEnqueueSampledReview with a sample-eligible
 * decisionSource + a discoveryTarget arg; verify the escalation.create
 * call payload's context jsonb includes the discoveryTarget object.
 * Also pin the omission path: non-discovery sample omits the field
 * cleanly (UI renders only when present).
 */
import { describe, it, expect, vi } from 'vitest';

describe('M3-1b — sampling carries discoveryTarget into escalation context', () => {
  it('discovery dispatch sampled → escalation.context.discoveryTarget populated', async () => {
    const createMock = vi.fn(async () => ({ id: 'escalation-1' }));
    const prisma = {
      escalation: { create: createMock },
    } as unknown as Parameters<typeof import('../lib/human-review-sampling.js').maybeEnqueueSampledReview>[0];

    // Force shouldSample to fire by setting rate=1.0; sample-eligible
    // decisionSource ('freeform') passes the early gate.
    const { maybeEnqueueSampledReview } = await import('../lib/human-review-sampling.js');
    const result = await maybeEnqueueSampledReview(prisma, {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      actionType: 'send_message',
      channel: 'email',
      confidence: 0.8,
      decisionSource: 'freeform',
      reasoning: 'Discovery target: ask about timeline.',
      sampleRate: 1.0,
      discoveryTarget: {
        subObjectiveKey: 'timeline',
        label: 'When are they looking to start?',
        triggerType: 'soft',
      },
    });

    expect(result.sampled).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    const callTuple = createMock.mock.calls[0] as unknown as [{ data: { context: Record<string, unknown> } }];
    const callArg = callTuple[0];
    const ctx = callArg.data.context as Record<string, unknown>;
    expect(ctx.discoveryTarget).toEqual({
      subObjectiveKey: 'timeline',
      label: 'When are they looking to start?',
      triggerType: 'soft',
    });
    // Confirm other M2-5 markers still present (carry-through is additive, not replacement).
    expect(ctx.sampled).toBe(true);
    expect(ctx.decisionSource).toBe('freeform');
    expect(ctx.reasoning).toMatch(/Discovery target/);
  });

  it('non-discovery dispatch sampled → escalation.context omits discoveryTarget cleanly (UI renders only when present)', async () => {
    const createMock = vi.fn(async () => ({ id: 'escalation-2' }));
    const prisma = {
      escalation: { create: createMock },
    } as unknown as Parameters<typeof import('../lib/human-review-sampling.js').maybeEnqueueSampledReview>[0];

    const { maybeEnqueueSampledReview } = await import('../lib/human-review-sampling.js');
    await maybeEnqueueSampledReview(prisma, {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      actionType: 'send_message',
      channel: 'email',
      confidence: 0.8,
      decisionSource: 'freeform',
      reasoning: 'standard routine action',
      sampleRate: 1.0,
      // discoveryTarget intentionally omitted
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callTuple = createMock.mock.calls[0] as unknown as [{ data: { context: Record<string, unknown> } }];
    const callArg = callTuple[0];
    const ctx = callArg.data.context as Record<string, unknown>;
    expect('discoveryTarget' in ctx).toBe(false);
    expect(ctx.sampled).toBe(true);
  });
});
