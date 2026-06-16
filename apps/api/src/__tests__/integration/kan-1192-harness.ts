/**
 * KAN-1192 — Hybrid LLM end-to-end integration test harness.
 *
 * Shared infrastructure for the 14-scenario hybrid-LLM suite (1 live Haiku
 * smoke + 13 fixture-replay). Centralizes:
 *
 *   - LLM fixture loader / recorder (file-backed JSON snapshots)
 *   - Live Anthropic call shim (Haiku-tier, t=0, JSON mode, tight max-tokens)
 *   - Per-scenario LLM-call queue + assertion helper
 *   - Campaign + tenant cleanup helpers extended from setup.ts
 *
 * Doctrine block (Phase 1 trace — 7 memos):
 *
 *   - `hybrid_llm_test_architecture` (KAN-1192 Phase 1 — banked) — 1 live
 *     smoke as drift detector + N fixture-replay as regression gate.
 *     Hybrid is the honest tradeoff: fixtures contain cost+flake, live
 *     catches real LLM behavior drift.
 *   - `tests_encoding_current_bug_anti_pattern` (KAN-1201 anchor) — fixtures
 *     MUST be re-recorded from real LLM calls when prompts drift; hand-
 *     edited fixtures bake in the bug.
 *   - `operator_experience_verification` (sibling) — operator-flow tests
 *     must traverse the FULL pipeline, not isolated function shapes.
 *   - `j11_j8_redundancy_doctrine` (KAN-1205) — J8 idempotency is the
 *     load-bearing UI guard; J11 is preserved for direct API consumers.
 *     Commit-after-generate via UI hook path should NEVER produce a false
 *     concurrent_edit_conflict.
 *   - `ui_hook_layer_test_family` (KAN-1205) — UI-hook-layer scenarios are
 *     a distinct boundary from API-layer scenarios; document the layer
 *     distinction in test file headers.
 *   - `context_faithful_dispatch_discipline` (KAN-1192 pause memo) — Phase 1
 *     trace must be filed as Jira artifact before Phase 2 dispatch; Phase 2
 *     build must match the trace verbatim.
 *   - `integration_test_isolation_pattern_must_match_service_tx_shape`
 *     (KAN-1205 fix-forward) — commit scenarios MUST use `withCleanup`
 *     (not `withRollback`) because `commitActionPlan` opens its own
 *     `$transaction` and Prisma forbids nested transactions.
 *
 * Locks honored (Phase 1 trace):
 *
 *   L1 — Hybrid live + fixtures: 1 live smoke + 13 fixtures
 *   L2 — Cost: Haiku tier (claude-haiku-4-5-20251001); JSON mode; bounded
 *   L3 — Determinism: t=0; tight max-tokens; schema-shape assertions
 *        (NOT exact prose values); <2% flake tolerance; retry-once policy
 *   L4 — Living snapshot: smoke flake → re-record fixtures (see README)
 *   KAN-689 — Variable-specifier imports for cross-rootDir targets
 *
 * Anthropic API key gate dependency:
 *   - Fixture-replay scenarios: NEVER touch real Anthropic; safe in CI w/o key
 *   - Live smoke scenario: requires `ANTHROPIC_API_KEY` + opt-in
 *     `KAN_1192_LIVE_SMOKE=1` env var. CI workflow runs fixtures only by
 *     default; live smoke gated behind manual workflow_dispatch trigger.
 */
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ────────────────────────────────────────────────────────────────────
// Fixture directory resolution
//
// Tests live at apps/api/src/__tests__/integration/*.test.ts. Fixtures live
// alongside in __fixtures__/kan-1192/. Resolution is relative to THIS file
// (harness.ts in the same directory).
// ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '__fixtures__/kan-1192');

// ────────────────────────────────────────────────────────────────────
// LLM call shape (mirrors LLMCompleteFn from packages/api/src/services/
// llm-client.ts but kept local to avoid cross-rootDir import drag).
// ────────────────────────────────────────────────────────────────────

