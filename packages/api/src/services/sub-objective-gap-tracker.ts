/**
 * M3-1a — Sub-Objective Gap Tracker.
 *
 * `computeGapState(prisma, tenantId, contactId, contact)` → returns the
 * prioritized list of unfilled sub-objectives for engine consumption.
 *
 * Initialize-on-touch: every call invokes `createMany(skipDuplicates: true)`
 * for all 5 default keys UNCONDITIONALLY (no `rows.length === 0` guard).
 * This self-heals partial-seed states — if a previous seed wrote 3 of 5
 * rows and crashed, the next call backfills the missing 2 (the UNIQUE
 * constraint makes the existing 3 no-ops).
 *
 * Fail-safe: any DB error returns `{ prioritizedGaps: [], topCandidate: undefined }`
 * + writes an audit row (best-effort). The engine behaves as if
 * gap-state is empty — identical to today's pre-M3-1 behavior. The
 * gap-tracker is observability-shaped, not safety-shaped: failure
 * must not block decisions.
 */
import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_SUB_OBJECTIVES_GENERIC_B2B,
  SOFT_TRIGGER_THRESHOLD,
  type PrioritizedGap,
  type ResolvedGap,
  type SubObjectiveGapState,
  type SubObjectiveSource,
  type SubObjectiveState,
  type SubObjectiveValueType,
} from '@growth/shared';
// KAN-1168 — Consolidated audit-helper migration. Previously inline copy at
// :475. Caller-side `actor` literal preserves 'system:gap-tracker' verbatim.
import { writeAuditBestEffort } from '../utils/audit-helpers.js';

// ─────────────────────────────────────────────
// Contact context the priority math needs
// ─────────────────────────────────────────────

export interface ContactStageContext {
  /** Current pipeline stage NAME — used for hard-trigger matching against
   *  SubObjectiveDefault.requiredAtStage. Pass undefined when contact has
   *  no active pipeline; engine then treats all triggers as soft-only. */
  currentStageName?: string;
  /** Next pipeline stage NAME — when contact is one step away, gaps
   *  required at that stage also hard-trigger. Optional. */
  nextStageName?: string;
}

// ─────────────────────────────────────────────
// Public entry — caller-facing
// ─────────────────────────────────────────────

/**
 * Compute the prioritized gap-state for a contact. Self-seeds defaults
 * idempotently on every call. Fail-safe to empty list on any error.
 */
