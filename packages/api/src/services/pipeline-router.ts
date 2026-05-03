/**
 * KAN-795 — Pipeline Router (Phase 2 epic 2 of 5, sub-cohort a).
 *
 * Pure module that routes a not-yet-assigned Contact to the best-fit Pipeline
 * given the tenant's available Pipelines + the Contact's profile.
 *
 * Replaces `aiAssignmentFallback` (formerly in lead-assignment.ts) as the
 * canonical home for LLM-driven pipeline routing. The orchestrator
 * `assignLeadToPipeline` now calls `routePipelineForNewLead` after the rules
 * tier misses, then maps `PipelineRoutingDecision` back to the existing
 * `AssignmentResult` shape (no upstream-consumer change).
 *
 * Three execution paths:
 *   1. **0 candidate Pipelines** → `decision.type='no_candidates'`, no LLM
 *      call. Caller should have invoked `ensureTenantHasDefaultPipeline`
 *      upstream (KAN-793 sequencing). Defensive — should not happen in
 *      practice post-bootstrap.
 *   2. **1 candidate Pipeline** → `decision.type='route'` with confidence=1.0,
 *      no LLM call. Pure cost win — current production state (1 tenant /
 *      1 Pipeline) hits this path.
 *   3. **2+ candidate Pipelines** → LLM-driven selection (Sonnet reasoning
 *      tier by default). Defensive parsing rejects unknown pipelineIds and
 *      out-of-range confidence values. Forward-investment for KAN-807
 *      Onboarding Wizard which enables tenants to create multiple Pipelines.
 *
 * Cost win: the 0/1-Pipeline short-circuits skip the LLM call entirely. Tier
 * downshift (cheap/Haiku) is NOT the cost lever — routing is consequential
 * and a wrong route cascades to every downstream Stage/objective evaluation.
 * Per `feedback_model_pricing_refresh_discipline`, Sonnet for consequential
 * choices. `RouteOptions.tier` is the configurable knob if KAN-806 cost work
 * later needs to flip the default.
 *
 * Cost-tracking alignment: KAN-745 architecture — llm-client emits cost
 * asynchronously via the `llm.call` topic. PipelineRoutingDecision returns
 * `llmInputTokens` + `llmOutputTokens`, NOT `llmCostUsd`. Same pattern as
 * BrainDecision (KAN-794).
 */
import type { PrismaClient } from '@prisma/client';
import { complete } from './llm-client.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface PipelineCandidate {
  id: string;
  name: string;
  objectiveType: string;
  objectiveDescription: string | null;
}

export type PipelineRoutingDecisionShape =
  | { type: 'route'; pipelineId: string; reasoning: string }
  | { type: 'escalate'; reasoning: string }
  | { type: 'no_candidates'; reasoning: string };

export interface PipelineRoutingDecision {
  contactId: string;
  evaluatedAt: Date;
  candidatePipelines: PipelineCandidate[];
  decision: PipelineRoutingDecisionShape;
  /** 0-1. Caller (assignLeadToPipeline) compares against tenant threshold. */
  confidence: number;
  modelTier: 'cheap' | 'reasoning';
  /**
   * KAN-745 architecture: llm-client emits cost asynchronously via llm.call
   * topic → llm-cost-aggregator. Brain Service / Pipeline Router return raw
   * token counts so consumers can compute cost themselves (via MODEL_PRICING)
   * or join the async rollup. See feedback_model_pricing_refresh_discipline.
   */
  llmInputTokens: number;
  llmOutputTokens: number;
}

export interface RouteOptions {
  /**
   * Default tier: "reasoning" (Sonnet) — routing is consequential; wrong
   * routing cascades to every downstream stage/objective evaluation. Cost
   * wins from this module come from the 0/1-Pipeline short-circuits (skip
   * LLM entirely), not from tier downshift. KAN-806 can flip default if
   * cost budget becomes binding.
   */
  tier?: 'cheap' | 'reasoning';
}

export class PipelineRouterNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineRouterNotFoundError';
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Route a new lead to the best-fit Pipeline based on Contact context + the
 * tenant's available Pipelines.
 *
 * Pure function — does NOT persist. Caller (`assignLeadToPipeline`'s AI
 * fallback tier) reads the decision + maps to AssignmentResult shape.
 *
 * Throws PipelineRouterNotFoundError when contactId doesn't exist.
 *
 * Graceful fallback on LLM failure / malformed JSON / wrong-shape JSON /
 * pipelineId-not-in-candidates: returns `decision.type='escalate'` with
 * confidence=0 + zero tokens. Caller treats this the same as
 * "AI confidence below threshold" → posture dispatch.
 */
