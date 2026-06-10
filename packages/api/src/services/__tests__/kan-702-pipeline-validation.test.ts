/**
 * Tests for KAN-702 PR A pipeline validation helpers.
 *
 * The helpers live in apps/api/src/router.ts (inlined there to keep
 * net-zero TS6059 — pulling them from packages/api/src/services would add
 * the file to the apps/api static graph). This test file imports them via
 * the published apps/api router exports through the cross-workspace path,
 * which the connectors vitest bridge already resolves.
 *
 * Coverage matrix per AC:
 *   - validateStages: priority/order rules, isInitial constraint, name uniqueness, empty list
 *   - validatePipelineForm: name required + length + objective enum + delegates to validateStages
 *   - normalizeStageOrders: contiguous 0..N-1 sequence
 *   - canDeleteStage: lead-count safety + only-initial-stage protection
 *
 * KAN-1169 — canDeletePipeline removed; replaced by async checkPipelineDeletability
 * (Prisma-dependent; covered by procedure-level tests in
 * apps/api/src/__tests__/kan-1169-pipeline-delete.test.ts + the real-Postgres
 * integration suite).
 */
import { describe, it, expect } from 'vitest';
import {
  validateStages,
  validatePipelineForm,
  normalizeStageOrders,
  canDeleteStage,
  type StageInput,
} from '../../../../../apps/api/src/router.js';

function stage(name: string, order: number, opts: Partial<StageInput> = {}): StageInput {
  return {
    name,
    order,
    isInitial: opts.isInitial ?? false,
    isTerminal: opts.isTerminal ?? false,
    id: opts.id,
  };
}

// ─────────────────────────────────────────────
// validateStages
// ─────────────────────────────────────────────

describe('validateStages', () => {
  it('passes for a clean 4-stage pipeline (default wizard layout)', () => {
    const r = validateStages([
      stage('New', 0, { isInitial: true }),
      stage('Qualified', 1),
      stage('Quote Sent', 2),
      stage('Closed', 3, { isTerminal: true }),
    ]);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects empty stage list', () => {
    const r = validateStages([]);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/at least one stage/);
  });

  it('rejects duplicate stage names', () => {
    const r = validateStages([
      stage('New', 0, { isInitial: true }),
      stage('New', 1),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /"New".*more than once/.test(e))).toBe(true);
  });

  it('rejects empty / whitespace-only stage names', () => {
    const r = validateStages([
      stage('   ', 0, { isInitial: true }),
      stage('Real', 1),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /cannot be empty/.test(e))).toBe(true);
  });

  it('rejects duplicate order values', () => {
    const r = validateStages([
      stage('A', 0, { isInitial: true }),
      stage('B', 0),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /order 0.*more than once/.test(e))).toBe(true);
  });

  it('rejects pipeline with zero initial stages', () => {
    const r = validateStages([stage('A', 0), stage('B', 1)]);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /none marked/.test(e))).toBe(true);
  });

  it('rejects pipeline with multiple initial stages', () => {
    const r = validateStages([
      stage('A', 0, { isInitial: true }),
      stage('B', 1, { isInitial: true }),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /2 marked/.test(e))).toBe(true);
  });

  it('allows multiple terminal stages (closed-won + closed-lost)', () => {
    const r = validateStages([
      stage('Open', 0, { isInitial: true }),
      stage('Closed Won', 1, { isTerminal: true }),
      stage('Closed Lost', 2, { isTerminal: true }),
    ]);
    expect(r.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────
// validatePipelineForm
// ─────────────────────────────────────────────

describe('validatePipelineForm', () => {
  const goodStages = [
    stage('New', 0, { isInitial: true }),
    stage('Closed', 1, { isTerminal: true }),
  ];

  it('passes for a clean form', () => {
    const r = validatePipelineForm({
      name: 'Enterprise Sales',
      objectiveType: 'send_quote',
      stages: goodStages,
    });
    expect(r.valid).toBe(true);
  });

  it('requires a non-empty name', () => {
    const r = validatePipelineForm({ name: '   ', objectiveType: 'send_quote', stages: goodStages });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /name is required/i.test(e))).toBe(true);
  });

  it('rejects names longer than 100 chars', () => {
    const r = validatePipelineForm({
      name: 'x'.repeat(101),
      objectiveType: 'send_quote',
      stages: goodStages,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /100 characters/.test(e))).toBe(true);
  });

  it('rejects unknown objective types', () => {
    const r = validatePipelineForm({
      name: 'X',
      objectiveType: 'totally_unknown',
      stages: goodStages,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /Unknown objective type/.test(e))).toBe(true);
  });

  it('aggregates stage-level errors alongside pipeline-level errors', () => {
    const r = validatePipelineForm({
      name: '',
      objectiveType: 'send_quote',
      stages: [stage('A', 0), stage('B', 1)], // no initial
    });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────
// normalizeStageOrders
// ─────────────────────────────────────────────

describe('normalizeStageOrders', () => {
  it('renumbers to contiguous 0..N-1 in the input order', () => {
    const out = normalizeStageOrders([
      stage('A', 100),
      stage('B', 50),
      stage('C', 200),
    ]);
    expect(out.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(out.map((s) => s.name)).toEqual(['A', 'B', 'C']);
  });

  it('does not mutate the input', () => {
    const input = [stage('A', 5), stage('B', 7)];
    const before = JSON.stringify(input);
    normalizeStageOrders(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ─────────────────────────────────────────────
// canDeletePipeline (REMOVED — KAN-1169)
// ─────────────────────────────────────────────
// The pure helper canDeletePipeline shipped in KAN-702 PR A was replaced by
// the async checkPipelineDeletability (Prisma-dependent) in KAN-1169. The
// pipelines.delete procedure now branches on:
//   - blockReason: 'last_pipeline' | 'default_assignment' | null
//   - dealCount: total deals (terminal_won/terminal_lost included)
//   - destinationCandidates: count of other active pipelines
//   - hasStageHistory: TRUE if DealStageHistory references source's stages
//     → procedure soft-archives (isActive=false) instead of hard delete
//       to honor the audit_log NEVER deleted precedent + DealStageHistory.toStageId
//       Restrict schema intent.
// Coverage: see apps/api/src/__tests__/kan-1169-pipeline-delete.test.ts
// (12 procedure scenarios) + the real-Postgres integration test.

// ─────────────────────────────────────────────
// canDeleteStage
// ─────────────────────────────────────────────

describe('canDeleteStage', () => {
  it('refuses when leads are still in the stage', () => {
    const r = canDeleteStage({ activeLeadCount: 3, isInitial: false, isOnlyInitial: false });
    expect(r.canDelete).toBe(false);
    expect(r.reason).toMatch(/3 lead\(s\) currently in this stage/);
  });

  it('refuses to delete the only initial stage', () => {
    const r = canDeleteStage({ activeLeadCount: 0, isInitial: true, isOnlyInitial: true });
    expect(r.canDelete).toBe(false);
    expect(r.reason).toMatch(/only initial stage/);
  });

  it('allows deletion of an initial stage when another initial exists', () => {
    const r = canDeleteStage({ activeLeadCount: 0, isInitial: true, isOnlyInitial: false });
    expect(r.canDelete).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('allows deletion of a non-initial stage with no leads', () => {
    const r = canDeleteStage({ activeLeadCount: 0, isInitial: false, isOnlyInitial: false });
    expect(r.canDelete).toBe(true);
  });
});