export async function computeGapState(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  contact: ContactStageContext,
): Promise<SubObjectiveGapState> {
  try {
    // Step 1 — seed defaults unconditionally (self-heals partial state).
    await seedDefaultsIfMissing(prisma, tenantId, contactId);

    // Step 2 — read all rows for this contact.
    const rows = await prisma.contactSubObjectiveGapState.findMany({
      where: { tenantId, contactId },
    });

    // Step 3 — prioritize unfilled rows.
    return prioritize(rows, contact);
  } catch (err) {
    // Fail-safe — engine behaves as today, audit the failure.
    console.error(
      `[sub-objective-gap-tracker] computeGapState failed tenantId=${tenantId} contactId=${contactId}:`,
      err,
    );
    await writeAuditBestEffort(prisma, {
      tenantId,
      actor: 'system:gap-tracker',
      actionType: 'sub_objective_gap_state.read_failed',
      payload: {
        contactId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return { prioritizedGaps: [], topCandidate: undefined, resolvedGaps: [] };
  }
}

// ─────────────────────────────────────────────
// Seed — unconditional skipDuplicates createMany
// ─────────────────────────────────────────────

/**
 * Idempotent seed of the 5 default sub-objective rows for a contact.
 * UNCONDITIONAL — runs every call, relying on the UNIQUE constraint
 * (tenant_id, contact_id, sub_objective_key) to make existing rows
 * no-ops. Self-heals partial seed states (a previous call that wrote
 * 3 of 5 rows and crashed: next call backfills the missing 2).
 *
 * Audit row written per successful seed insertion (best-effort).
 */
async function seedDefaultsIfMissing(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
): Promise<void> {
  // Prisma `valueType` enum: literal union 'text'|'date'|'numeric'|'enum_value'
  // (the schema maps 'enum' → 'enum_value' because 'enum' is a reserved
  // Prisma keyword). Cast at the boundary to satisfy Prisma's strict input
  // type without widening the source-of-truth shared 'enum' constant.
  const rowsToSeed = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((def) => ({
    tenantId,
    contactId,
    subObjectiveKey: def.key,
    state: 'unknown' as const,
    valueType: (def.valueType === 'enum' ? 'enum_value' : def.valueType) as
      | 'text' | 'date' | 'numeric' | 'enum_value',
    source: 'decision_initialize' as const,
    setBy: 'system:gap-tracker',
  }));

  const result = await prisma.contactSubObjectiveGapState.createMany({
    data: rowsToSeed,
    skipDuplicates: true,
  });

  if (result.count > 0) {
    await writeAuditBestEffort(prisma, {
      tenantId,
      actor: 'system:gap-tracker',
      actionType: 'sub_objective_gap_state.seeded',
      payload: {
        contactId,
        rowsInserted: result.count,
        rowsAttempted: rowsToSeed.length,
      },
    });
  }
}

// ─────────────────────────────────────────────
// Prioritization — pure math, no DB
// ─────────────────────────────────────────────

interface GapRow {
  subObjectiveKey: string;
  state: SubObjectiveState;
  valueType: SubObjectiveValueType | 'enum_value';
  valueText: string | null;
  // M3-1c-followup — extended fields for the resolvedGaps UI rendering.
  // Optional + nullable for back-compat with existing test fixtures that
  // only pass the prioritization-relevant fields.
  valueDate?: Date | null;
  valueNumeric?: number | null;
  valueEnum?: string | null;
  source?: SubObjectiveSource | null;
  setBy?: string | null;
  setAt: Date;
}

/**
 * Returns prioritized unfilled gaps (state ∈ {unknown, partial}).
 *
 * Composite score = priorityWeight × stageWeight × recencyFactor.
 *   - priorityWeight: from definition (0..1, PRD-pinned)
 *   - stageWeight: 1.0 if hard-trigger match, 0.7 baseline (soft-only)
 *   - recencyFactor: 1.0 when never-evaluated, decays gradually for
 *     fresh gaps to prevent re-asking too soon — for MVP: 1.0 always
 *     (recency tuning deferred to learning-loop slice; the
 *     recencyDaysSinceLastEval signal is reported for observability)
 *
 * Hard-trigger: state ∈ {unknown, partial} AND requiredAtStage matches
 * contact.currentStageName OR contact.nextStageName.
 */
export function prioritize(
  rows: GapRow[],
  contact: ContactStageContext,
): SubObjectiveGapState {
  const now = Date.now();
  const byKey = new Map<string, GapRow>();
  for (const r of rows) byKey.set(r.subObjectiveKey, r);

  const prioritizedGaps: PrioritizedGap[] = [];
  const resolvedGaps: ResolvedGap[] = [];

  for (const def of DEFAULT_SUB_OBJECTIVES_GENERIC_B2B) {
    const row = byKey.get(def.key);
    // Use the row's state when seeded; treat missing row as unknown (the
    // seed should have run; this is back-compat against pre-seed reads).
    const state: SubObjectiveState = row?.state ?? 'unknown';

    // M3-1c-followup — known + not_applicable rows surface in resolvedGaps
    // for the operator UI ("what the engine has learned about this contact").
    // Engine itself ignores resolvedGaps (only consumes prioritizedGaps for
    // scoring); the additive split keeps the engine path identical.
    if (state === 'known' || state === 'not_applicable') {
      if (row) {
        // Render the single string the UI shows. For known: the typed-value
        // column matching valueType. For not_applicable: null (UI renders
        // a hyphen + "not applicable" label).
        let value: string | null = null;
        if (state === 'known' && row) {
          if (def.valueType === 'text') value = row.valueText ?? null;
          else if (def.valueType === 'date') value = row.valueDate ? new Date(row.valueDate).toISOString().slice(0, 10) : null;
          else if (def.valueType === 'numeric') value = row.valueNumeric != null ? String(row.valueNumeric) : null;
          else if (def.valueType === 'enum') value = row.valueEnum ?? null;
        }
        resolvedGaps.push({
          key: def.key,
          label: def.label,
          valueType: def.valueType,
          state,
          value,
          source: row.source ?? 'decision_initialize',
          setBy: row.setBy ?? null,
          setAt: row.setAt.toISOString(),
        });
      }
      continue;
    }

    // M3-1b — lowercase-normalize stage comparison so hard-trigger is
    // reachable regardless of tenant stage-name casing. M3-1a substrate
    // smoke caught this: PRD default-set has `requiredAtStage: 'qualified'`
    // but the PROD AxisOne stage name is `Qualified` — exact-string match
    // missed and soft-trigger fired instead. Normalization makes the
    // hard-trigger path work cross-tenant without coupling the default
    // set to any tenant's exact stage casing.
    const requiredLower = def.requiredAtStage?.toLowerCase();
    const currentLower = contact.currentStageName?.toLowerCase();
    const nextLower = contact.nextStageName?.toLowerCase();
    const stageMatch =
      requiredLower !== undefined &&
      (currentLower === requiredLower || nextLower === requiredLower);

    const hardTrigger = stageMatch;
    const stageWeight = hardTrigger ? 1.0 : 0.7;
    const recencyFactor = 1.0; // MVP — refined in learning-loop slice
    const score = def.priorityWeight * stageWeight * recencyFactor;

    const recencyDaysSinceLastEval = row?.setAt
      ? Math.floor((now - row.setAt.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    prioritizedGaps.push({
      key: def.key,
      label: def.label,
      valueType: def.valueType,
      state,
      ...(state === 'partial' && row?.valueText ? { valueIfPartial: row.valueText } : {}),
      priorityWeight: def.priorityWeight,
      ...(def.requiredAtStage ? { requiredAtStage: def.requiredAtStage } : {}),
      recencyDaysSinceLastEval,
      score,
      hardTrigger,
    });
  }

  // Sort: hardTrigger first, then descending score.
  prioritizedGaps.sort((a, b) => {
    if (a.hardTrigger !== b.hardTrigger) return a.hardTrigger ? -1 : 1;
    return b.score - a.score;
  });

  const head = prioritizedGaps[0];
  return {
    prioritizedGaps,
    resolvedGaps,
    ...(head
      ? {
          topCandidate: {
            key: head.key,
            label: head.label,
            score: head.score,
            hardTrigger: head.hardTrigger,
          },
        }
      : {}),
  };
}

// ─────────────────────────────────────────────
// Convenience — does the topCandidate qualify for soft-trigger emission?
// ─────────────────────────────────────────────

/**
 * `true` when the gap-state's topCandidate should produce a discovery
 * candidate. Hard triggers ALWAYS qualify; soft triggers qualify when
 * score ≥ SOFT_TRIGGER_THRESHOLD.
 */
export function shouldEmitDiscovery(state: SubObjectiveGapState): boolean {
  if (!state.topCandidate) return false;
  if (state.topCandidate.hardTrigger) return true;
  return state.topCandidate.score >= SOFT_TRIGGER_THRESHOLD;
}

// ─────────────────────────────────────────────
// M3-1c — operator manual transition
// ─────────────────────────────────────────────

/**
 * Operator manually transitions a sub-objective's state for a contact —
 * the fallback path when info comes from off-platform (phone call, meeting,
 * a quick contact-form note). Doctrine: this is a fallback, NOT the
 * primary fill path; engine generation + extraction (later slice) +
 * enrichment (later slice) are primary.
 *
 * Validates:
 *   - contactId belongs to tenantId (cross-tenant rejection; throws)
 *   - sub_objective_key is one of the canonical SUB_OBJECTIVE_KEYS
 *   - toState is 'known' OR 'not_applicable' (manual can't set 'unknown' —
 *     that's the initial state — or 'partial' — that's extraction-only)
 *   - For 'known': value present and matches the per-valueType shape
 *
 * Writes:
 *   - UPSERT the gap-state row with `source` (caller-threaded); setBy=actor
 *   - Best-effort audit-log row capturing prev → new transition + `wasNoOp`
 *     discriminator + (when `source==='engine'`) the engineContext fields
 *     (reasoning + confidence + decisionId + eventId)
 *
 * Returns `{ ok, previousState, wasNoOp }`.
 *
 * KAN-1042 PR A2 — engine-driven path. Locked decisions:
 *   - source: 'manual' | 'engine' threaded into the upsert + audit (replaces
 *     the pre-PR-A2 hardcoded `'manual'`). Default 'manual' preserves
 *     operator-path back-compat (single existing caller at router.ts:6630).
 *   - engineContext optional; only relevant when source==='engine'. Threads
 *     forensic context into the audit payload so the engine-driven row is
 *     queryable + walkable from `triggerDecisionId` back to the originating
 *     Decision.
 *   - wasNoOp uses STRICT-EQUAL value compare (per Phase 1 lock — coerced-
 *     equal opens edge cases on cognitive normalization that belong upstream
 *     in the engine prompt, not at the dispatcher). Audit row is written
 *     unconditionally; wasNoOp lives in the payload so duplicates are
 *     queryable (`payload->>'wasNoOp' = 'true' AND payload->>'source' =
 *     'engine'`).
 */
export async function transitionSubObjectiveState(
  prisma: PrismaClient,
  tenantId: string,
  actor: string,
  input: {
    contactId: string;
    subObjectiveKey: string;
    toState: 'known' | 'not_applicable';
    value?: string | number | null;
  },
  source: 'manual' | 'engine' = 'manual',
  engineContext?: {
    reasoning: string;
    confidence: number;
    decisionId: string | null;
    eventId: string;
  },
): Promise<{ ok: true; previousState: SubObjectiveState; wasNoOp: boolean }> {
  // Cross-tenant guard — contact MUST belong to tenant.
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, tenantId },
    select: { id: true },
  });
  if (!contact) {
    throw new Error(`contact ${input.contactId} not in tenant ${tenantId}`);
  }
  const def = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.find((d) => d.key === input.subObjectiveKey);
  if (!def) {
    throw new Error(`unknown sub_objective_key: ${input.subObjectiveKey}`);
  }
  if (input.toState === 'known' && (input.value === undefined || input.value === null || input.value === '')) {
    throw new Error('value required when toState=known');
  }
  // Resolve typed value column for state='known'; nulls for state='not_applicable'.
  const valueText = input.toState === 'known' && def.valueType === 'text' ? String(input.value) : null;
  const valueDate = input.toState === 'known' && def.valueType === 'date' && input.value
    ? new Date(String(input.value)) : null;
  const valueNumeric = input.toState === 'known' && def.valueType === 'numeric' && input.value != null
    ? Number(input.value) : null;
  const valueEnum = input.toState === 'known' && def.valueType === 'enum' ? String(input.value) : null;
  const valueTypeForDb = (def.valueType === 'enum' ? 'enum_value' : def.valueType) as
    | 'text' | 'date' | 'numeric' | 'enum_value';

  // Read previous state + value columns for audit, return, AND wasNoOp
  // compute. PR A2 widens the select beyond `state` so we can do typed
  // strict-equal comparison without a second read.
  const existing = await prisma.contactSubObjectiveGapState.findUnique({
    where: { tenantId_contactId_subObjectiveKey: { tenantId, contactId: input.contactId, subObjectiveKey: input.subObjectiveKey } },
    select: {
      state: true,
      valueText: true,
      valueDate: true,
      valueNumeric: true,
      valueEnum: true,
    },
  });
  const previousState: SubObjectiveState = existing?.state ?? 'unknown';

  // KAN-1042 PR A2 — wasNoOp strict-equal compute. State match alone is
  // sufficient for not_applicable (no value field). For known, compare the
  // freshly-computed typed column against existing per def.valueType.
  // Null on either side → wasNoOp=false (treats null→value transition as
  // meaningful). Date compared via getTime() for numeric strict-equal.
  let wasNoOp = false;
  if (previousState === input.toState) {
    if (input.toState === 'not_applicable') {
      wasNoOp = true;
    } else if (existing) {
      switch (def.valueType) {
        case 'text':
          wasNoOp = existing.valueText !== null && valueText !== null && existing.valueText === valueText;
          break;
        case 'date':
          wasNoOp =
            existing.valueDate !== null &&
            valueDate !== null &&
            existing.valueDate.getTime() === valueDate.getTime();
          break;
        case 'numeric':
          wasNoOp =
            existing.valueNumeric !== null &&
            valueNumeric !== null &&
            existing.valueNumeric === valueNumeric;
          break;
        case 'enum':
          wasNoOp = existing.valueEnum !== null && valueEnum !== null && existing.valueEnum === valueEnum;
          break;
      }
    }
  }

  await prisma.contactSubObjectiveGapState.upsert({
    where: { tenantId_contactId_subObjectiveKey: { tenantId, contactId: input.contactId, subObjectiveKey: input.subObjectiveKey } },
    create: {
      tenantId,
      contactId: input.contactId,
      subObjectiveKey: input.subObjectiveKey,
      state: input.toState,
      valueType: valueTypeForDb,
      valueText,
      valueDate,
      valueNumeric,
      valueEnum,
      source,
      setBy: actor,
    },
    update: {
      state: input.toState,
      valueText,
      valueDate,
      valueNumeric,
      valueEnum,
      source,
      setBy: actor,
      setAt: new Date(),
    },
  });

  // KAN-1042 PR A2 — audit payload extended with `wasNoOp` discriminator
  // and (when source==='engine') the engineContext forensic fields. Single
  // row per transition, source-discriminated, query-friendly via
  // `payload->>'source' = 'engine'` + `payload->>'wasNoOp' = 'true'`.
  await writeAuditBestEffort(prisma, {
    tenantId,
    actor: 'system:gap-tracker',
    actionType: 'sub_objective_gap_state.transitioned',
    payload: {
      contactId: input.contactId,
      subObjectiveKey: input.subObjectiveKey,
      previousState,
      newState: input.toState,
      actor,
      source,
      wasNoOp,
      ...(source === 'engine' && engineContext
        ? {
            brainReasoning: engineContext.reasoning,
            brainConfidence: engineContext.confidence,
            triggerDecisionId: engineContext.decisionId,
            eventId: engineContext.eventId,
          }
        : {}),
    },
  });

  return { ok: true, previousState, wasNoOp };
}

// ─────────────────────────────────────────────
// Best-effort audit-log write
// ─────────────────────────────────────────────

// KAN-1168 — inline writeAuditBestEffort deleted; consolidated into
// packages/api/src/utils/audit-helpers.ts. Callers above pass
// `actor: 'system:gap-tracker'` at each invocation.