export async function routePipelineForNewLead(
  prisma: PrismaClient,
  contactId: string,
  options: RouteOptions = {},
): Promise<PipelineRoutingDecision> {
  const tier = options.tier ?? 'reasoning';
  const evaluatedAt = new Date();

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: {
      id: true,
      tenantId: true,
      email: true,
      lifecycleStage: true,
      segment: true,
      source: true,
      dataQualityScore: true,
      externalIds: true,
    },
  });
  if (!contact) {
    throw new PipelineRouterNotFoundError(`Contact not found: ${contactId}`);
  }

  const candidatePipelinesRaw = await prisma.pipeline.findMany({
    where: { tenantId: contact.tenantId, isActive: true },
    select: { id: true, name: true, objectiveType: true, objectiveDescription: true },
  });
  const candidatePipelines: PipelineCandidate[] = candidatePipelinesRaw.map((p) => ({
    id: p.id,
    name: p.name,
    objectiveType: p.objectiveType,
    objectiveDescription: p.objectiveDescription ?? null,
  }));

  // ── Short-circuit 1: no candidates.
  if (candidatePipelines.length === 0) {
    return {
      contactId,
      evaluatedAt,
      candidatePipelines: [],
      decision: {
        type: 'no_candidates',
        reasoning:
          'Tenant has no active Pipelines. Caller should invoke ensureTenantHasDefaultPipeline upstream (KAN-793 sequencing).',
      },
      confidence: 1.0,
      modelTier: tier,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    };
  }

  // ── Short-circuit 2: single candidate (no decision needed; pure cost win).
  if (candidatePipelines.length === 1) {
    const only = candidatePipelines[0];
    return {
      contactId,
      evaluatedAt,
      candidatePipelines,
      decision: {
        type: 'route',
        pipelineId: only.id,
        reasoning: 'Single active Pipeline available; routed by default (no LLM call needed).',
      },
      confidence: 1.0,
      modelTier: tier,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    };
  }

  // ── Multi-Pipeline case: LLM-driven routing.
  const userPrompt = buildRoutingPrompt({
    contact: {
      email: contact.email,
      lifecycleStage: contact.lifecycleStage,
      segment: contact.segment,
      source: contact.source,
      dataQualityScore: contact.dataQualityScore,
    },
    candidatePipelines,
  });

  let llmText: string;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  try {
    const response = await complete({
      tenantId: contact.tenantId,
      tier,
      systemPrompt: ROUTING_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 400,
      jsonMode: true,
      callerTag: 'pipeline-router:route-for-new-lead',
    });
    llmText = response.text;
    llmInputTokens = response.inputTokens;
    llmOutputTokens = response.outputTokens;
  } catch (err) {
    console.warn(
      `[pipeline-router] llm-call-failed contactId=${contactId} err=${(err as Error)?.message ?? String(err)}`,
    );
    return gracefulEscalate(contactId, evaluatedAt, candidatePipelines, tier, 'LLM call failed');
  }

  const parsed = parseRoutingResponse(llmText, candidatePipelines);
  if (!parsed.ok) {
    console.warn(
      `[pipeline-router] parse-failed contactId=${contactId} reason=${parsed.error} preview=${llmText.slice(0, 200)}`,
    );
    return gracefulEscalate(contactId, evaluatedAt, candidatePipelines, tier, parsed.error);
  }

  return {
    contactId,
    evaluatedAt,
    candidatePipelines,
    decision: parsed.value.decision,
    confidence: parsed.value.confidence,
    modelTier: tier,
    llmInputTokens,
    llmOutputTokens,
  };
}

// ─────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────

const ROUTING_SYSTEM_PROMPT = `You are an AI sales operations assistant routing a new lead to the best-fit sales Pipeline.

Given the Contact's profile (lifecycle stage, segment, source) and the tenant's available Pipelines (each with an objective type), pick the SINGLE best Pipeline.

If the choice is ambiguous (multiple equally-good fits, or none fit well), recommend escalate.

Respond ONLY with valid JSON in this exact shape:
{
  "decision": {
    "type": "<route|escalate>",
    "pipelineId": "<pipeline_id from candidates if route, else null>",
    "reasoning": "<one sentence explanation>"
  },
  "confidence": <0.0-1.0>
}

The pipelineId MUST be one of the provided candidate IDs verbatim. Do not invent.`;

