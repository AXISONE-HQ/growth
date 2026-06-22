/**
 * KAN-1204 — Audience LLM-shape ↔ AudienceConditionsSchema regression lock
 * (REAL Prisma).
 *
 * Closes the FOURTH KAN-1184 latent-bug testing-substrate gap. After
 * KAN-1200 (FK) + KAN-1201 (state machine) + KAN-1203 (objectives field
 * names), Fred's smoke past Generate Action Plan failed on the 3rd
 * validation gate in action-plan-generator.ts:518-530:
 * "Campaign audienceConditions failed schema validation."
 *
 * Fred's PROD audience emitted by the LLM:
 *   {
 *     "anyOf": [
 *       {"allOf": [{"field": "lifecycleStage", "op": "in", "values": ["lead"]}]},
 *       {"allOf": [
 *         {"field": "lifecycleStage", "op": "in", "values": ["customer","contact"]},
 *         {"field": "orders.placedAt", "op": "lte", "value": "2026-03-18T..."}
 *       ]}
 *     ]
 *   }
 *
 * Two divergences from canonical AudienceConditionsSchema:
 *   1. `values: ["customer","contact"]` — "contact" is NOT in
 *      LifecycleStageEnum [lead, mql, sql, customer, lost]
 *   2. `{op: "lte", value: ISO}` on a date field — canonical schema
 *      requires `{op: "between", fromUtc, toUtcExclusive}`
 *
 * AND the KAN-1203 prompt example for audience used a non-canonical shape
 * (`{op: "gte", value: ISO}` on orders.placedAt). The LLM faithfully
 * followed the wrong example — a recursive doctrine-drift surfacing.
 *
 * KAN-1204 fixes both: (a) prompt example corrected to canonical shapes;
 * (b) normalizer added at persist boundary that converts common LLM
 * divergences into canonical shapes + filters invalid enum values + drops
 * unmappable leaves with structured console.warn.
 *
 * Substrate posture per banked memos:
 *   - `operator_experience_verification` — 4th operator session surfacing
 *     a latent KAN-1184 substrate bug; integration tests must traverse the
 *     LLM → orchestrator → Campaign → generator full data-flow path.
 *   - `llm_natural_variant_acceptance_doctrine` — accept variation, normalize
 *     at boundary; date single-comparison ops are normalized to canonical
 *     between with sentinel bounds.
 *   - `operator_session_as_test_anchor_pattern` — Fred's exact PROD shape
 *     is the "full-chain reproduction" fixture in this file.
 *
 * Import posture (KAN-689 variable-specifier): orchestrator lives outside
 * apps/api rootDir; await import(spec) sidesteps TS6059.
 */
import { describe, expect, it } from 'vitest';
import { AudienceConditionsSchema } from '@growth/shared';
import type { ConversationState, ChatTurnResult } from '@growth/shared';
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
      throw new Error(`LLM queue exhausted at call ${i + 1}; scripted ${responses.length}`);
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

const STUB_AUDIENCE_COUNT = async () => ({
  count: 0,
  isThin: false,
  historicalValueUsd: 0,
});

const TODAY = new Date('2026-06-16T00:00:00.000Z');

/** State with entityType + product + objectives + timeline confirmed so
 *  the LLM's next extraction targets 'audience' (the dimension under test
 *  here). KAN-1219 G3 — entityType='product' seeded as confirmed per Q1
 *  lock activation; this is a product-campaign audience scenario.
 *  Activation-slice-fixture-update pattern (1st banked anchor). */
const STATE_AUDIENCE_NEXT: ConversationState = {
  ...emptyConversationState(),
  entityType: { kind: 'confirmed', value: 'product' },
  product: { kind: 'confirmed', value: 'Growth Platform' },
  objectives: { kind: 'confirmed', value: { goalType: 'custom', goalTarget: 50, goalDescription: 'x' } },
  timeline: { kind: 'confirmed', value: { windowStart: '2026-07-01T00:00:00.000Z', windowEnd: '2026-07-31T23:59:59.999Z' } },
};

// ─────────────────────────────────────────────
// Canonical-shape passthrough
// ─────────────────────────────────────────────