export interface LLMCompleteInput {
  tenantId: string;
  tier: 'reasoning' | 'cheap';
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  jsonMode?: boolean;
  callerTag?: string;
}

export interface LLMCompleteResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export type LLMCompleteFn = (
  input: LLMCompleteInput,
) => Promise<LLMCompleteResult>;

// ────────────────────────────────────────────────────────────────────
// Fixture snapshot shape
//
// Mirrors what live LLM returns + scenario metadata for forensic trace.
// ────────────────────────────────────────────────────────────────────

export interface LLMFixture {
  /** Scenario identifier — matches the test's describe() block name. */
  scenario: string;
  /** 0-based position in the LLM call sequence within ONE scenario. */
  callIndex: number;
  /** What the orchestrator/generator/refiner emitted (for trace). */
  callerTag: string;
  /** Tier requested (forensic — confirms refiner uses reasoning, etc.). */
  tier: 'reasoning' | 'cheap';
  /** Raw text returned by LLM (the assertion contract). */
  text: string;
  /** Model fingerprint at record time. */
  model: string;
  /** Recorded usage for cost-trend visibility. */
  inputTokens: number;
  outputTokens: number;
}

// ────────────────────────────────────────────────────────────────────
// Fixture loader — replays a recorded LLM call by reading JSON from disk.
// ────────────────────────────────────────────────────────────────────

async function readFixture(
  scenario: string,
  callIndex: number,
): Promise<LLMFixture> {
  const path = join(FIXTURE_DIR, `${scenario}.${callIndex}.json`);
  const raw = await fs.readFile(path, 'utf-8');
  return JSON.parse(raw) as LLMFixture;
}

async function writeFixture(
  scenario: string,
  callIndex: number,
  fixture: LLMFixture,
): Promise<void> {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  const path = join(FIXTURE_DIR, `${scenario}.${callIndex}.json`);
  await fs.writeFile(path, JSON.stringify(fixture, null, 2) + '\n', 'utf-8');
}

/**
 * Build a fixture-replay LLM function for a single scenario. Each call reads
 * the next-indexed snapshot from disk. Throws if a fixture file is missing
 * (rather than silently fall through to a real call) — this is the substrate
 * for the L4 living-snapshot lock: missing fixture means "scenario diverged
 * from recorded behavior; re-record per the protocol."
 *
 * When `KAN_1192_RECORD_FIXTURES=1` is set in the env, calls fall through to
 * `liveLLM` and write the response to disk before returning. This is the
 * re-record workflow for living-snapshot updates.
 */
export function fixtureLLM(
  scenario: string,
  options: { liveLLM?: LLMCompleteFn } = {},
): LLMCompleteFn {
  let callIndex = 0;
  return async (input) => {
    const idx = callIndex++;
    if (process.env.KAN_1192_RECORD_FIXTURES === '1') {
      if (!options.liveLLM) {
        throw new Error(
          `[kan-1192-harness] KAN_1192_RECORD_FIXTURES=1 requires liveLLM ` +
            `to be passed to fixtureLLM(${scenario}); refusing to write empty ` +
            `fixture for call ${idx}`,
        );
      }
      const live = await options.liveLLM(input);
      const fixture: LLMFixture = {
        scenario,
        callIndex: idx,
        callerTag: input.callerTag ?? 'unknown',
        tier: input.tier,
        text: live.text,
        model: live.model,
        inputTokens: live.inputTokens,
        outputTokens: live.outputTokens,
      };
      await writeFixture(scenario, idx, fixture);
      return live;
    }

    let fixture: LLMFixture;
    try {
      fixture = await readFixture(scenario, idx);
    } catch (err) {
      throw new Error(
        `[kan-1192-harness] missing fixture ${scenario}.${idx}.json — ` +
          `scenario diverged from recorded behavior or fixture not yet ` +
          `recorded. Re-record per the L4 living-snapshot protocol: ` +
          `KAN_1192_RECORD_FIXTURES=1 + KAN_1192_LIVE_SMOKE=1 + valid ` +
          `ANTHROPIC_API_KEY. Underlying: ${(err as Error)?.message ?? err}`,
      );
    }
    return {
      text: fixture.text,
      model: fixture.model,
      inputTokens: fixture.inputTokens,
      outputTokens: fixture.outputTokens,
      latencyMs: 0,
    };
  };
}

