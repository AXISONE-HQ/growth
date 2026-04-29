/**
 * KAN-740 — Sprint 3 / S3.3 — canonical action emission enum.
 *
 * The LLM's final agentic decision must pick one of these action types. The
 * runner validates `agenticPayload.action.actionType` against this enum at
 * the dispatch boundary; unknown actionType → escalation, action.decided
 * NOT emitted (LLM hallucinated outside the enum).
 *
 * **Vocabulary scope:** transport-level (channel-bearing actions + no_op +
 * escalate). Matches the existing rules-based emission path's canonical
 * set in run-decision-for-contact.ts:runPlaybookStep where
 * `channelToAction = { email: 'send_email', sms: 'send_sms', meta: 'send_meta' }`.
 *
 * **NOT a Prisma enum.** `Action.actionType` and `Decision.actionType` columns
 * in schema.prisma are plain `String`, not Postgres enums. So the
 * enum-drift PAIRS list in `packages/shared/src/__tests__/enum-drift.test.ts`
 * does NOT apply — there's no Prisma side to drift against. Drift on this
 * enum would only matter on the LLM ↔ runner ↔ action.decided contract
 * (runtime validation in `agentic-decision-runner.ts`).
 *
 * **Adjacent vocabulary — `AutoApproveActionType`** (in threshold-gate.ts):
 * 9 specialized business-intent values like `send_warm_up_email` /
 * `send_quote`. That set is at a DIFFERENT abstraction level (semantic
 * intent) than this transport-level set. KAN-749 (filed at PR open) tracks
 * the symmetry gap — both vocabularies need to be reconcilable so the
 * auto-approve matrix can fire on agentic + rules-based emission paths.
 */

export const ACTION_TYPES = [
  "send_email",
  "send_sms",
  "send_meta",
  "no_op",
  "escalate",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

const ACTION_TYPE_SET: ReadonlySet<string> = new Set(ACTION_TYPES);

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && ACTION_TYPE_SET.has(value);
}

/**
 * Reason emitted when the LLM returns an action type outside the canonical
 * enum. Routed to escalation with this string in the Decision.reasoning so
 * humans can see what the agent tried to do.
 */
export const HALLUCINATED_ACTION_REASON = "agentic_hallucinated_action_type";
