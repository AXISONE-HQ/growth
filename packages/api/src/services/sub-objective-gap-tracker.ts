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
  type SubObjectiveGapState,
  type SubObjectiveState,
  type SubObjectiveValueType,
} from '@growth/shared';

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
    await writeAuditBestEffort(prisma, tenantId, 'sub_objective_gap_state.read_failed', {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { prioritizedGaps: [], topCandidate: undefined };
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
    await writeAuditBestEffort(prisma, tenantId, 'sub_objective_gap_state.seeded', {
      contactId,
      rowsInserted: result.count,
      rowsAttempted: rowsToSeed.length,
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

  for (const def of DEFAULT_SUB_OBJECTIVES_GENERIC_B2B) {
    const row = byKey.get(def.key);
    // Use the row's state when seeded; treat missing row as unknown (the
    // seed should have run; this is back-compat against pre-seed reads).
    const state: SubObjectiveState = row?.state ?? 'unknown';

    // Only unfilled gaps compete.
    if (state === 'known' || state === 'not_applicable') continue;

    const stageMatch =
      def.requiredAtStage !== undefined &&
      (contact.currentStageName === def.requiredAtStage ||
        contact.nextStageName === def.requiredAtStage);

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
// Best-effort audit-log write
// ─────────────────────────────────────────────

async function writeAuditBestEffort(
  prisma: PrismaClient,
  tenantId: string,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'system:gap-tracker',
        actionType,
        payload: payload as never,
      },
    });
  } catch (err) {
    // Audit failure is never load-bearing.
    console.error(`[sub-objective-gap-tracker] audit write failed for ${actionType}:`, err);
  }
}
