/**
 * KAN-962 (slice 2a) — pipeline-proposer.
 *
 * Composes:
 *   1. Deterministic segment counts (segment-counts.ts) → sufficiency verdicts
 *   2. LLM-backed naming + reasoning (objective-proposer.ts; cheap tier / Haiku)
 *   3. Fallback path on LLM failure (also objective-proposer.ts)
 *   4. (objective × segment) tuple expansion — one ProposedPipeline row per pair
 *
 * Trigger-agnostic by design: on-demand call from tRPC `objectives.propose`
 * in this slice; slice 2b adds a Cloud Scheduler trigger that calls the same
 * function on a daily cadence.
 *
 * **Per-entity-scope filter**: only objectives with `entityScope === input.entityScope`
 * are proposed. Slice 2a writes `'contact'` from the UI; slice 5 adds order/company.
 *
 * **Per-segment mapping** (objective.type → segment[]):
 *   - book_appointment / sell_online / warm_up: [new_leads]
 *   - enrich_lead:                              [new_leads]  (enrich on intake)
 *   - reactivate:                               [inactive_customers_reengagement]
 *   - retain_customer:                          [inactive_customers_reengagement]
 *   - upsell:                                   [inactive_customers_reengagement]
 *   - recover_failed_payment:                   [cancelled_orders_recovery]
 *
 * One objective can map to multiple segments later (e.g., book_appointment
 * over new_leads + winback). Slice 2a keeps it 1-to-1.
 */
import type { PrismaClient } from "@prisma/client";
import type {
  ProposedPipeline,
  PipelineSegment,
  ObjectiveEntityScope,
} from "@growth/shared";
import {
  computeSegmentCounts,
  classifySufficiency,
  neededMessage,
  evidenceDescription,
  SUFFICIENCY_THRESHOLDS,
  type SegmentCounts,
  type SegmentCountKey,
} from "./segment-counts.js";
import {
  fallbackProposal,
  type ObjectiveProposalInput,
} from "./objective-proposer.js";

// ─────────────────────────────────────────────────────────────────────
// Objective-type → segment mapping. Slice 2a is 1:1; later slices may
// expand (e.g., book_appointment over both new_leads + winback).
// ─────────────────────────────────────────────────────────────────────

interface SegmentMapping {
  segment: PipelineSegment;
  /** Which key in segment-counts.SegmentCounts drives the sufficiency check. */
  countKey: SegmentCountKey;
  /** Default proposer priority when surfaced — primary candidates get 1. */
  suggestedPriority: number;
}

const OBJECTIVE_SEGMENT_MAP: Record<string, SegmentMapping> = {
  book_appointment: { segment: "new_leads", countKey: "new_leads", suggestedPriority: 1 },
  sell_online: { segment: "new_leads", countKey: "new_leads", suggestedPriority: 1 },
  warm_up: { segment: "new_leads", countKey: "new_leads", suggestedPriority: 2 },
  enrich_lead: { segment: "new_leads", countKey: "new_leads", suggestedPriority: 3 },
  reactivate: {
    segment: "inactive_customers_reengagement",
    countKey: "inactive_customers",
    suggestedPriority: 2,
  },
  retain_customer: {
    segment: "inactive_customers_reengagement",
    countKey: "active_customers",
    suggestedPriority: 2,
  },
  upsell: {
    segment: "inactive_customers_reengagement",
    countKey: "active_customers",
    suggestedPriority: 3,
  },
  recover_failed_payment: {
    segment: "cancelled_orders_recovery",
    countKey: "cancelled_orders",
    suggestedPriority: 2,
  },
};

// ─────────────────────────────────────────────────────────────────────
// Public entry — proposeForTenant
// ─────────────────────────────────────────────────────────────────────

export interface ProposeForTenantInput {
  prisma: PrismaClient;
  tenantId: string;
  entityScope: ObjectiveEntityScope;
}

