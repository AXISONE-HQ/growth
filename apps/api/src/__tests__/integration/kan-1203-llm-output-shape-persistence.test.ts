/**
 * KAN-1203 — LLM-output-shape ↔ Campaign-row persistence regression lock
 * (REAL Prisma).
 *
 * Closes the third KAN-1184 latent-bug testing-substrate gap. Pre-KAN-1203
 * unit tests injected canonical-shape values directly into ConversationState;
 * nothing exercised the FULL pipeline:
 *
 *   LLM emits value → orchestrator persistDimensionToCampaign → Campaign row
 *
 * Result in PROD: LLM emitted natural-language field names
 * ({numericTarget, outcomeType, description}) and the orchestrator's
 * strict permissive-on-fail conditional silently dropped everything because
 * it checked Campaign-schema field names ({goalTarget, goalType,
 * goalDescription}). Campaign row stayed NULL; generator returned
 * `insufficient_dimensions` with missing[product, objectives, ...]; operator
 * saw amber banner after clicking Generate Action Plan.
 *
 * This file exercises the normalizers + persistence end-to-end via
 * handleChatTurn(), against real Postgres. Each scenario asserts the
 * Campaign row's columns reflect the LLM-emitted value INCLUDING the
 * natural-language field-name variants the normalizer accepts.
 *
 * Substrate posture per banked memos:
 *   - `operator_experience_verification` — third operator session in 36 hours
 *     surfacing a latent KAN-1184 substrate bug; integration tests must
 *     traverse the full data-flow path, not just isolated function shapes.
 *   - `documented_doctrine_ne_implemented_doctrine` — KAN-1184 docstring
 *     described per-dimension extraction but the value shape was a vague
 *     placeholder. KAN-1203 makes the contract concrete via in-prompt
 *     examples + normalizer.
 *   - `tests_encoding_current_bug_anti_pattern` — pre-KAN-1203 tests
 *     asserted Campaign-schema field names made it through; the LLM never
 *     emitted those names. The tests served as regression-protection
 *     AGAINST realistic LLM output.
 *
 * Import posture (KAN-689 variable-specifier): orchestrator lives in
 * packages/api/src outside apps/api's rootDir. `await import(spec)`
 * sidesteps TS6059.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChatTurnResult,
  ConversationState,
} from '@growth/shared';
import { emptyConversationState } from '@growth/shared';
import { createTenant, withRollback } from './setup.js';

const orchestratorSpec =
  '../../../../../packages/api/src/services/conversational-orchestrator.js';

interface OrchestratorModule {
  handleChatTurn: (
    prisma: unknown,
    llm: unknown,
    audienceCount: unknown,
    params: {
      campaignId?: string;
      tenantId: string;
      message: string;
      state: ConversationState;
    },
    todayUtc?: Date,
  ) => Promise<ChatTurnResult>;
}

function llmQueue(responses: Array<Record<string, unknown>>) {
  let i = 0;
  return async () => {
    if (i >= responses.length) {
      throw new Error(
        `LLM queue exhausted at call ${i + 1}; scenario only scripted ${responses.length} responses`,
      );
    }
    const next = responses[i++];
    return {
      text: JSON.stringify(next),
      model: 'mock-llm',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 10,
    };
  };
}

/**
 * KAN-1230 B1 — these persistence scenarios all start with ≥2 dimensions
 * undetermined, so the orchestrator now routes them through the multi-dim
 * extraction path. `md()` wraps a single dimension's value in the multi-dim
 * response envelope the path expects. The persistence assertions are
 * unchanged — `persistDimensionToCampaign` is reused by both paths, so the
 * LLM-natural-shape normalization contract still holds.
 */
function md(
  dim: string,
  value: unknown,
  confidence = 0.9,
): Record<string, unknown> {
  return { [dim]: { extracted: true, value, confidence, reason: 'test' } };
}

const STUB_AUDIENCE_COUNT = async () => ({
  count: 0,
  isThin: false,
  historicalValueUsd: 0,
});

const TODAY = new Date('2026-06-16T00:00:00.000Z');

/**
 * KAN-1219 Slice G3 activation cost — entityType promoted to FIRST per Q1
 * lock. KAN-1203 scenarios target product/objectives/timeline/audience
 * persistence, so each fixture seeds entityType='product' as confirmed.
 * Activation-slice-fixture-update pattern (1st banked anchor).
 */
function productCampaignSeed(): ConversationState {
  return {
    ...emptyConversationState(),
    entityType: { kind: 'confirmed', value: 'product' },
  };
}

// ─────────────────────────────────────────────
// PRODUCT dimension — accepts string OR object with natural-language names
// ─────────────────────────────────────────────

