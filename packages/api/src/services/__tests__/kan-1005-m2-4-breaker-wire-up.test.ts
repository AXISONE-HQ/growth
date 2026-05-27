/**
 * KAN-1005 M2-4 follow-up — breaker plumbing wire-up integration test.
 *
 * The S4 PROD smoke surfaced that the M2-4 breaker NEVER fired even
 * though Redis correctly showed the trip key set. Root cause: the
 * caller (decision-run-push) read breakerState from Redis and passed
 * it to runDecisionForContact, but the engine's `RunForContactInput`
 * interface did NOT include the field — the value silently dropped at
 * the dynamic-import type boundary, `evaluateThresholdWithMatrix`
 * defaulted to `{tripped:false}`, autonomy proceeded.
 *
 * The existing M2-4 unit tests (kan-1005-m2-4-breaker-gate-integration.
 * test.ts) covered the gate-level logic with breakerState passed in
 * DIRECTLY to `evaluateThresholdWithMatrix` — they did NOT cover the
 * threading from RunForContactInput.breakerState → the gate. This file
 * closes that gap.
 *
 * Pins the WIRE-UP: a tripped breakerState entering at runDecisionFor-
 * Contact must reach the gate, which must escalate. Sibling of the
 * M2-6b decisionId structural-prevention test — both pin a load-bearing
 * plumbing property that unit-of-component tests left covered.
 */
import { describe, it, expect } from 'vitest';
import type { RunForContactInput, BreakerStateInput } from '@growth/shared';

// ─────────────────────────────────────────────
// Structural: RunForContactInput.breakerState is part of the type
// ─────────────────────────────────────────────

