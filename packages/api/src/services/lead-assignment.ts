/**
 * Lead Assignment — KAN-705 (Sprint 1.6)
 *
 * Hybrid lead → pipeline routing: tenant-defined rules first (deterministic,
 * audit-trivial, <50ms), AI fallback on miss (Sonnet 4.6 reasoning tier per
 * KAN-699 — assignment is consequential, wrong routing breaks every
 * downstream stage/objective/message).
 *
 * Resolution order:
 *   1. Tenant rules (AssignmentRule, ordered by priority asc; first match wins)
 *   2. AI fallback (llm-client tier='reasoning', JSON-mode → { pipelineId, confidence, reasoning })
 *   3. Below-threshold posture (Tenant.belowThresholdPosture):
 *        - stay_unassigned (default — safest cold-start posture)
 *        - default_pipeline (Tenant.defaultAssignmentPipelineId)
 *        - escalate_to_human (creates an Escalation row for manual triage)
 *
 * Audit: every decision emits an AuditLog row with actionType='lead_assignment'
 * — KAN-712 will materialize a typed event stream when Sprint 5's learning
 * system needs aggregate query patterns audit can't support efficiently.
 *
 * Cast-loose `(prisma as any)` accessors on the new Prisma delegates keep
 * the new types out of the apps/api TS6059 graph (same pattern used for
 * KAN-700/703/704 model surfaces).
 */

import type { PrismaClient } from '@prisma/client';
import { complete as llmComplete } from './llm-client.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Lead attributes matched against AssignmentRule conditions. */
export interface LeadAttributes {
  source?: string | null;
  segment?: string | null;
  lifecycleStage?: string | null;
  dataQualityScore?: number | null;
  email?: string | null;
  emailDomain?: string | null;
  externalIds?: Record<string, unknown> | null;
}

/** AssignmentRule shape as loaded from Prisma. */
export interface AssignmentRuleRow {
  id: string;
  pipelineId: string;
  priority: number;
  conditions: Record<string, unknown>;
  isActive: boolean;
}

/** Per-pipeline summary passed to the AI fallback. */
export interface PipelineSummary {
  id: string;
  name: string;
  objectiveType: string;
  objectiveDescription: string | null;
}

/** Knowledge hit passed to the AI fallback prompt. */
export interface KnowledgeContext {
  contentType: string;
  contentText?: string;
}

/** Below-threshold posture values — match the Prisma enum @@map. */
export type BelowThresholdPosture = 'stay_unassigned' | 'default_pipeline' | 'escalate_to_human';

export type AssignmentResult =
  | { mode: 'rule'; ruleId: string; pipelineId: string; stageId: string | null }
  | { mode: 'ai_fallback'; pipelineId: string; stageId: string | null; confidence: number; reasoning: string }
  | { mode: 'default_pipeline'; pipelineId: string; stageId: string | null }
  | { mode: 'escalated'; escalationId: string }
  | { mode: 'unassigned'; reason: string };

export interface AssignLeadOptions {
  /** When true and contact already has currentPipelineId set, skip without re-evaluating. */
  skipIfAssigned?: boolean;
  /** Override the AI confidence threshold (otherwise read from Tenant.aiAssignmentConfidenceThreshold, default 0.5). */
  aiConfidenceThresholdOverride?: number;
}

// ─────────────────────────────────────────────
// Predicate language — V1 simple AND-of-field-conditions
// ─────────────────────────────────────────────

/**
 * Match a Lead's attributes against a rule's conditions JSON.
 *
 * V1 predicate language (AND across keys, per-key value match):
 *   - Scalar:   `{ source: "hubspot" }`        → equality
 *   - Array:    `{ source: ["hubspot", "meta"] }` → IN
 *   - Operators: `{ dataQualityScore: { gte: 50 } }`
 *               supported: eq | ne | gte | lte | gt | lt | in
 *
 * Empty conditions object always matches (allows a "catch-all" rule at the
 * lowest priority for routing everything to a single pipeline).
 */
