/**
 * KAN-1005 M2-5 — Human-review sampling (apps/api side).
 *
 * Non-blocking post-hoc spot-check of auto-approved actions. Fired from
 * the action.decided subscriber (`apps/api/src/subscribers/action-decided-push.ts`)
 * AFTER the dispatch chain processes the event — NOT from inside the
 * decision engine (mirrors the M2-4 circuit-breaker pattern: compute
 * in the app layer, engine stays focused on decision logic, no new
 * cross-rootDir import to add to the KAN-689 cohort).
 *
 * # Architecture (M2-4 pattern, founder review 2026-05-27)
 *
 * The fork lives at action-decided-push.ts post-publish. The subscriber:
 *   1. Verifies OIDC, parses the envelope (existing M2-2 flow)
 *   2. Reads `event.decision.decisionSource` discriminator (M2-5 new field)
 *   3. If source is sample-eligible (`'agentic_live'` or `'freeform'`):
 *      a. Reads per-tenant rate from `Tenant.settings.humanReviewSampling.rate`
 *      b. Decides via `shouldSample(rate)` (deterministic in tests via seam)
 *      c. On true: creates an Escalation row with the canonical sampled markers
 *   4. Continues to the existing compose + dispatch chain
 *
 * The sampling is INDEPENDENT of the dispatch — fire-and-forget with
 * .catch(). A sampling-path throw never blocks/delays/alters the
 * action being composed + dispatched downstream.
 *
 * # Why this lives in apps/api, not packages/api
 *
 * Founder mandate 2026-05-27: prior M2 PRs held 157=157 on apps/api
 * typecheck baseline (zero-new TS6059). M2-5's first cut placed the
 * module in packages/api/src/services/ — apps/api transitively pulled
 * it via the run-decision-for-contact static-import chain, adding +1
 * TS6059. The M2-4 pattern (module in apps/api/src/lib, threaded into
 * the engine as data, engine never imports) is the canonical fix.
 * Same pattern here.
 *
 * # The sampled-vs-blocking distinction (no migration)
 *
 * Canonical markers live in `@growth/shared` (SAMPLED_TRIGGER_TYPE etc.)
 * so both this module AND the queue-side guard in
 * `packages/api/src/services/recommendations.ts` can import without
 * crossing the rootDir boundary.
 *
 *   - triggerType = SAMPLED_TRIGGER_TYPE ('AUTO_APPROVE_SAMPLE')
 *   - severity    = SAMPLED_SEVERITY    ('info')
 *   - status      = 'open' → 'dismissed' (acknowledged)
 *   - context     = { sampled: true, sampleRate, autoExecutedAt, ... }
 *
 * # Rate location (no migration)
 *
 * Per-tenant `Tenant.settings.humanReviewSampling.rate` (float 0.0-1.0).
 * Fail-safe parse → DEFAULT_SAMPLE_RATE (0.15) on any malformed input;
 * never silently falls back to 0 or 1.
 *
 * # Testability seam
 *
 * `__setShouldSampleForTest(fn | null)` injects a deterministic
 * sampling decision so unit tests aren't flaky.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import {
  SAMPLED_TRIGGER_TYPE,
  SAMPLED_SEVERITY,
  DEFAULT_SAMPLE_RATE,
  isDecisionSourceSampleEligible,
  type DecisionSource,
} from '@growth/shared';

// Re-export the shared markers + helper so callers can import from one place.
export {
  SAMPLED_TRIGGER_TYPE,
  SAMPLED_SEVERITY,
  DEFAULT_SAMPLE_RATE,
  isDecisionSourceSampleEligible,
  type DecisionSource,
};

// ─────────────────────────────────────────────────────────────────────────
// Sampling decision — injectable for deterministic tests.
// ─────────────────────────────────────────────────────────────────────────

let _shouldSample: (rate: number) => boolean = (rate) => Math.random() < rate;

export function shouldSample(rate: number): boolean {
  return _shouldSample(rate);
}

export function __setShouldSampleForTest(
  fn: ((rate: number) => boolean) | null,
): void {
  _shouldSample = fn ?? ((rate: number) => Math.random() < rate);
}

// ─────────────────────────────────────────────────────────────────────────
// Rate resolution — fail-safe parse from Tenant.settings.
// ─────────────────────────────────────────────────────────────────────────

export function resolveSampleRate(tenantSettings: unknown): number {
  const settings =
    tenantSettings && typeof tenantSettings === 'object' && !Array.isArray(tenantSettings)
      ? (tenantSettings as Record<string, unknown>)
      : {};
  const samplingConfig =
    settings.humanReviewSampling &&
    typeof settings.humanReviewSampling === 'object' &&
    !Array.isArray(settings.humanReviewSampling)
      ? (settings.humanReviewSampling as Record<string, unknown>)
      : {};
  const raw = samplingConfig.rate;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SAMPLE_RATE;
  if (raw < 0 || raw > 1) return DEFAULT_SAMPLE_RATE;
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────
// The fork-point helper — call from action-decided-push.ts post-publish.
// Fire-and-forget at the call site:
//   void maybeEnqueueSampledReview(prisma, {...}).catch((err) => log + ignore);
// ─────────────────────────────────────────────────────────────────────────

export interface MaybeEnqueueSampledReviewArgs {
  tenantId: string;
  contactId: string;
  decisionId: string;
  actionType: string;
  channel: string | null;
  confidence: number;
  /** Decision source — only 'agentic_live' / 'freeform' are sample-eligible. */
  decisionSource: DecisionSource | undefined;
  /** Reasoning string surfaces in the review queue for the operator. */
  reasoning: string;
  /** Pre-resolved sample rate (from already-loaded tenant context). */
  sampleRate: number;
}

/**
 * Conditionally enqueue a sampled review entry.
 *
 * Skip conditions (early-return `{ sampled: false }`):
 *   - decisionSource not in eligible set ('agentic_live' / 'freeform')
 *   - shouldSample(rate) returns false
 *
 * On the sample path: writes ONE Escalation row with canonical markers.
 *
 * **Non-blocking**: caller MUST fire-and-forget with `void ...catch(...)`.
 * Throws (e.g. DB error) propagate to caller's .catch().
 */
export async function maybeEnqueueSampledReview(
  prisma: PrismaClient,
  args: MaybeEnqueueSampledReviewArgs,
): Promise<{ sampled: boolean; escalationId?: string; skipReason?: string }> {
  if (!isDecisionSourceSampleEligible(args.decisionSource)) {
    return {
      sampled: false,
      skipReason:
        args.decisionSource === undefined
          ? 'no_decision_source' // pre-M2-5 event, back-compat skip
          : `not_sample_eligible:${args.decisionSource}`,
    };
  }
  if (!shouldSample(args.sampleRate)) {
    return { sampled: false, skipReason: 'rng_skip' };
  }
  const created = await prisma.escalation.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      decisionId: args.decisionId,
      triggerType: SAMPLED_TRIGGER_TYPE,
      triggerReason: `Auto-approved action sampled for post-hoc human review (rate=${args.sampleRate})`,
      severity: SAMPLED_SEVERITY,
      aiSuggestion: `${args.actionType}${args.channel ? ` via ${args.channel}` : ''}`,
      status: 'open',
      context: {
        sampled: true,
        sampleRate: args.sampleRate,
        autoExecutedAt: new Date().toISOString(),
        confidence: args.confidence,
        decisionSource: args.decisionSource,
        reasoning: args.reasoning,
      } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { sampled: true, escalationId: created.id };
}