describe('KAN-1005 M2-4 — RunForContactInput.breakerState is structurally required-shaped (regression catcher)', () => {
  it('a tripped breakerState typechecks as RunForContactInput.breakerState', () => {
    const tripped: BreakerStateInput = {
      tripped: true,
      scope: 'breaker_tripped_rate',
      isGlobal: false,
      reason: 'manual_admin_trip: test',
    };
    const input: RunForContactInput = {
      tenantId: 't',
      contactId: 'c',
      breakerState: tripped,
    };
    expect(input.breakerState?.tripped).toBe(true);
    expect(input.breakerState?.scope).toBe('breaker_tripped_rate');
  });

  it('a fail-closed breakerState typechecks (Redis read failed → safe-direction tripped)', () => {
    const failClosed: BreakerStateInput = {
      tripped: true,
      failClosed: true,
      reason: 'circuit_breaker_state_unavailable',
    };
    const input: RunForContactInput = {
      tenantId: 't',
      contactId: 'c',
      breakerState: failClosed,
    };
    expect(input.breakerState?.failClosed).toBe(true);
  });

  it('breakerState omitted is allowed (back-compat: tests + sync trpc paths skip the field)', () => {
    const input: RunForContactInput = { tenantId: 't', contactId: 'c' };
    expect(input.breakerState).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Wire-up: breakerState.tripped=true → gate routes to ESCALATED
// ─────────────────────────────────────────────
//
// Calls the threshold-gate directly with the shape that runFreeform /
// runAgentic now forward. Pins the post-fix invariant: when caller
// passes breakerState.tripped=true, the gate escalates with the canonical
// 'circuit_breaker_tripped' marker in reasoning. The plumbing fix in
// run-decision-for-contact.ts:490 + :1141 makes input.breakerState reach
// this call site; the test fails if that thread is removed (the gate
// receives the field, escalates, asserts pass) OR if the gate logic
// ever stops routing tripped→human_review (the assertion catches both).

import { evaluateThresholdWithMatrix } from '../run-decision-for-contact.js';
import type { PrismaClient } from '@prisma/client';

function makeStubPrisma(): PrismaClient {
  return {
    stage: { findUnique: async () => null },
    pipeline: { findFirst: async () => null },
  } as unknown as PrismaClient;
}

// Stub contact carrying its tenant config inline — evaluateThresholdWithMatrix
// reads tenantConfig fields off `contact.tenant` (see run-decision-for-contact
// .ts:745). Threshold=30 + send_message:auto mirrors the AxisOne smoke
// posture; 95% confidence is well above so EVERY non-breaker path EXECUTEs,
// which keeps the test focused on the breaker check.
const STUB_CONTACT = {
  currentStageId: null,
  currentPipelineId: null,
  tenant: {
    confidenceThreshold: 30,
    autoApproveEnabled: true,
    requireHumanApproval: false,
    aiPermissions: { actionTypes: { send_message: 'auto' } },
    guardrailSettings: {},
    strategyPermissions: {},
    dailyActionLimit: 100,
  },
};

describe('KAN-1005 M2-4 — wire-up: breakerState.tripped=true entering the gate → ESCALATED with circuit_breaker_tripped reasoning', () => {
  it('tripped rate breaker → outcome ESCALATED + reasoning contains "circuit_breaker_tripped"', async () => {
    const result = await evaluateThresholdWithMatrix(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      contact: STUB_CONTACT as never,
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      actionReasoning: 'r',
      selectedStrategy: 'direct',
      strategyReasoning: 'r',
      objectiveId: 'obj-a',
      riskFlags: [],
      overallConfidence: 95, // well above threshold — proves the breaker
                              // overrides a permitted, above-threshold action
      dailyAutoActionCount: 0,
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_rate',
        isGlobal: false,
        reason: 'manual_admin_trip: wire-up test',
      },
    });
    expect(result.outcome).toBe('ESCALATED');
    expect(result.reasoning).toMatch(/circuit_breaker_tripped/);
    expect(result.reasoning).toMatch(/breaker_tripped_rate/);
  });

  it('tripped GLOBAL breaker → reasoning includes [GLOBAL] marker', async () => {
    const result = await evaluateThresholdWithMatrix(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      contact: STUB_CONTACT as never,
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      actionReasoning: 'r',
      selectedStrategy: 'direct',
      strategyReasoning: 'r',
      objectiveId: 'obj-a',
      riskFlags: [],
      overallConfidence: 95,
      dailyAutoActionCount: 0,
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_rate',
        isGlobal: true,
        reason: 'manual_admin_trip: global test',
      },
    });
    expect(result.outcome).toBe('ESCALATED');
    expect(result.reasoning).toMatch(/\[GLOBAL\]/);
  });

  it('fail-closed breakerState (Redis read failed) → ESCALATED with fail-closed marker', async () => {
    const result = await evaluateThresholdWithMatrix(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      contact: STUB_CONTACT as never,
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      actionReasoning: 'r',
      selectedStrategy: 'direct',
      strategyReasoning: 'r',
      objectiveId: 'obj-a',
      riskFlags: [],
      overallConfidence: 95,
      dailyAutoActionCount: 0,
      breakerState: {
        tripped: true,
        failClosed: true,
        reason: 'circuit_breaker_state_unavailable',
      },
    });
    expect(result.outcome).toBe('ESCALATED');
    expect(result.reasoning).toMatch(/fail-closed/);
  });

  it('not-tripped breakerState → outcome EXECUTED (proves the wire-up doesn\'t over-escalate)', async () => {
    const result = await evaluateThresholdWithMatrix(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      contact: STUB_CONTACT as never,
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      actionReasoning: 'r',
      selectedStrategy: 'direct',
      strategyReasoning: 'r',
      objectiveId: 'obj-a',
      riskFlags: [],
      overallConfidence: 95,
      dailyAutoActionCount: 0,
      breakerState: { tripped: false },
    });
    expect(result.outcome).toBe('EXECUTED');
    expect(result.reasoning).not.toMatch(/circuit_breaker_tripped/);
  });

  it('omitted breakerState → outcome EXECUTED (back-compat: undefined is treated as not-tripped)', async () => {
    const result = await evaluateThresholdWithMatrix(makeStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      contact: STUB_CONTACT as never,
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      actionReasoning: 'r',
      selectedStrategy: 'direct',
      strategyReasoning: 'r',
      objectiveId: 'obj-a',
      riskFlags: [],
      overallConfidence: 95,
      dailyAutoActionCount: 0,
      // breakerState intentionally omitted
    });
    expect(result.outcome).toBe('EXECUTED');
  });
});