describe('KAN-1204 audience — canonical shapes pass through unchanged', () => {
  it('persists a canonical single-leaf audience', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        {
          kind: 'extracted',
          value: { field: 'lifecycleStage', op: 'in', values: ['lead', 'mql'] },
          confidence: 'high',
          aiMessage: 'Got lead + MQL.',
        },
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'leads and MQLs', state: STATE_AUDIENCE_NEXT },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { audienceConditions: true },
      });
      expect(() => AudienceConditionsSchema.parse(row.audienceConditions)).not.toThrow();
      expect(row.audienceConditions).toEqual({
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead', 'mql'],
      });
    });
  });

  it('persists a canonical allOf tree (multi-leaf)', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        {
          kind: 'extracted',
          value: {
            allOf: [
              { field: 'lifecycleStage', op: 'in', values: ['lead'] },
              { field: 'region', op: 'in', values: ['QC'] },
              {
                field: 'orders.placedAt',
                op: 'between',
                fromUtc: '2026-05-17T00:00:00.000Z',
                toUtcExclusive: '2026-06-16T00:00:00.000Z',
              },
            ],
          },
          confidence: 'high',
          aiMessage: 'Got leads from QC who bought last 30d.',
        },
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'leads from QC last 30d', state: STATE_AUDIENCE_NEXT },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { audienceConditions: true },
      });
      expect(() => AudienceConditionsSchema.parse(row.audienceConditions)).not.toThrow();
    });
  });
});

// ─────────────────────────────────────────────
// Defect 1 reproduction — date single-comparison normalized
// ─────────────────────────────────────────────

describe('KAN-1204 audience — date single-comparison normalized to canonical between', () => {
  it("converts {op:'lte', value:ISO} on orders.placedAt → canonical between", async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        {
          kind: 'extracted',
          // Fred's PROD shape — non-canonical lte on date leaf.
          value: {
            field: 'orders.placedAt',
            op: 'lte',
            value: '2026-03-18T00:00:00.000Z',
          },
          confidence: 'high',
          aiMessage: 'Got pre-March orders.',
        },
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'bought before March', state: STATE_AUDIENCE_NEXT },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { audienceConditions: true },
      });
      // Pre-KAN-1204 this would have failed AudienceConditionsSchema.parse
      // downstream at the generator. Post-fix: normalized to canonical between.
      expect(() => AudienceConditionsSchema.parse(row.audienceConditions)).not.toThrow();
      expect(row.audienceConditions).toMatchObject({
        field: 'orders.placedAt',
        op: 'between',
        toUtcExclusive: '2026-03-18T00:00:00.000Z',
      });
    });
  });

  it("converts {op:'gte', value:ISO} on createdAt → canonical between", async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        {
          kind: 'extracted',
          value: { field: 'createdAt', op: 'gte', value: '2026-01-01T00:00:00.000Z' },
          confidence: 'high',
          aiMessage: 'Got contacts created from Jan 2026.',
        },
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'contacts since Jan', state: STATE_AUDIENCE_NEXT },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { audienceConditions: true },
      });
      expect(() => AudienceConditionsSchema.parse(row.audienceConditions)).not.toThrow();
      expect(row.audienceConditions).toMatchObject({
        field: 'createdAt',
        op: 'between',
        fromUtc: '2026-01-01T00:00:00.000Z',
      });
    });
  });
});

// ─────────────────────────────────────────────
// Defect 2 reproduction — invalid enum values filtered
// ─────────────────────────────────────────────

describe('KAN-1204 audience — invalid enum values filtered', () => {
  it("filters invalid lifecycleStage values ('contact' → dropped, 'customer' kept)", async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        {
          kind: 'extracted',
          // Fred's PROD shape — "contact" not in canonical enum.
          value: { field: 'lifecycleStage', op: 'in', values: ['customer', 'contact'] },
          confidence: 'high',
          aiMessage: 'Got customers.',
        },
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'customers and contacts', state: STATE_AUDIENCE_NEXT },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { audienceConditions: true },
      });
      expect(() => AudienceConditionsSchema.parse(row.audienceConditions)).not.toThrow();
      expect(row.audienceConditions).toEqual({
        field: 'lifecycleStage',
        op: 'in',
        values: ['customer'],
      });
    });
  });

  it('drops entire leaf when all values are invalid; tree may collapse', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        {
          kind: 'extracted',
          value: {
            allOf: [
              { field: 'lifecycleStage', op: 'in', values: ['lead'] },
              // This leaf has only invalid values; should be dropped, leaving
              // the allOf with a single child which the normalizer unwraps.
              { field: 'lifecycleStage', op: 'in', values: ['contact', 'prospect'] },
            ],
          },
          confidence: 'high',
          aiMessage: 'Got leads.',
        },
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'leads + contacts', state: STATE_AUDIENCE_NEXT },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { audienceConditions: true },
      });
      expect(() => AudienceConditionsSchema.parse(row.audienceConditions)).not.toThrow();
      // The invalid-only leaf was dropped; the remaining single leaf was
      // unwrapped from the allOf. Result: just the lead leaf.
      expect(row.audienceConditions).toEqual({
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead'],
      });
    });
  });
});