interface PromptContact {
  email: string | null;
  lifecycleStage: string | null;
  segment: string | null;
  source: string | null;
  dataQualityScore: number | null;
}

export function buildRoutingPrompt(input: {
  contact: PromptContact;
  candidatePipelines: PipelineCandidate[];
}): string {
  const { contact, candidatePipelines } = input;
  const emailDomain = contact.email ? (contact.email.split('@')[1] ?? null) : null;

  const pipelineCatalog = candidatePipelines
    .map(
      (p, i) =>
        `${i + 1}. id=${p.id} | name=${p.name} | objectiveType=${p.objectiveType}${
          p.objectiveDescription ? ` — ${p.objectiveDescription}` : ''
        }`,
    )
    .join('\n');

  return `A new lead arrived. Tenant rules did not match. Pick the best Pipeline.

Lead attributes:
- source: ${contact.source ?? 'unknown'}
- segment: ${contact.segment ?? 'unknown'}
- lifecycleStage: ${contact.lifecycleStage ?? 'unknown'}
- dataQualityScore: ${contact.dataQualityScore ?? 'unknown'}
- emailDomain: ${emailDomain ?? 'unknown'}

Available Pipelines:
${pipelineCatalog}

Respond ONLY with the JSON shape specified in the system prompt.`;
}

// ─────────────────────────────────────────────
// Response parsing (defensive — LLMs can return partial/wrong shapes)
// ─────────────────────────────────────────────

const VALID_DECISION_TYPES: ReadonlySet<'route' | 'escalate'> = new Set<'route' | 'escalate'>([
  'route',
  'escalate',
]);

type ParsedRoutingResponse =
  | {
      ok: true;
      value: { decision: PipelineRoutingDecisionShape; confidence: number };
    }
  | { ok: false; error: string };

export function parseRoutingResponse(
  text: string,
  candidatePipelines: PipelineCandidate[],
): ParsedRoutingResponse {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Response is not an object' };
  }
  const root = parsed as Record<string, unknown>;
  const decision = root.decision;
  const confidenceRaw = root.confidence;

  if (
    typeof confidenceRaw !== 'number' ||
    !isFinite(confidenceRaw) ||
    confidenceRaw < 0 ||
    confidenceRaw > 1
  ) {
    return { ok: false, error: 'confidence not a number in [0,1]' };
  }
  if (!decision || typeof decision !== 'object') {
    return { ok: false, error: 'decision missing' };
  }
  const d = decision as Record<string, unknown>;
  if (typeof d.type !== 'string' || !VALID_DECISION_TYPES.has(d.type as 'route' | 'escalate')) {
    return { ok: false, error: `invalid decision type: ${String(d.type)}` };
  }
  if (typeof d.reasoning !== 'string' || d.reasoning.trim().length === 0) {
    return { ok: false, error: 'reasoning missing or empty' };
  }

  if (d.type === 'route') {
    if (typeof d.pipelineId !== 'string' || d.pipelineId.trim().length === 0) {
      return { ok: false, error: 'route decision missing pipelineId' };
    }
    if (!candidatePipelines.some((p) => p.id === d.pipelineId)) {
      // Defensive — Sonnet 4.6 is reliable but an unknown pipelineId would write a bad assignment.
      return { ok: false, error: `pipelineId not in candidates: ${d.pipelineId}` };
    }
    return {
      ok: true,
      value: {
        decision: { type: 'route', pipelineId: d.pipelineId, reasoning: d.reasoning },
        confidence: confidenceRaw,
      },
    };
  }

  // type === 'escalate'
  return {
    ok: true,
    value: {
      decision: { type: 'escalate', reasoning: d.reasoning },
      confidence: confidenceRaw,
    },
  };
}

// ─────────────────────────────────────────────
// Graceful fallback
// ─────────────────────────────────────────────

function gracefulEscalate(
  contactId: string,
  evaluatedAt: Date,
  candidatePipelines: PipelineCandidate[],
  tier: 'cheap' | 'reasoning',
  reason: string,
): PipelineRoutingDecision {
  return {
    contactId,
    evaluatedAt,
    candidatePipelines,
    decision: {
      type: 'escalate',
      reasoning: `Pipeline router fallback: ${reason}. Caller should treat as below-threshold and dispatch to posture.`,
    },
    confidence: 0.0,
    modelTier: tier,
    llmInputTokens: 0,
    llmOutputTokens: 0,
  };
}
