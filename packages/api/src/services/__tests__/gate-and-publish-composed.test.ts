/**
 * Tests for KAN-697 active-wedge-path guardrail wiring (gateAndPublishComposed).
 *
 * Sister test file to communication-agent.test.ts. The gate logic itself
 * (decideGuardrailAction) is exhaustively tested there. Here we verify the
 * action-decided-push wiring contract:
 *   - block path: writes Escalation row, publishes escalation.triggered,
 *     does NOT call publishActionSend, returns sent=false
 *   - allow/warn path: does NOT write Escalation, calls publishActionSend,
 *     returns sent=true with messageId
 *   - validateMessage receives the composed message + ctx as input
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { gateAndPublishComposed, type ComposedMessage } from '../message-composer.js';
import type { GuardrailResult, Violation } from '../guardrail-layer.js';

const TENANT_ID = 'tenant-test-uuid';
const CONTACT_ID = 'contact-test-uuid';
const DECISION_ID = 'decision-test';
const OBJECTIVE_ID = 'obj-test';
const CONNECTION_ID = 'conn-test';

function violation(checkType: Violation['checkType'], severity: Violation['severity'], description = 'x'): Violation {
  return { checkType, severity, description };
}

function makeResult(violations: Violation[], overall: GuardrailResult['overallSeverity']): GuardrailResult {
  return {
    tenantId: TENANT_ID,
    contactId: CONTACT_ID,
    decisionId: DECISION_ID,
    checkId: 'chk_test',
    passed: overall === 'pass' || overall === 'warn',
    overallSeverity: overall,
    violations,
    checkedAt: new Date().toISOString(),
    checksRun: ['tone', 'accuracy', 'hallucination', 'compliance', 'injection'],
    durationMs: 0,
  };
}

const composed: ComposedMessage = {
  subject: 'Test subject from KAN-697',
  body: 'This is a substantive message body for the guardrail gate test.',
  unsubscribeUrl: 'https://growth.axisone.ca/unsubscribe?token=test',
};

const ctx = {
  tenantId: TENANT_ID,
  contactId: CONTACT_ID,
  decisionId: DECISION_ID,
  objectiveId: OBJECTIVE_ID,
  toEmail: 'recipient@example.com',
  fromEmail: 'hello@growth.axisone.ca',
  connectionId: CONNECTION_ID,
  strategy: 'direct',
  confidenceScore: 85,
};

function makeStubPrisma() {
  return {
    escalation: {
      create: vi.fn(async () => ({ id: 'escalation-test-id' })),
    },
  } as unknown as PrismaClient;
}

function makeStubPubSubClient() {
  return {
    publish: vi.fn(async () => 'pubsub-message-id'),
  } as unknown as Parameters<typeof gateAndPublishComposed>[1];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('gateAndPublishComposed (KAN-697 active wedge path)', () => {
  it('allow decision → publishes action.send, no escalation, returns sent=true', async () => {
    const prisma = makeStubPrisma();
    const pubsub = makeStubPubSubClient();
    const validator = vi.fn(() => makeResult([], 'pass'));

    const out = await gateAndPublishComposed(prisma, pubsub, ctx, composed, {
      extraHooks: { validate: validator },
    });

    expect(out.sent).toBe(true);
    expect(out.decision).toBe('allow');
    expect(out.messageId).toBe('pubsub-message-id');
    expect(out.blockedReason).toBeUndefined();
    // pubsub.publish called once for action.send (no escalation)
    expect((pubsub.publish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('action.send');
    // No Escalation row written on allow path
    expect((prisma.escalation as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('warn decision → publishes action.send, no escalation (default warnAction=allow)', async () => {
    const prisma = makeStubPrisma();
    const pubsub = makeStubPubSubClient();
    const validator = vi.fn(() => makeResult([violation('tone', 'warn', 'all caps')], 'warn'));

    const out = await gateAndPublishComposed(prisma, pubsub, ctx, composed, {
      extraHooks: { validate: validator },
    });

    expect(out.sent).toBe(true);
    expect(out.decision).toBe('warn');
    expect((pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('action.send');
    expect((prisma.escalation as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('block decision → writes Escalation row, publishes escalation.triggered, does NOT call publishActionSend', async () => {
    const prisma = makeStubPrisma();
    const pubsub = makeStubPubSubClient();
    const validator = vi.fn(() =>
      makeResult([violation('injection', 'block', 'prompt injection detected')], 'block'),
    );

    const out = await gateAndPublishComposed(prisma, pubsub, ctx, composed, {
      extraHooks: { validate: validator },
    });

    expect(out.sent).toBe(false);
    expect(out.decision).toBe('block');
    expect(out.blockedReason).toMatch(/injection.*prompt injection/);
    expect(out.messageId).toBeUndefined();

    // Escalation row written with the right shape
    const createCalls = (prisma.escalation as { create: ReturnType<typeof vi.fn> }).create.mock.calls;
    expect(createCalls.length).toBe(1);
    expect(createCalls[0][0].data.tenantId).toBe(TENANT_ID);
    expect(createCalls[0][0].data.contactId).toBe(CONTACT_ID);
    expect(createCalls[0][0].data.severity).toBe('high');
    expect(createCalls[0][0].data.triggerType).toBe('guardrail_block');
    expect(createCalls[0][0].data.triggerReason).toMatch(/injection/);
    expect(createCalls[0][0].data.status).toBe('open');

    // Pub/Sub: escalation.triggered fired, action.send did NOT fire
    const publishCalls = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls;
    const topics = publishCalls.map((c) => c[0]);
    expect(topics).toContain('growth.escalation.triggered');
    expect(topics).not.toContain('action.send');
  });

  it('block decision → escalation.triggered payload includes correlation ids + risk flags', async () => {
    const prisma = makeStubPrisma();
    const pubsub = makeStubPubSubClient();
    const validator = vi.fn(() =>
      makeResult(
        [
          violation('tone', 'warn', 'caps'),
          violation('compliance', 'block', 'no opt-out language'),
        ],
        'block',
      ),
    );

    await gateAndPublishComposed(prisma, pubsub, ctx, composed, {
      extraHooks: { validate: validator },
    });

    const escalationCall = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'growth.escalation.triggered',
    );
    expect(escalationCall).toBeDefined();
    // The publish() helper receives (topic, dataBuffer, attrs); decode the data.
    const dataBuffer = escalationCall![1] as Buffer;
    const event = JSON.parse(dataBuffer.toString('utf8')) as {
      tenantId: string;
      contactId: string;
      objectiveId: string;
      escalation: {
        reason: string;
        riskFlags: string[];
        decisionContext: { reasoning: string; strategy: string; confidenceScore: number };
      };
    };
    expect(event.tenantId).toBe(TENANT_ID);
    expect(event.contactId).toBe(CONTACT_ID);
    expect(event.objectiveId).toBe(OBJECTIVE_ID);
    expect(event.escalation.reason).toMatch(/guardrail_block/);
    expect(event.escalation.riskFlags).toContain('compliance:block');
    expect(event.escalation.riskFlags).toContain('tone:warn');
    expect(event.escalation.decisionContext.reasoning).toMatch(/compliance.*no opt-out/);
    expect(event.escalation.decisionContext.strategy).toBe('direct');
    expect(event.escalation.decisionContext.confidenceScore).toBe(85);
  });

  it('validator receives the composed message subject + body + ctx', async () => {
    const prisma = makeStubPrisma();
    const pubsub = makeStubPubSubClient();
    const validator = vi.fn(() => makeResult([], 'pass'));

    await gateAndPublishComposed(prisma, pubsub, ctx, composed, {
      extraHooks: { validate: validator },
    });

    expect(validator).toHaveBeenCalledTimes(1);
    const passed = validator.mock.calls[0][0];
    expect(passed.tenantId).toBe(TENANT_ID);
    expect(passed.contactId).toBe(CONTACT_ID);
    expect(passed.decisionId).toBe(DECISION_ID);
    expect(passed.channel).toBe('email');
    expect(passed.message.subject).toBe(composed.subject);
    expect(passed.message.body).toBe(composed.body);
    expect(passed.message.to).toBe(ctx.toEmail);
    expect(passed.message.from).toBe(ctx.fromEmail);
  });

  it('Escalation write failure does not throw — escalation.triggered still fires', async () => {
    // Defensive: if Prisma write fails (DB blip), the Pub/Sub publish should
    // still attempt so the human-review path isn't fully silent.
    const prisma = {
      escalation: { create: vi.fn(async () => { throw new Error('db down'); }) },
    } as unknown as PrismaClient;
    const pubsub = makeStubPubSubClient();
    const validator = vi.fn(() =>
      makeResult([violation('injection', 'block', 'prompt injection')], 'block'),
    );

    const out = await gateAndPublishComposed(prisma, pubsub, ctx, composed, {
      extraHooks: { validate: validator },
    });

    expect(out.sent).toBe(false);
    expect(out.decision).toBe('block');
    // Pub/Sub still attempted
    const topics = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(topics).toContain('growth.escalation.triggered');
  });
});