export function matchesConditions(
  leadAttrs: LeadAttributes,
  conditions: Record<string, unknown>,
): boolean {
  for (const [field, condition] of Object.entries(conditions)) {
    const value = (leadAttrs as Record<string, unknown>)[field];
    if (!matchesField(value, condition)) return false;
  }
  return true;
}

function matchesField(value: unknown, condition: unknown): boolean {
  // Array-as-IN shorthand.
  if (Array.isArray(condition)) {
    return condition.includes(value);
  }
  // Explicit operator object.
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    const op = condition as Record<string, unknown>;
    if ('eq' in op) return value === op.eq;
    if ('ne' in op) return value !== op.ne;
    if ('in' in op && Array.isArray(op.in)) return op.in.includes(value);
    if ('gte' in op) return typeof value === 'number' && value >= (op.gte as number);
    if ('lte' in op) return typeof value === 'number' && value <= (op.lte as number);
    if ('gt' in op) return typeof value === 'number' && value > (op.gt as number);
    if ('lt' in op) return typeof value === 'number' && value < (op.lt as number);
    return false;
  }
  // Scalar equality.
  return value === condition;
}

/**
 * Walk rules in priority order (lower number = higher precedence). Return the
 * first rule whose conditions match, or null on no-match. Pure: no I/O, no
 * side effects.
 */
export function evaluateRules(
  rules: AssignmentRuleRow[],
  leadAttrs: LeadAttributes,
): AssignmentRuleRow | null {
  const sorted = [...rules]
    .filter((r) => r.isActive)
    .sort((a, b) => a.priority - b.priority);
  for (const r of sorted) {
    if (matchesConditions(leadAttrs, r.conditions)) return r;
  }
  return null;
}

// ─────────────────────────────────────────────
// AI fallback (Sonnet 4.6 reasoning tier)
// ─────────────────────────────────────────────

const AI_FALLBACK_SYSTEM_PROMPT =
  'You are a sales pipeline routing AI. Pick the best pipeline for a new lead from the available catalog. ' +
  'Respond with ONLY valid JSON in the exact format specified. No markdown, no code fences, no extra text.';

interface AIFallbackOutput {
  pipelineId: string;
  confidence: number;
  reasoning: string;
}

