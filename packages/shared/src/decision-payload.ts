/**
 * KAN-738 — canonical decision-payload shape returned by every Decision Engine
 * branch (rules-based runFreeform + agentic runAgentic + adapter runPlaybookStep).
 *
 * Lives in @growth/shared because the divergence comparison helper used by
 * shadow mode types against this shape on BOTH sides. Drift on this shape
 * would silently break divergence comparison — the helper would either compare
 * unrelated fields or skip newly-added fields.
 *
 * Conceptually adjacent to enum-drift PAIRS (`packages/shared/src/__tests__/
 * enum-drift.test.ts`): the shape is a TypeScript type so the discipline is
 * structural rather than enumerated. When extending DecisionPayload, audit
 * `computeDivergence` below — every new field that the agentic loop can
 * differ on must contribute a divergence flag, otherwise shadow-mode learning
 * misses the divergence class.
 */

export type DecisionOutcome = "EXECUTED" | "ESCALATED";

export interface DecisionAction {
  /** e.g. 'send_email', 'send_sms', 'send_meta', 'no_op'. */
  type: string;
  /** null for actions without a channel (e.g. 'no_op', 'queue_review'). */
  channel: string | null;
  /** Optional structured payload — recipient, body, template, etc. */
  payload?: Record<string, unknown>;
}

export interface DecisionPayload {
  /** e.g. 'playbook_driven', 'engagement_recovery', 'agentic_loop'. */
  strategy: string;
  action: DecisionAction;
  /** 0..1 — confidence score from the strategy/scoring stage. */
  confidence: number;
  outcome: DecisionOutcome;
  /** Human-readable summary of strategy + action + confidence + outcome. */
  reasoning: string;
}

/**
 * Bounded set of divergence flags written to AgenticShadowDecision.divergence_flags.
 *
 * Adding a new flag = audit `computeDivergence` to ensure detection logic
 * exists for it. Removing a flag = backfill plan needed (existing rows
 * reference removed flag values).
 */
export type DivergenceFlag =
  | "different_action_type"
  | "different_channel"
  | "different_target"
  | "agentic_no_op"
  | "rules_no_op"
  | "agentic_error";

export const DIVERGENCE_FLAGS: readonly DivergenceFlag[] = [
  "different_action_type",
  "different_channel",
  "different_target",
  "agentic_no_op",
  "rules_no_op",
  "agentic_error",
] as const;

/**
 * Pure function — testable without DB. Compares the rules-based and agentic
 * decisions and returns the divergence flags applicable.
 *
 * `agentic` may be null when the agentic path errored; in that case only
 * 'agentic_error' is returned (no further field-level comparison possible).
 *
 * `agenticErrored = true` always implies 'agentic_error' even if `agentic`
 * is non-null (e.g. partial failure where a payload was returned but the
 * runner flagged the run as errored).
 */
export function computeDivergence(
  rules: DecisionPayload,
  agentic: DecisionPayload | null,
  agenticErrored: boolean,
): DivergenceFlag[] {
  const flags: DivergenceFlag[] = [];

  if (agenticErrored || agentic === null) {
    flags.push("agentic_error");
    if (agentic === null) return flags;
  }

  const isNoOp = (p: DecisionPayload): boolean =>
    p.action.type === "no_op" || p.outcome === "ESCALATED";

  const rulesNoOp = isNoOp(rules);
  const agenticNoOp = isNoOp(agentic);

  if (agenticNoOp && !rulesNoOp) flags.push("agentic_no_op");
  if (rulesNoOp && !agenticNoOp) flags.push("rules_no_op");

  if (rules.action.type !== agentic.action.type) {
    flags.push("different_action_type");
  } else {
    // Same action type — check channel + target divergence.
    if (rules.action.channel !== agentic.action.channel) {
      flags.push("different_channel");
    }
    // Target = recipient/payload key differences. Cheap shallow comparison
    // on the JSON-serialized payload — false positives on key ordering are
    // acceptable (this is shadow-mode telemetry, not correctness gating).
    const rulesPayload = JSON.stringify(rules.action.payload ?? {});
    const agenticPayload = JSON.stringify(agentic.action.payload ?? {});
    if (rulesPayload !== agenticPayload) {
      flags.push("different_target");
    }
  }

  return flags;
}