describe('KAN-1203 product persistence — canonical string + LLM-natural object variants', () => {
  it('persists raw string value into goalProductId (canonical)', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([md('product', 'Growth Platform Pro')]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'Growth Platform Pro', state: productCampaignSeed() },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { goalProductId: true },
      });
      expect(row.goalProductId).toBe('Growth Platform Pro');
    });
  });

  it('persists object-shaped LLM-natural variant ({name: ...}) into goalProductId', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      // Pre-KAN-1203 this object would be silently dropped; normalizer extracts `name`.
      const llm = llmQueue([
        md('product', { name: 'Growth Platform Essential', description: "AxisOne's flagship tier" }),
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'Growth Platform Essential', state: productCampaignSeed() },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { goalProductId: true },
      });
      expect(row.goalProductId).toBe('Growth Platform Essential');
    });
  });
});

// ─────────────────────────────────────────────
// OBJECTIVES dimension — Fred's empirically-confirmed mismatch
// ─────────────────────────────────────────────

describe('KAN-1203 objectives persistence — canonical + Fred-confirmed LLM-natural variant', () => {
  it('persists canonical {goalType, goalTarget, goalDescription}', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        md('objectives', { goalType: 'units', goalTarget: 50, goalDescription: 'Sell 50 units' }),
      ]);
      // Reach objectives by injecting product already confirmed
      const stateWithProduct: ConversationState = {
        ...productCampaignSeed(),
        product: { kind: 'confirmed', value: 'Growth Platform' },
      };
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'sell 50 units', state: stateWithProduct },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { goalType: true, goalTarget: true, goalDescription: true },
      });
      expect(row.goalType).toBe('units');
      expect(row.goalTarget).toBe(50);
      expect(row.goalDescription).toBe('Sell 50 units');
    });
  });

  it("persists Fred's exact PROD shape {numericTarget, outcomeType, description}", async () => {
    // This is the exact shape Fred's session emitted; pre-KAN-1203 dropped
    // everything, leaving goalType/goalTarget/goalDescription NULL on the
    // Campaign row and triggering insufficient_dimensions at Generate time.
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        md('objectives', {
          numericTarget: 50,
          outcomeType: 'units',
          description: 'Sell 50 units of Growth Platform',
        }),
      ]);
      const stateWithProduct: ConversationState = {
        ...productCampaignSeed(),
        product: { kind: 'confirmed', value: 'Growth Platform' },
      };
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'sell 50 units', state: stateWithProduct },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { goalType: true, goalTarget: true, goalDescription: true },
      });
      expect(row.goalType).toBe('units');
      expect(row.goalTarget).toBe(50);
      expect(row.goalDescription).toBe('Sell 50 units of Growth Platform');
    });
  });

  it('normalizes non-enum goalType ("customers") to "custom" (legitimate catch-all)', async () => {
    // Operator says "50 new paying customers" → LLM may emit goalType=customers.
    // parseGoalShape requires one of revenue/units/deals/meetings/custom.
    // Normalizer maps "customers" → "custom" so the generator's
    // parseGoalShape doesn't return null (would block plan generation).
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        md('objectives', { outcomeType: 'customers', numericTarget: 50, description: '50 new paying customers' }),
      ]);
      const stateWithProduct: ConversationState = {
        ...productCampaignSeed(),
        product: { kind: 'confirmed', value: 'Growth Platform' },
      };
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: '50 new paying customers', state: stateWithProduct },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { goalType: true, goalTarget: true },
      });
      expect(row.goalType).toBe('custom');
      expect(row.goalTarget).toBe(50);
    });
  });
});

// ─────────────────────────────────────────────
// TIMELINE dimension — ISO + bad-date guards
// ─────────────────────────────────────────────

describe('KAN-1203 timeline persistence — ISO strings + bad-date guards', () => {
  it('persists canonical {windowStart, windowEnd} as ISO strings', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        md('timeline', {
          windowStart: '2026-07-01T00:00:00.000Z',
          windowEnd: '2026-07-31T23:59:59.999Z',
        }),
      ]);
      const stateWithObj: ConversationState = {
        ...productCampaignSeed(),
        product: { kind: 'confirmed', value: 'Growth Platform' },
        objectives: { kind: 'confirmed', value: { goalType: 'units', goalTarget: 50, goalDescription: 'x' } },
      };
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'July 2026', state: stateWithObj },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { windowStart: true, windowEnd: true },
      });
      expect(row.windowStart?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(row.windowEnd?.toISOString()).toBe('2026-07-31T23:59:59.999Z');
    });
  });

  it('drops invalid date strings (leaves windowStart/windowEnd NULL)', async () => {
    // Pre-KAN-1203 `new Date('not a date')` returned Invalid Date which
    // Postgres rejected as a write error. Normalizer now drops invalid
    // dates so the field stays NULL (clean) and the persist-drift log
    // surfaces the issue for operator-experience verification.
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        md('timeline', { windowStart: 'next month', windowEnd: 'sometime later' }),
      ]);
      const stateWithObj: ConversationState = {
        ...productCampaignSeed(),
        product: { kind: 'confirmed', value: 'Growth Platform' },
        objectives: { kind: 'confirmed', value: { goalType: 'units', goalTarget: 50, goalDescription: 'x' } },
      };
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'next month', state: stateWithObj },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { windowStart: true, windowEnd: true },
      });
      expect(row.windowStart).toBeNull();
      expect(row.windowEnd).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────
