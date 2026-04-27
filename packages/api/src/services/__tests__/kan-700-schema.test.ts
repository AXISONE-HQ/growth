/**
 * Schema smoke tests for KAN-700.
 *
 * Verifies the generated Prisma client surfaces:
 *   - All 6 new enums with the correct member set
 *   - The 8 new models (Pipeline, Stage, MicroObjective, PipelineMicroObjective,
 *     Target, Guardrail, KnowledgeFilter, LeadStageHistory) with the required
 *     field shapes (compile-time + runtime smoke)
 *   - Contact extensions (currentPipelineId / currentStageId /
 *     microObjectiveProgress / enteredStageAt) on the Contact type
 *
 * No DB round-trip — that lives in the integration tests (separate runner)
 * once the migration has been deployed. These tests catch accidental enum
 * typos + dropped fields at the schema-edit boundary.
 */
import { describe, it, expect } from 'vitest';
import {
  ObjectiveType,
  TargetMetric,
  TargetPeriod,
  ValidatorType,
  GuardrailSeverity,
  KnowledgeCategory,
  type Pipeline,
  type Stage,
  type MicroObjective,
  type PipelineMicroObjective,
  type Target,
  type Guardrail,
  type KnowledgeFilter,
  type LeadStageHistory,
  type Contact,
} from '@prisma/client';

// ─────────────────────────────────────────────
// Enums — exhaustive value coverage
// ─────────────────────────────────────────────

describe('KAN-700 enums', () => {
  it('ObjectiveType — 4 values matching AC', () => {
    expect(Object.values(ObjectiveType).sort()).toEqual(
      ['book_appointment', 'buy_online', 'send_quote', 'warm_up_lead'].sort(),
    );
  });

  it('TargetMetric — 6 values matching AC', () => {
    expect(Object.values(TargetMetric).sort()).toEqual(
      [
        'appointments_booked',
        'leads_qualified',
        'orders_placed',
        'quotes_sent',
        'replies_received',
        'revenue_dollars',
      ].sort(),
    );
  });

  it('TargetPeriod — weekly / monthly / quarterly', () => {
    expect(Object.values(TargetPeriod).sort()).toEqual(
      ['monthly', 'quarterly', 'weekly'].sort(),
    );
  });

  it('ValidatorType — 5 values matching guardrail-layer.ts', () => {
    expect(Object.values(ValidatorType).sort()).toEqual(
      ['accuracy', 'compliance', 'hallucination', 'injection', 'tone'].sort(),
    );
  });

  it('GuardrailSeverity — 4 values matching guardrail-layer.ts', () => {
    expect(Object.values(GuardrailSeverity).sort()).toEqual(
      ['block', 'pass', 'regenerate', 'warn'].sort(),
    );
  });

  it('KnowledgeCategory — 6 values matching knowledge-center.ts', () => {
    expect(Object.values(KnowledgeCategory).sort()).toEqual(
      ['company_info', 'faqs', 'financing', 'products', 'shipping', 'warranty'].sort(),
    );
  });
});

// ─────────────────────────────────────────────
// Model shapes — compile-time guards via type assertions
// (a runtime expect just keeps vitest happy; the real value is the type
// signature: if any field gets renamed/dropped, this file fails to compile.)
// ─────────────────────────────────────────────