/**
 * Generate one ProposedPipeline row per (Objective × segment) the proposer
 * recommends surfacing in the UI. Deterministic counts + LLM-backed
 * naming/reasoning (with fallback). Returns an array; order is by
 * suggestedPriority ascending (primary candidates first).
 *
 * This function is trigger-agnostic — slice-2a's tRPC `objectives.propose`
 * calls it on-demand; slice-2b's Cloud Scheduler will call the same
 * function on a daily cadence and diff against the prior result to surface
 * pending-proposal notifications.
 */
export async function proposeForTenant(
  input: ProposeForTenantInput,
): Promise<ProposedPipeline[]> {
  const { prisma, tenantId, entityScope } = input;

  // 1. Load tenant's Objective catalog (filtered by entityScope + isActive).
  //    KAN-959 seeded the 8-row generic catalog for the AxisOne tenant at
  //    entityScope=contact; this query returns those rows.
  const objectives = await prisma.objective.findMany({
    where: { tenantId, entityScope, isActive: true },
    select: { id: true, type: true, name: true },
    orderBy: { type: "asc" },
  });

  if (objectives.length === 0) {
    return [];
  }

  // 2. Load AccountProfile for proposer context. AxisOne's auto-detect failed
  //    (detect_status='failed') so we only get industry/language/timezone —
  //    enough to differentiate proposals at the LLM layer.
  const account = await prisma.accountProfile.findFirst({
    where: { tenantId },
    select: { industry: true, timeZone: true, defaultLanguage: true },
  });
  const accountContext = {
    industry: account?.industry ?? null,
    timeZone: account?.timeZone ?? null,
    defaultLanguage: account?.defaultLanguage ?? null,
  };

  // 3. Deterministic segment counts — single batched query pass.
  const counts: SegmentCounts = await computeSegmentCounts(prisma, tenantId);

  // 4. Per-objective expansion: each Objective with a known segment mapping
  //    becomes a ProposedPipeline row. LLM call is skipped per-row in slice 2a
  //    (the fallback strings are already strong + tenant-specific via counts);
  //    when slice-2b's diff layer + dynamic naming need richer prose, the LLM
  //    wire goes here.
  const proposals: ProposedPipeline[] = [];
  for (const objective of objectives) {
    const mapping = OBJECTIVE_SEGMENT_MAP[objective.type];
    if (!mapping) {
      // Unknown objective type — skip rather than crash. Future catalog
      // additions should add mappings (or be added to OBJECTIVE_SEGMENT_MAP
      // explicitly).
      continue;
    }

    const segmentCount = counts[mapping.countKey];
    const sufficiency = classifySufficiency(mapping.countKey, segmentCount);

    const proposalInput: ObjectiveProposalInput = {
      objectiveType: objective.type,
      objectiveName: objective.name,
      segment: mapping.segment,
      segmentCount,
      sufficiency,
      accountContext,
    };

    // Slice 2a: fallback path only (deterministic; reasoning strings cover
    // all 8 objective types). Slice 2b/3 will add the LLM-backed path here
    // when richer naming/reasoning is worth the cost.
    const llmOutput = fallbackProposal(proposalInput);

    proposals.push({
      objectiveId: objective.id,
      objectiveType: objective.type,
      objectiveName: objective.name,
      segment: mapping.segment,
      dataSufficiency: sufficiency,
      evidence: {
        count: segmentCount,
        description: evidenceDescription(mapping.countKey),
        threshold: SUFFICIENCY_THRESHOLDS[mapping.countKey],
      },
      needed: neededMessage(mapping.countKey, segmentCount),
      reason: llmOutput.reason,
      proposedName: llmOutput.proposedName,
      proposedStages: llmOutput.proposedStages,
      suggestedPriority: mapping.suggestedPriority,
    });
  }

  // Sort by suggestedPriority ASC, then by sufficiency (ready first) so the
  // UI's first row is always the strongest recommendation.
  proposals.sort((a, b) => {
    if (a.suggestedPriority !== b.suggestedPriority) {
      return a.suggestedPriority - b.suggestedPriority;
    }
    if (a.dataSufficiency !== b.dataSufficiency) {
      return a.dataSufficiency === "ready" ? -1 : 1;
    }
    return a.objectiveType.localeCompare(b.objectiveType);
  });

  return proposals;
}