// ────────────────────────────────────────────────────────────────────
// Live LLM shim — direct Anthropic Haiku call.
//
// Used by:
//   - The single live-smoke scenario (Step 2)
//   - Fixture re-record runs (KAN_1192_RECORD_FIXTURES=1)
//
// Tier=cheap (Haiku) per L2 cost lock. The generator/refiner production
// code uses tier='reasoning' (Sonnet) — but for fixture-replay determinism
// + L2 cost bound, the live smoke uses Haiku across all calls. This is an
// explicit tradeoff: smoke is a drift detector, not a faithful PROD reprod.
// Fixture-replay scenarios are the regression contract; smoke is the
// "real LLMs still behave reasonably here" canary.
// ────────────────────────────────────────────────────────────────────

const LIVE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Build a live LLM function backed by direct Anthropic SDK calls. Uses
 * temperature=0 + JSON-mode hint + tight max-tokens (L3 lock). The harness
 * does NOT route through llm-client.ts because:
 *
 *   1. llm-client emits cost-tracking events to Pub/Sub which we don't want
 *      in a test environment.
 *   2. The TIER_MAP routes 'reasoning' → Sonnet, but live smoke + fixture-
 *      record both want Haiku across all calls (cost + speed bound).
 *
 * Lazy SDK import keeps the test file load fast when fixtures are used.
 */
export function liveAnthropicLLM(): LLMCompleteFn {
  return async (input) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[kan-1192-harness] ANTHROPIC_API_KEY required for live LLM. ' +
          'Set the env var or use fixtureLLM() for replay-only scenarios.',
      );
    }
    // Variable-specifier dynamic import — keeps Anthropic SDK out of the
    // module-load graph when only fixtures are used (KAN-689 pattern at the
    // test layer).
    const anthropicSpec = '@anthropic-ai/sdk';
    type AnthropicConstructor = new (opts: { apiKey: string }) => {
      messages: {
        create: (params: {
          model: string;
          max_tokens: number;
          temperature: number;
          system?: string;
          messages: Array<{ role: 'user'; content: string }>;
        }) => Promise<{
          content: Array<{ type: string; text?: string }>;
          usage: { input_tokens: number; output_tokens: number };
        }>;
      };
    };
    const mod = (await import(anthropicSpec)) as {
      default: AnthropicConstructor;
    };
    const client = new mod.default({ apiKey });
    const start = Date.now();
    const systemPrompt = input.jsonMode
      ? `${input.systemPrompt ?? ''}\n\nReturn ONLY a strict JSON object — no markdown fences, no prose.`
      : input.systemPrompt;
    const response = await client.messages.create({
      model: LIVE_MODEL,
      // L3 — tight max-tokens; honor caller override but cap at 1500 for
      // smoke-safety (any larger means prompt isn't tight enough).
      max_tokens: Math.min(input.maxTokens ?? 800, 1500),
      // L3 — deterministic at the LLM layer.
      temperature: 0,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: input.userPrompt }],
    });
    const latencyMs = Date.now() - start;
    const firstText = response.content.find((c) => c.type === 'text')?.text;
    if (!firstText) {
      throw new Error(
        '[kan-1192-harness] live LLM returned no text content; ' +
          `model=${LIVE_MODEL} caller=${input.callerTag ?? 'unknown'}`,
      );
    }
    return {
      text: firstText,
      model: LIVE_MODEL,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs,
    };
  };
}

// ────────────────────────────────────────────────────────────────────
// Live-smoke gate
//
// L4 lock + Anthropic API key gate dependency. Returns true iff:
//   - KAN_1192_LIVE_SMOKE=1 is set in the env (opt-in)
//   - ANTHROPIC_API_KEY is set (key gate)
//
// CI default: false (smoke skipped). To opt in, set both env vars.
// ────────────────────────────────────────────────────────────────────