export async function aiAssignmentFallback(
  leadAttrs: LeadAttributes,
  pipelines: PipelineSummary[],
  knowledge: KnowledgeContext[] = [],
): Promise<AIFallbackOutput | null> {
  if (pipelines.length === 0) return null;

  const pipelineCatalog = pipelines
    .map(
      (p, i) =>
        `${i + 1}. id=${p.id} | name=${p.name} | objectiveType=${p.objectiveType}${
          p.objectiveDescription ? ` — ${p.objectiveDescription}` : ''
        }`,
    )
    .join('\n');

  const knowledgeBlock =
    knowledge.length > 0
      ? `\nTenant Knowledge (use to inform routing; do not contradict):\n${knowledge
          .map((k, i) => `${i + 1}. [${k.contentType}] ${(k.contentText ?? '').trim()}`)
          .filter((l) => l.trim().length > 0)
          .join('\n')}\n`
      : '';

  const userPrompt = `A new lead arrived. Tenant rules did not match. Pick the best pipeline.

Lead attributes:
- source: ${leadAttrs.source ?? 'unknown'}
- segment: ${leadAttrs.segment ?? 'unknown'}
- lifecycleStage: ${leadAttrs.lifecycleStage ?? 'unknown'}
- dataQualityScore: ${leadAttrs.dataQualityScore ?? 'unknown'}
- emailDomain: ${leadAttrs.emailDomain ?? 'unknown'}

Available pipelines:
${pipelineCatalog}
${knowledgeBlock}
Respond with ONLY this JSON object (no other text, no markdown):
{
  "pipelineId": "<one of the pipeline ids above>",
  "confidence": <number from 0 to 1>,
  "reasoning": "<one sentence explaining the choice>"
}`;

  const llm = await llmComplete({
    tier: 'reasoning',
    systemPrompt: AI_FALLBACK_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 256,
    jsonMode: true,
    callerTag: 'lead-assignment:ai-fallback',
  });

  let jsonStr = llm.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  try {
    const parsed = JSON.parse(jsonStr) as Partial<AIFallbackOutput>;
    if (typeof parsed.pipelineId !== 'string') return null;
    if (typeof parsed.confidence !== 'number') return null;
    if (typeof parsed.reasoning !== 'string') return null;
    // Verify the LLM picked a real pipeline ID from the catalog (defensive — Sonnet 4.6 is reliable but
    // an unknown pipeline ID would write a bad assignment).
    if (!pipelines.some((p) => p.id === parsed.pipelineId)) return null;
    // Clamp confidence to [0, 1].
    const confidence = Math.max(0, Math.min(1, parsed.confidence));
    return {
      pipelineId: parsed.pipelineId,
      confidence,
      reasoning: parsed.reasoning,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Orchestrator: rules → AI fallback → posture
// ─────────────────────────────────────────────

const DEFAULT_AI_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Assign a lead (Contact) to a pipeline using the documented resolution order.
 * Idempotent when `skipIfAssigned: true` — caller can re-fire on every lead
 * update without thrashing existing assignments.
 *
 * Side effects (per assignment branch):
 *   - rule / ai_fallback / default_pipeline → updates Contact.currentPipelineId
 *     + currentStageId (initial stage of the chosen pipeline) + enteredStageAt;
 *     writes a LeadStageHistory row (fromStageId=null on initial assignment).
 *   - escalated → creates an Escalation row, no Contact update.
 *   - unassigned → no DB writes other than the audit log.
 *
 * Always emits exactly one AuditLog row with actionType='lead_assignment' and
 * a structured payload describing which branch fired + which rule/llm output
 * drove the decision.
 */
export async function assignLeadToPipeline(
  prisma: PrismaClient,
  contactId: string,
  options: AssignLeadOptions = {},
): Promise<AssignmentResult> {
  const contact = await loadContactForAssignment(prisma, contactId);
  if (!contact) throw new Error(`assignLeadToPipeline: contact ${contactId} not found`);

  if (options.skipIfAssigned && contact.currentPipelineId) {
    return { mode: 'rule', ruleId: 'pre-existing', pipelineId: contact.currentPipelineId, stageId: contact.currentStageId };
  }

  const tenantId = contact.tenantId;
  const tenant = await loadTenantConfig(prisma, tenantId);

  const leadAttrs: LeadAttributes = {
    source: contact.source,
    segment: contact.segment,
    lifecycleStage: contact.lifecycleStage,
    dataQualityScore: contact.dataQualityScore,
    email: contact.email,
    emailDomain: contact.email ? contact.email.split('@')[1] ?? null : null,
    externalIds: (contact.externalIds as Record<string, unknown>) ?? null,
  };

  // 1. Rules tier.
  const rules = await loadActiveRulesForTenant(prisma, tenantId);
  const matched = evaluateRules(rules, leadAttrs);
  if (matched) {
    const stageId = await resolveInitialStageId(prisma, matched.pipelineId);
    await persistAssignment(prisma, contactId, matched.pipelineId, stageId, 'rule', matched.id);
    await emitAuditLog(prisma, {
      tenantId,
      contactId,
      mode: 'rule',
      payload: { ruleId: matched.id, pipelineId: matched.pipelineId, stageId },
      reasoning: `AssignmentRule ${matched.id} matched (priority ${matched.priority}). Routed to pipeline ${matched.pipelineId}.`,
    });
    return { mode: 'rule', ruleId: matched.id, pipelineId: matched.pipelineId, stageId };
  }

  // 2. AI fallback tier.
  const pipelines = await loadTenantPipelines(prisma, tenantId);
  const knowledge: KnowledgeContext[] = []; // KAN-698 RAG hook — caller can inject; left empty by default for V1
  const ai = await aiAssignmentFallback(leadAttrs, pipelines, knowledge);
  const threshold = options.aiConfidenceThresholdOverride ?? tenant.aiAssignmentConfidenceThreshold ?? DEFAULT_AI_CONFIDENCE_THRESHOLD;

  if (ai && ai.confidence >= threshold) {
    const stageId = await resolveInitialStageId(prisma, ai.pipelineId);
    await persistAssignment(prisma, contactId, ai.pipelineId, stageId, 'ai_fallback', null);
    await emitAuditLog(prisma, {
      tenantId,
      contactId,
      mode: 'ai_fallback',
      payload: {
        pipelineId: ai.pipelineId,
        stageId,
        aiConfidence: ai.confidence,
        confidenceThreshold: threshold,
        aiReasoning: ai.reasoning,
      },
      reasoning: `AI fallback assigned to pipeline ${ai.pipelineId} (confidence ${ai.confidence.toFixed(2)} ≥ threshold ${threshold}). ${ai.reasoning}`,
    });
    return { mode: 'ai_fallback', pipelineId: ai.pipelineId, stageId, confidence: ai.confidence, reasoning: ai.reasoning };
  }

  // 3. Below-threshold posture dispatch.
  const posture = (tenant.belowThresholdPosture ?? 'stay_unassigned') as BelowThresholdPosture;
  const aiContext = ai
    ? { aiConfidence: ai.confidence, confidenceThreshold: threshold, aiReasoning: ai.reasoning }
    : { aiConfidence: null, confidenceThreshold: threshold, aiReasoning: 'AI fallback returned no usable result' };

  if (posture === 'default_pipeline' && tenant.defaultAssignmentPipelineId) {
    const targetPipelineId = tenant.defaultAssignmentPipelineId;
    const stageId = await resolveInitialStageId(prisma, targetPipelineId);
    await persistAssignment(prisma, contactId, targetPipelineId, stageId, 'default_pipeline', null);
    await emitAuditLog(prisma, {
      tenantId,
      contactId,
      mode: 'default_pipeline',
      payload: { pipelineId: targetPipelineId, stageId, ...aiContext },
      reasoning: `Below threshold (posture=default_pipeline). Routed to tenant default pipeline ${targetPipelineId}.`,
    });
    return { mode: 'default_pipeline', pipelineId: targetPipelineId, stageId };
  }

  if (posture === 'escalate_to_human') {
    const escalationId = await createAssignmentEscalation(prisma, tenantId, contactId, aiContext);
    await emitAuditLog(prisma, {
      tenantId,
      contactId,
      mode: 'escalated',
      payload: { escalationId, ...aiContext },
      reasoning: `Below threshold (posture=escalate_to_human). Created Escalation ${escalationId} for manual triage.`,
    });
    return { mode: 'escalated', escalationId };
  }

  // Default conservative posture: stay_unassigned.
  await emitAuditLog(prisma, {
    tenantId,
    contactId,
    mode: 'unassigned',
    payload: aiContext,
    reasoning: `Below threshold (posture=stay_unassigned). Lead surfaces in tenant inbox for manual triage.`,
  });
  return { mode: 'unassigned', reason: 'below_threshold_no_assignment' };
}

// ─────────────────────────────────────────────
// Prisma adapters — cast-loose to keep new types out of apps/api TS6059 graph
// ─────────────────────────────────────────────

interface ContactForAssignment {
  id: string;
  tenantId: string;
  source: string | null;
  segment: string | null;
  lifecycleStage: string | null;
  dataQualityScore: number | null;
  email: string | null;
  externalIds: unknown;
  currentPipelineId: string | null;
  currentStageId: string | null;
}

async function loadContactForAssignment(
  prisma: PrismaClient,
  contactId: string,
): Promise<ContactForAssignment | null> {
  const c: any = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!c) return null;
  return {
    id: c.id,
    tenantId: c.tenantId,
    source: c.source ?? null,
    segment: c.segment ?? null,
    lifecycleStage: c.lifecycleStage ?? null,
    dataQualityScore: c.dataQualityScore ?? null,
    email: c.email ?? null,
    externalIds: c.externalIds ?? null,
    currentPipelineId: c.currentPipelineId ?? null,
    currentStageId: c.currentStageId ?? null,
  };
}

interface TenantConfigForAssignment {
  belowThresholdPosture: string | null;
  defaultAssignmentPipelineId: string | null;
  aiAssignmentConfidenceThreshold: number | null;
}

async function loadTenantConfig(
  prisma: PrismaClient,
  tenantId: string,
): Promise<TenantConfigForAssignment> {
  const t: any = await prisma.tenant.findUnique({ where: { id: tenantId } });
  return {
    belowThresholdPosture: t?.belowThresholdPosture ?? null,
    defaultAssignmentPipelineId: t?.defaultAssignmentPipelineId ?? null,
    aiAssignmentConfidenceThreshold: t?.aiAssignmentConfidenceThreshold ?? null,
  };
}

async function loadActiveRulesForTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<AssignmentRuleRow[]> {
  const rows: any[] = (await (prisma as any).assignmentRule?.findMany({
    where: { tenantId, isActive: true },
    orderBy: { priority: 'asc' },
  })) ?? [];
  return rows.map((r) => ({
    id: r.id,
    pipelineId: r.pipelineId,
    priority: r.priority,
    conditions: (r.conditions ?? {}) as Record<string, unknown>,
    isActive: r.isActive,
  }));
}

async function loadTenantPipelines(
  prisma: PrismaClient,
  tenantId: string,
): Promise<PipelineSummary[]> {
  const rows: any[] = (await (prisma as any).pipeline?.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true, objectiveType: true, objectiveDescription: true },
  })) ?? [];
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    objectiveType: p.objectiveType,
    objectiveDescription: p.objectiveDescription ?? null,
  }));
}

