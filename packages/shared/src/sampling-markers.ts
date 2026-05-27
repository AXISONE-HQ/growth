/**
 * KAN-1005 M2-5 — Shared sampling-marker constants + DecisionSource enum.
 *
 * Lives in packages/shared (the cross-cutting package) because BOTH
 * apps/api (the sampling fork at action-decided-push.ts) AND
 * packages/api (the accept/modify guard at recommendations.ts) need
 * the canonical SAMPLED_TRIGGER_TYPE constant. Either side importing
 * from the other crosses the rootDir boundary and adds a TS6059;
 * packages/shared is the architecturally-clean shared home.
 *
 * The constants are the single canonical markers for the M2-5
 * sampled-vs-blocking distinction:
 *   - triggerType === SAMPLED_TRIGGER_TYPE     ← guard / queue filter key
 *   - severity    === SAMPLED_SEVERITY          ← UI rendering hint
 */

/**
 * Canonical marker for sampled post-hoc review entries. The single
 * source-of-truth that:
 *   - maybeEnqueueSampledReview (apps/api/src/lib/) always sets
 *   - listRecommendations filter (packages/api/src/services/) keys on
 *   - assertNotSample guard (packages/api/src/services/) keys on
 */
export const SAMPLED_TRIGGER_TYPE = 'AUTO_APPROVE_SAMPLE';

/**
 * Distinct severity for sampled entries — 'info' tier (lowest), so the
 * UI can render samples with different chrome than blocking
 * 'medium'/'high'/'critical' escalations.
 */
export const SAMPLED_SEVERITY = 'info';

/**
 * System default sample rate. Per founder OQ#4 decision 2026-05-27:
 * conservative 15% start, tunable per-tenant 0.0-1.0.
 */
export const DEFAULT_SAMPLE_RATE = 0.15;

/**
 * KAN-1005 M2-5 — DecisionSource discriminator on ActionDecidedEvent.
 * Tells the action-decided-push subscriber whether this dispatch
 * originated from an autonomous decision (sample-eligible) or a
 * human-curated/operator-approved path (skip sampling).
 *
 *   'agentic_live'      → runAgentic post-gate (M2-1..4 governance applied)  → SAMPLE
 *   'freeform'          → runFreeform/runShadow post-gate                    → SAMPLE
 *   'playbook'          → runPlaybookStep (predetermined human-curated step) → SKIP
 *   'approve_to_send'   → recommendations.accept (operator-approved)         → SKIP
 *
 * Optional on the wire (back-compat for in-flight pre-M2-5 events);
 * subscriber treats undefined as "skip sampling" — safe direction.
 */
export type DecisionSource =
  | 'agentic_live'
  | 'freeform'
  | 'playbook'
  | 'approve_to_send';

/**
 * Decision sources that ARE eligible for sampling. Pure-function helper
 * so the subscriber + tests share one definition.
 */
const SAMPLE_ELIGIBLE_SOURCES: ReadonlySet<DecisionSource> = new Set<DecisionSource>([
  'agentic_live',
  'freeform',
]);

export function isDecisionSourceSampleEligible(
  source: DecisionSource | undefined,
): boolean {
  if (source === undefined) return false; // back-compat: pre-M2-5 events skip
  return SAMPLE_ELIGIBLE_SOURCES.has(source);
}