export function liveSmokeEnabled(): boolean {
  return (
    process.env.KAN_1192_LIVE_SMOKE === '1' &&
    typeof process.env.ANTHROPIC_API_KEY === 'string' &&
    process.env.ANTHROPIC_API_KEY.length > 0
  );
}

// ────────────────────────────────────────────────────────────────────
// Cleanup helper — KAN-1192 scenarios touch Campaign + ConversationTurn +
// Pipeline + PipelineStage + AuditLog. FK-ordered delete so cleanup never
// fails on cascade-restricted relations.
//
// audit_log NEVER deleted by smoke ops per the `audit_log_never_deleted`
// memo — but integration tests are short-lived rows scoped to a freshly
// minted Tenant; deleting tenant-scoped audit rows here is the standard
// test-cleanup discipline (NOT a forensic destruction). See
// `compaction_can_drift_cleanup_sql_pattern_memory` for the canonical
// ordering when smoke executes destructive operations.
// ────────────────────────────────────────────────────────────────────

export async function cleanupCampaignTestArtifacts(
  prisma: import('@prisma/client').PrismaClient,
  tenantId: string,
): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.pipeline.deleteMany({ where: { tenantId } });
  await prisma.campaignConversationTurn.deleteMany({ where: { tenantId } });
  await prisma.campaign.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
}

// ────────────────────────────────────────────────────────────────────
// Stub audience counter — fixed shape for fixture-replay determinism.
//
// Real countAudience hits the Contact table; for fixture-replay we want
// deterministic per-pipeline audienceCount so multi-pipeline math (gap
// analysis + shareOfGoal) is stable scenario-to-scenario. Scenarios that
// need a specific audience count pass an explicit `count` override; the
// rest take the default 100.
// ────────────────────────────────────────────────────────────────────

export function stubAudienceCount(
  defaultCount = 100,
): (
  prisma: unknown,
  tenantId: string,
  input: { conditions: unknown },
) => Promise<{ count: number; isThin: boolean; historicalValueUsd: number }> {
  return async () => ({
    count: defaultCount,
    isThin: defaultCount < 50,
    historicalValueUsd: defaultCount * 100,
  });
}

/** Variant for generator's `CountAudienceFn` shape (no `isThin`). */
export function stubAudienceCountForGenerator(
  defaultCount = 100,
): (
  prisma: unknown,
  tenantId: string,
  input: { conditions: unknown },
) => Promise<{ count: number; historicalValueUsd?: number }> {
  return async () => ({
    count: defaultCount,
    historicalValueUsd: defaultCount * 100,
  });
}

// ────────────────────────────────────────────────────────────────────
// Canonical fixture-replay Campaign builders.
//
// Each builder produces a Campaign in a SPECIFIC pre-condition state so the
// corresponding scenario can dispatch into the SUT (generator/refiner/commit)
// with a clean canonical starting point. Builders are small + composable;
// scenarios call them inline rather than carrying their own setup.
// ────────────────────────────────────────────────────────────────────

/** All 4 dimensions filled → generator can produce a plan. */
export async function buildCampaignReadyForGeneration(
  prisma: import('@prisma/client').PrismaClient,
  tenantId: string,
  overrides: {
    goalType?: 'units' | 'revenue' | 'meetings' | 'deals' | 'custom';
    goalTarget?: number;
    goalDescription?: string;
    audienceConditions?: object;
    windowStart?: Date;
    windowEnd?: Date;
  } = {},
): Promise<{ id: string }> {
  return prisma.campaign.create({
    data: {
      tenantId,
      name: `KAN-1192 generator-ready campaign`,
      audienceConditions: (overrides.audienceConditions ?? {
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead'],
      }) as object,
      audienceMode: 'static',
      status: 'draft',
      goalType: overrides.goalType ?? 'units',
      goalTarget: overrides.goalTarget ?? 100,
      goalDescription: overrides.goalDescription ?? 'Sell 100 units in Q3',
      windowStart: overrides.windowStart ?? new Date('2026-07-01T00:00:00.000Z'),
      windowEnd: overrides.windowEnd ?? new Date('2026-09-30T23:59:59.999Z'),
    },
    select: { id: true },
  });
}