// ─────────────────────────────────────────────
// Full-chain reproduction — Fred's EXACT PROD shape
//
// This is the canonical operator-as-test-anchor scenario: Fred's session
// emitted this exact tree; pre-KAN-1204 it failed schema validation at
// the generator; post-fix it normalizes + persists + passes schema.
// ─────────────────────────────────────────────

describe("KAN-1204 audience — Fred's exact PROD shape full-chain reproduction", () => {
  it("normalizes Fred's anyOf+allOf tree with bad enum + lte-on-date into canonical shape", async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        {
          kind: 'extracted',
          // Fred's PROD audience verbatim from the sidebar JSON he saw at
          // 12:12 UTC after KAN-1203 deployed (truncated trailing Z time).
          value: {
            anyOf: [
              { allOf: [{ field: 'lifecycleStage', op: 'in', values: ['lead'] }] },
              {
                allOf: [
                  { field: 'lifecycleStage', op: 'in', values: ['customer', 'contact'] },
                  { field: 'orders.placedAt', op: 'lte', value: '2026-03-18T00:00:00.000Z' },
                ],
              },
            ],
          },
          confidence: 'high',
          aiMessage: 'Got leads OR customers with pre-March orders.',
        },
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        {
          tenantId: tenant.id,
          message: 'leads or pre-March customers',
          state: STATE_AUDIENCE_NEXT,
        },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { audienceConditions: true, goalType: true },
      });

      // The acceptance criterion: AudienceConditionsSchema.parse passes
      // on the persisted audience. Pre-KAN-1204 this returned the amber
      // banner in Fred's smoke; post-fix the generator's validation gate
      // passes through.
      expect(() => AudienceConditionsSchema.parse(row.audienceConditions)).not.toThrow();

      // Single-child allOf inside the first branch unwraps to the bare
      // lifecycleStage leaf; the second branch keeps its allOf with the
      // filtered ['customer'] + normalized between-shape date leaf.
      expect(row.audienceConditions).toEqual({
        anyOf: [
          { field: 'lifecycleStage', op: 'in', values: ['lead'] },
          {
            allOf: [
              { field: 'lifecycleStage', op: 'in', values: ['customer'] },
              {
                field: 'orders.placedAt',
                op: 'between',
                fromUtc: '1970-01-01T00:00:00.000Z',
                toUtcExclusive: '2026-03-18T00:00:00.000Z',
              },
            ],
          },
        ],
      });

      // Sanity check the state did reach all_dimensions_confirmed via L2.
      expect(result.kind).toBe('all_dimensions_confirmed');
    });
  });
});

// ─────────────────────────────────────────────
// Unmappable input — Campaign row not corrupted
// ─────────────────────────────────────────────

describe('KAN-1204 audience — unmappable input does not corrupt Campaign row', () => {
  it('leaves audienceConditions as the createDraftCampaign default ({}) when all leaves are unmappable', async () => {
    const { handleChatTurn } = (await import(orchestratorSpec)) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([
        {
          kind: 'extracted',
          value: {
            allOf: [
              { field: 'totally_invented_field', op: 'matches', regex: '.*' },
              { field: 'another_invention', value: 42 },
            ],
          },
          confidence: 'high',
          aiMessage: 'Got something exotic.',
        },
      ]);
      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'some weird filter', state: STATE_AUDIENCE_NEXT },
        TODAY,
      );
      const campaignId = (result as { campaignId: string }).campaignId;
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { audienceConditions: true },
      });
      // Default from createDraftCampaign is {} (empty object). The persist
      // code does not write when normalizer returns err — column stays {}.
      expect(row.audienceConditions).toEqual({});
    });
  });
});