// FULL CHAIN — Fred's PROD reproduction (4 dims via LLM-natural shapes)
//
// This is the canonical end-to-end scenario the substrate failed before
// KAN-1203 — the exact shape sequence Fred's session emitted. Post-fix,
// the chain reaches all_dimensions_confirmed AND the Campaign row has all
// 4 dimensions correctly persisted (so generateActionPlan won't return
// insufficient_dimensions in PROD).
// ─────────────────────────────────────────────

describe('KAN-1203 full-chain reproduction — Fred-confirmed PROD shapes', () => {
  it('reaches all_dimensions_confirmed AND Campaign row has all 4 dims persisted', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      // KAN-1230 B1 — turns 1–3 run the multi-dim path (≥2 dims undetermined,
      // one dimension answered per turn). Turn 4 has only `audience` left → the
      // single-dim path handles the final dimension. This chain exercises BOTH
      // paths end-to-end with Fred's LLM-natural PROD shapes.
      const llm = llmQueue([
        // Turn 1 — product (LLM-natural object shape) via multi-dim
        md('product', { name: 'Growth Platform', description: "AxisOne's growth platform" }),
        // Turn 2 — objectives (Fred's exact PROD shape) via multi-dim
        md('objectives', { numericTarget: 50, outcomeType: 'customers', description: '50 new paying customers' }),
        // Turn 3 — timeline via multi-dim
        md('timeline', { windowStart: '2026-07-01T00:00:00.000Z', windowEnd: '2026-07-31T23:59:59.999Z' }),
        // Turn 4 — audience (last dim → single-dim path → single-dim shape)
        {
          kind: 'extracted',
          value: { field: 'lifecycleStage', op: 'in', values: ['customer'] },
          confidence: 'high',
          aiMessage: 'Got customers cohort.',
        },
      ]);

      // KAN-1219 G3 — chain test stays focused on the existing 4-dim
      // persistence; seed entityType='product' so the orchestrator targets
      // 'product' on the first turn rather than the new entityType dim.
      let state: ConversationState = productCampaignSeed();
      let campaignId: string | undefined;
      const messages = [
        'Growth Platform',
        '50 new paying customers',
        'July 2026',
        'all current customers',
      ];

      for (let t = 0; t < 4; t++) {
        const result = await handleChatTurn(
          prisma,
          llm,
          STUB_AUDIENCE_COUNT,
          { campaignId, tenantId: tenant.id, message: messages[t], state },
          TODAY,
        );
        if (t < 3) {
          // multi-dim path advances one dim per turn here
          expect(result.kind).toBe('dimensions_extracted');
        } else {
          // single-dim path on the final (audience) dimension closes the set
          expect(result.kind).toBe('all_dimensions_confirmed');
        }
        if ('state' in result) state = result.state;
        if ('campaignId' in result) campaignId = result.campaignId;
      }

      // The acceptance criterion KAN-1184 latent bug #3 was failing:
      // Campaign row populated correctly for ALL 4 dimensions despite the
      // LLM emitting natural-language field names throughout.
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId! },
        select: {
          goalProductId: true,
          goalType: true,
          goalTarget: true,
          goalDescription: true,
          windowStart: true,
          windowEnd: true,
          audienceConditions: true,
        },
      });
      expect(row.goalProductId).toBe('Growth Platform');
      expect(row.goalType).toBe('custom'); // 'customers' → 'custom' (KAN-1203 normalizer)
      expect(row.goalTarget).toBe(50);
      expect(row.goalDescription).toBe('50 new paying customers');
      expect(row.windowStart?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(row.windowEnd?.toISOString()).toBe('2026-07-31T23:59:59.999Z');
      expect(row.audienceConditions).toEqual({
        field: 'lifecycleStage',
        op: 'in',
        values: ['customer'],
      });
    });
  });
});