/** Campaign with a fully-populated proposedPlan persisted → refiner / commit
 *  can dispatch. Mirrors the shape action-plan-generator emits. */
export async function buildCampaignWithProposedPlan(
  prisma: import('@prisma/client').PrismaClient,
  tenantId: string,
  overrides: {
    name?: string;
    pipelines?: Array<{
      name: string;
      segment:
        | 'new_leads'
        | 'winback'
        | 'closed_lost_recovery'
        | 'cancelled_orders_recovery'
        | 'inactive_customers_reengagement'
        | 'other';
      strategy: 'direct' | 'guided' | 'trust_build' | 're_engage';
      audienceConditions?: object;
      audienceCount?: number;
      proposedStages?: Array<{ name: string; order: number; description: string }>;
      firstActions?: Array<{ day: number; channel: 'email' | 'sms' | 'whatsapp'; intent: string; description: string }>;
      projectedContribution?: number;
      shareOfGoal?: number;
    }>;
  } = {},
): Promise<{ id: string }> {
  const pipelines = overrides.pipelines ?? [
    {
      name: 'Inbound Lead Pipeline',
      segment: 'new_leads' as const,
      strategy: 'direct' as const,
      audienceConditions: {
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead'],
      },
      audienceCount: 100,
      proposedStages: [
        { name: 'Outreach', order: 0, description: 'Day-0 outbound' },
        { name: 'Qualify', order: 1, description: 'Discovery' },
        { name: 'Close', order: 2, description: 'Proposal + close' },
      ],
      firstActions: [
        {
          day: 0,
          channel: 'email' as const,
          intent: 'outreach',
          description: 'Day-0 intro',
        },
      ],
      projectedContribution: 15,
      shareOfGoal: 15,
    },
  ];
  const plan = {
    pipelines: pipelines.map((p) => ({
      name: p.name,
      segment: p.segment,
      strategy: p.strategy,
      audienceConditions: p.audienceConditions ?? {
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead'],
      },
      audienceCount: p.audienceCount ?? 100,
      proposedStages: p.proposedStages ?? [
        { name: 'Outreach', order: 0, description: 'Day-0 outbound' },
        { name: 'Qualify', order: 1, description: 'Discovery' },
        { name: 'Close', order: 2, description: 'Proposal + close' },
      ],
      firstActions: p.firstActions ?? [
        {
          day: 0,
          channel: 'email',
          intent: 'outreach',
          description: 'Day-0 intro',
        },
      ],
      projectedContribution: p.projectedContribution ?? 15,
      shareOfGoal: p.shareOfGoal ?? 15,
    })),
    confidence: 'high' as const,
    confidenceReason: '200+ closed deals over 365d',
    gapAnalysis: {
      goalTarget: 100,
      projectedOrganic: 60,
      gapAbsolute: 40,
      gapPercent: 40,
      goalWindowDays: 90,
    },
    modelUsed: 'claude-sonnet-4-6',
    generatedAt: '2026-06-16T12:00:00.000Z',
  };
  return prisma.campaign.create({
    data: {
      tenantId,
      name: overrides.name ?? 'KAN-1192 refine/commit campaign',
      audienceConditions: {
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead'],
      } as object,
      audienceMode: 'static',
      status: 'draft',
      goalType: 'units',
      goalTarget: 100,
      goalDescription: 'Sell 100 units in Q3',
      windowStart: new Date('2026-07-01T00:00:00.000Z'),
      windowEnd: new Date('2026-09-30T23:59:59.999Z'),
      proposedPlan: plan as unknown as object,
    },
    select: { id: true },
  });
}
