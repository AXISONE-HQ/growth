/**
 * KAN-793 — Default Pipeline lazy bootstrap.
 *
 * Phase 1 epic 3 of 3. See docs/prds/phase-1-deal-engagement.md §4 KAN-793 row.
 *
 * Resolves PRD Q9.4 (Option c — never drop a lead due to missing tenant
 * config): when a Track A inbound arrives for a tenant with zero Pipelines,
 * the consumer calls this helper BEFORE assignLeadToPipeline. The helper
 * lazy-creates the canonical 7-Stage "Default Sales Pipeline" so the
 * downstream assignment + Deal-write always has a real Pipeline to land on.
 *
 * Idempotent: returns the existing Pipeline when the tenant already has one
 * (any active Pipeline counts — the helper does NOT enforce uniqueness of
 * the default name, only the existence of at least one Pipeline). This
 * makes the call safe to fire on every Track A inbound without thrashing.
 *
 * Sequencing contract (KAN-793 hard invariant):
 *   1. ensureTenantHasDefaultPipeline(tenantId)  ← guarantees ≥1 Pipeline exists
 *   2. assignLeadToPipeline(prisma, contactId)   ← rules / AI / posture
 *   3. Deal write uses pipelineId/stageId from assignment.result
 *   4. DealStageHistory + Engagement writes follow in the same tx
 *
 * Stage cadences default to platform values from the PRD §4 KAN-793 7-Stage
 * table; tenants edit these later via the Onboarding Wizard (KAN-807) or the
 * Stages settings UI. Consumer of followUpCadence ships in Phase 2 KAN-796
 * (cron-driven Deal advancement).
 */
import type { Pipeline, PrismaClient } from '@prisma/client';

interface DefaultStageSpec {
  name: string;
  order: number;
  isInitial: boolean;
  isTerminal: boolean;
  outcomeType: 'open' | 'terminal_won' | 'terminal_lost';
  followUpCadence: Record<string, unknown>;
}

/**
 * Canonical 7-Stage "Default Sales Pipeline" per PRD §4 KAN-793.
 *
 * followUpCadence shape: { firstNudgeAfterHours, maxNudges, idleStaleAfterDays }
 *   - firstNudgeAfterHours: hours after enteredStageAt to fire the first
 *     follow-up signal (Phase 2 KAN-796 cron consumer)
 *   - maxNudges: cap on automated nudges before escalation
 *   - idleStaleAfterDays: days idle in this Stage before deal-stale signal
 *
 * Terminal stages get an empty cadence ({}) — no follow-ups on a closed deal.
 */
const DEFAULT_STAGES: readonly DefaultStageSpec[] = [
  {
    name: 'New',
    order: 0,
    isInitial: true,
    isTerminal: false,
    outcomeType: 'open',
    followUpCadence: { firstNudgeAfterHours: 24, maxNudges: 4, idleStaleAfterDays: 30 },
  },
  {
    name: 'Contacted',
    order: 1,
    isInitial: false,
    isTerminal: false,
    outcomeType: 'open',
    followUpCadence: { firstNudgeAfterHours: 48, maxNudges: 4, idleStaleAfterDays: 30 },
  },
  {
    name: 'Qualified',
    order: 2,
    isInitial: false,
    isTerminal: false,
    outcomeType: 'open',
    followUpCadence: { firstNudgeAfterHours: 72, maxNudges: 4, idleStaleAfterDays: 30 },
  },
  {
    name: 'Proposal Sent',
    order: 3,
    isInitial: false,
    isTerminal: false,
    outcomeType: 'open',
    followUpCadence: { firstNudgeAfterHours: 168, maxNudges: 3, idleStaleAfterDays: 30 },
  },
  {
    name: 'Negotiating',
    order: 4,
    isInitial: false,
    isTerminal: false,
    outcomeType: 'open',
    followUpCadence: { firstNudgeAfterHours: 24, maxNudges: 6, idleStaleAfterDays: 14 },
  },
  {
    name: 'Closed Won',
    order: 5,
    isInitial: false,
    isTerminal: true,
    outcomeType: 'terminal_won',
    followUpCadence: {},
  },
  {
    name: 'Closed Lost',
    order: 6,
    isInitial: false,
    isTerminal: true,
    outcomeType: 'terminal_lost',
    followUpCadence: {},
  },
];

const DEFAULT_PIPELINE_NAME = 'Default Sales Pipeline';
const DEFAULT_PIPELINE_DESCRIPTION =
  'Canonical 7-stage funnel auto-created on first inbound lead. Tenant can edit Stages, add specialized Pipelines (book_appointment / send_quote / buy_online) via Onboarding (KAN-807) or Pipelines settings.';

/**
 * Lazy-bootstrap the tenant's first Pipeline.
 *
 * Returns the existing Pipeline when the tenant already has any active
 * Pipeline; otherwise creates the canonical default Pipeline + 7 Stages
 * in a single transaction.
 *
 * Multi-Pipeline tenants: returns whichever active Pipeline the query lands
 * on first (orderBy createdAt asc — earliest wins, stable). Caller doesn't
 * inspect the return value beyond "Pipeline exists" — assignLeadToPipeline
 * is the actual router that picks among multiple Pipelines.
 *
 * Race safety: two concurrent inbounds for a fresh tenant could both see
 * "no Pipelines exist" and try to create. The Pipeline model has no
 * unique-name constraint, so the second create succeeds and produces a
 * duplicate. Acceptable for V1 — Track A real-world inbound rate is far
 * below the Cloud SQL connection contention threshold; the duplicate (if
 * it ever happens) is benign (tenant can delete one later via Pipelines
 * settings). Phase 2 KAN-794+ may add an advisory lock if this becomes
 * an operational concern.
 */
export async function ensureTenantHasDefaultPipeline(
  prisma: PrismaClient,
  tenantId: string,
): Promise<Pipeline> {
  const existing = await prisma.pipeline.findFirst({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return existing;

  return prisma.$transaction(async (tx) => {
    const pipeline = await tx.pipeline.create({
      data: {
        tenantId,
        name: DEFAULT_PIPELINE_NAME,
        description: DEFAULT_PIPELINE_DESCRIPTION,
        isActive: true,
        order: 0,
        // Default Pipeline serves the generic nurturing funnel use case.
        // Tenants needing book_appointment / send_quote / buy_online create
        // additional Pipelines via Onboarding Wizard (KAN-807).
        objectiveType: 'warm_up_lead',
        objectiveDescription:
          'Nurture inbound leads from first contact through qualification, proposal, and close.',
      },
    });

    await tx.stage.createMany({
      data: DEFAULT_STAGES.map((s) => ({
        pipelineId: pipeline.id,
        name: s.name,
        order: s.order,
        isInitial: s.isInitial,
        isTerminal: s.isTerminal,
        outcomeType: s.outcomeType,
        followUpCadence: s.followUpCadence,
      })),
    });

    return pipeline;
  });
}