async function resolveInitialStageId(
  prisma: PrismaClient,
  pipelineId: string,
): Promise<string | null> {
  const stage: any = await (prisma as any).stage?.findFirst({
    where: { pipelineId, isInitial: true },
    orderBy: { order: 'asc' },
    select: { id: true },
  });
  return stage?.id ?? null;
}

async function persistAssignment(
  prisma: PrismaClient,
  contactId: string,
  pipelineId: string,
  stageId: string | null,
  mode: AssignmentResult['mode'],
  ruleId: string | null,
): Promise<void> {
  await prisma.contact.update({
    where: { id: contactId },
    data: {
      currentPipelineId: pipelineId,
      currentStageId: stageId,
      enteredStageAt: stageId ? new Date() : null,
    } as any,
  });
  if (stageId) {
    await (prisma as any).leadStageHistory?.create({
      data: {
        leadId: contactId,
        fromStageId: null,
        toStageId: stageId,
        reason: ruleId ? `assignment:rule:${ruleId}` : `assignment:${mode}`,
      },
    });
  }
}

async function createAssignmentEscalation(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  aiContext: { aiConfidence: number | null; confidenceThreshold: number; aiReasoning: string },
): Promise<string> {
  const e = await prisma.escalation.create({
    data: {
      tenantId,
      contactId,
      severity: 'medium',
      triggerType: 'lead_assignment_below_threshold',
      triggerReason: `AI confidence ${aiContext.aiConfidence ?? 'n/a'} below threshold ${aiContext.confidenceThreshold}. Manual triage required.`,
      aiSuggestion: aiContext.aiReasoning,
      status: 'open',
      // KAN-750: decisionId left null — assignment escalations fire before any
      // Decision row exists for this contact. context preserves the AI-confidence
      // signal that drove the escalation for downstream review surfaces.
      context: {
        aiConfidence: aiContext.aiConfidence,
        confidenceThreshold: aiContext.confidenceThreshold,
        aiReasoning: aiContext.aiReasoning,
      } as unknown as object,
    },
  });
  return e.id;
}

interface AuditEmitInput {
  tenantId: string;
  contactId: string;
  mode: AssignmentResult['mode'] | 'unassigned';
  payload: Record<string, unknown>;
  reasoning: string;
}

async function emitAuditLog(prisma: PrismaClient, input: AuditEmitInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actor: 'system:lead-assignment',
        actionType: 'lead_assignment',
        payload: {
          contactId: input.contactId,
          assignmentMode: input.mode,
          ...input.payload,
        } as any,
        reasoning: input.reasoning,
      },
    });
  } catch (err) {
    // Best-effort: audit failure must not block the assignment write that
    // already succeeded. The Decision Engine's downstream learning will see
    // a missing audit row but the Contact row is the source-of-truth state.
    console.error('[lead-assignment] audit log emit failed', err);
  }
}