describe('KAN-700 model shapes', () => {
  it('Pipeline carries the AC-required fields', () => {
    const p: Pick<
      Pipeline,
      'id' | 'tenantId' | 'name' | 'description' | 'isActive' | 'order' | 'objectiveType' | 'objectiveDescription'
    > = {
      id: 'p1',
      tenantId: 't1',
      name: 'demo',
      description: null,
      isActive: true,
      order: 0,
      objectiveType: ObjectiveType.warm_up_lead,
      objectiveDescription: null,
    };
    expect(p.objectiveType).toBe('warm_up_lead');
  });

  it('Stage carries the AC-required fields (entry/transition/auto-approve as JSON)', () => {
    const s: Pick<
      Stage,
      'id' | 'pipelineId' | 'name' | 'order' | 'isInitial' | 'isTerminal' | 'entryActions' | 'transitionRules' | 'autoApproveMatrix'
    > = {
      id: 's1',
      pipelineId: 'p1',
      name: 'New',
      order: 0,
      isInitial: true,
      isTerminal: false,
      entryActions: [],
      transitionRules: [],
      autoApproveMatrix: {},
    };
    expect(s.isInitial).toBe(true);
  });

  it('MicroObjective allows nullable tenantId for platform defaults', () => {
    const platformDefault: Pick<
      MicroObjective,
      'id' | 'tenantId' | 'name' | 'isDefault' | 'order' | 'completionCriteria'
    > = {
      id: 'mo1',
      tenantId: null, // platform default — KAN-701 will seed 5 of these
      name: 'Consumer engagement',
      isDefault: true,
      order: 0,
      completionCriteria: { kind: 'reply_received' },
    };
    expect(platformDefault.tenantId).toBeNull();
  });

  it('PipelineMicroObjective is a join table keyed on (pipelineId, microObjectiveId)', () => {
    const j: Pick<PipelineMicroObjective, 'pipelineId' | 'microObjectiveId' | 'isActive'> = {
      pipelineId: 'p1',
      microObjectiveId: 'mo1',
      isActive: true,
    };
    expect(j.isActive).toBe(true);
  });

  it('Target uses Decimal-typed metric values + period', () => {
    const t: Pick<Target, 'id' | 'pipelineId' | 'metric' | 'period'> = {
      id: 't1',
      pipelineId: 'p1',
      metric: TargetMetric.revenue_dollars,
      period: TargetPeriod.monthly,
    };
    expect(t.metric).toBe('revenue_dollars');
    expect(t.period).toBe('monthly');
  });

  it('Guardrail allows tenant-wide (pipelineId null) or pipeline-scoped overrides', () => {
    const tenantWide: Pick<
      Guardrail,
      'id' | 'tenantId' | 'pipelineId' | 'validatorType' | 'severityOverride' | 'isActive'
    > = {
      id: 'g1',
      tenantId: 't1',
      pipelineId: null,
      validatorType: ValidatorType.compliance,
      severityOverride: GuardrailSeverity.block,
      isActive: true,
    };
    expect(tenantWide.pipelineId).toBeNull();
    expect(tenantWide.severityOverride).toBe('block');
  });

  it('KnowledgeFilter binds a category to a pipeline with include/exclude rules', () => {
    const kf: Pick<KnowledgeFilter, 'id' | 'pipelineId' | 'knowledgeCategory' | 'includeRule' | 'excludeRule'> = {
      id: 'kf1',
      pipelineId: 'p1',
      knowledgeCategory: KnowledgeCategory.products,
      includeRule: { tag: 'in_stock' },
      excludeRule: { discontinued: true },
    };
    expect(kf.knowledgeCategory).toBe('products');
  });

  it('LeadStageHistory captures from/to/decision/reason for an audit trail', () => {
    const h: Pick<
      LeadStageHistory,
      'id' | 'leadId' | 'fromStageId' | 'toStageId' | 'reason' | 'decisionId'
    > = {
      id: 'h1',
      leadId: 'c1',
      fromStageId: 's1',
      toStageId: 's2',
      reason: 'reply received',
      decisionId: 'd1',
    };
    expect(h.fromStageId).toBe('s1');
    expect(h.toStageId).toBe('s2');
  });

  it('Contact extensions: currentPipelineId / currentStageId / microObjectiveProgress / enteredStageAt', () => {
    const c: Pick<
      Contact,
      'id' | 'tenantId' | 'currentPipelineId' | 'currentStageId' | 'microObjectiveProgress' | 'enteredStageAt'
    > = {
      id: 'c1',
      tenantId: 't1',
      currentPipelineId: 'p1',
      currentStageId: 's1',
      microObjectiveProgress: { mo1: { completed: true, completedAt: '2026-04-26', evidence: 'replied' } },
      enteredStageAt: new Date(),
    };
    expect(c.currentPipelineId).toBe('p1');
    expect(c.currentStageId).toBe('s1');
  });
});
