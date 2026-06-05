/**
 * KAN-1094 (Cluster IV-B PR II) — Scenario tuple registry types + DEFAULT.
 *
 * Lives in @growth/shared (cross-rootDir-clean cohort) so packages/api
 * (scenario-resolver + composer integration) and apps/* (operator UI when
 * Cluster IV-A activates) consume one definition.
 *
 * Scenario tuple = `(persona × actionType × phase × trigger)`. Each matched
 * tuple injects a promptBlock into the composer's userPrompt — concrete
 * structural guidance for the LLM (e.g., "lead with curious question",
 * "mirror their language"). When no scenario matches, composer falls back
 * to the current free-form path (sparse-data discipline pin from epic).
 *
 * **v1 scope** (Phase 1 Q5 + Q4 locks): 8 canonical scenarios cover
 * `send_follow_up × {qualify/problem/proof/closing} × {initial_inbound, reply}`.
 * Other tuples — including `operator_initiated` + `no_touch_followup`
 * triggers, or `transition_sub_objective` / `advance_engine_phase` /
 * `escalate_to_human` action types — resolve to null and fall through to
 * the existing composer path. Registry expands as design partners exercise
 * those paths post-launch.
 *
 * **Q2 (ii) lock**: PROOF-phase scenarios reference "concrete proof point"
 * generically — NOT "case studies" — because the KAN-828 knowledge corpus
 * is 99.2% empty per Cluster IV Phase 1 Q6 empirical finding. When KAN-1095
 * activates (corpus seeded), scenarios can tighten to specifically
 * reference case studies. Until then: generic phrasing prevents
 * hallucination pressure.
 */

import type { EnginePhaseKey } from './engine-phase-types.js';

/**
 * Canonical Scenario trigger vocabulary. Phase 1 Q4 lock — 4 values.
 *
 * - `initial_inbound`: contact wrote first; we haven't sent an outbound yet
 *   (empirical derivation: `email_received` count > 0 AND `email_send` count
 *   == 0 for this contact). First-touch outreach.
 * - `reply`: contact replied to our prior outbound (multi-turn conversation
 *   continuing). Empirical: `email_send` > 0 AND `email_received` > 0.
 * - `operator_initiated`: operator clicked "Accept" on engine-proposed
 *   action via recommendations UI. Deferred to v2 (no derivation path
 *   wired in v1 — resolver returns null for this trigger; composer falls
 *   back to free-form path).
 * - `no_touch_followup`: engine emits send_follow_up with zero recent
 *   inbound + no operator trigger (stale-deal nudge). Deferred to v2 —
 *   same null-fallthrough behavior as operator_initiated.
 */
export type ScenarioTrigger =
  | 'initial_inbound'
  | 'reply'
  | 'operator_initiated'
  | 'no_touch_followup';

/**
 * Scenario tuple. Matched against a context derived at the composer call
 * site (action-decided-push.ts:279 — composer integration point per
 * Cluster IV-B PR II Phase 1 Anchor 1 correction).
 *
 * - `persona`: matches BlueprintPersona.name (from KAN-1093 IV-B PR I)
 * - `actionType`: BrainActionType (already shipped; PR II only registers
 *   send_follow_up scenarios in v1)
 * - `phase`: EnginePhaseKey OR null for phase-agnostic fallback. v1 keeps
 *   to exact-match only (8-scenario grid); phase=null scenarios are
 *   scaffolded for post-launch expansion when registry grows beyond 8.
 * - `trigger`: ScenarioTrigger; v1 populates only initial_inbound + reply
 *   per discipline pin 2
 * - `promptBlock`: structural guidance injected into composer userPrompt
 *   (~50-90 tokens per block; ×1.3 multiplier yields ~100-tok actual)
 */
export interface Scenario {
  persona: string;
  actionType: string; // BrainActionType — duck-typed string to avoid Cluster III strike #3 duplication
  phase: EnginePhaseKey | null;
  trigger: ScenarioTrigger;
  promptBlock: string;
}

/**
 * Default Scenario registry for the Generic B2B SaaS vertical. 8 canonical
 * tuples per Phase 1 Q5 lock — `send_follow_up × {4 phases} × {2 triggers}`.
 *
 * Q2 (ii) lock applied to PROOF scenarios: generic "concrete proof point"
 * phrasing instead of specific "case study" references — see file-level
 * comment for KAN-828 corpus-empty rationale.
 *
 * Per the operator-judged smoke criteria locked at PR II Phase 1:
 * - 🟢 GREEN: composed message INCLUDES content/phrasing visibly aligned
 *   with the matched scenario's promptBlock (structural alignment check,
 *   NOT aesthetic judgment)
 * - 🟡 YELLOW: composed INCLUDES some alignment but partial
 * - 🔴 RED: composed INDISTINGUISHABLE from current free-form OR
 *   contradicts the promptBlock guidance
 */
export const DEFAULT_SCENARIOS_GENERIC_B2B: ReadonlyArray<Scenario> = [
  // ─── QUALIFY phase ──────────────────────────────────────────────────
  {
    persona: 'Generic B2B SaaS',
    actionType: 'send_follow_up',
    phase: 'qualify',
    trigger: 'initial_inbound',
    promptBlock:
      'Scenario: contact wrote in first. Lead with a CURIOUS open-ended question that acknowledges their inquiry specifically (cite the topic they raised). Goal: open conversation + invite them to share more about their situation. DO NOT pitch the product yet.',
  },
  {
    persona: 'Generic B2B SaaS',
    actionType: 'send_follow_up',
    phase: 'qualify',
    trigger: 'reply',
    promptBlock:
      'Scenario: contact replied with new context. Acknowledge the specific signal they shared, then ask ONE follow-up question that pushes toward an unfilled BANT gap. Stay warm and curious; do not interrogate.',
  },
  // ─── PROBLEM phase ──────────────────────────────────────────────────
  {
    persona: 'Generic B2B SaaS',
    actionType: 'send_follow_up',
    phase: 'problem',
    trigger: 'initial_inbound',
    promptBlock:
      'Scenario: contact wrote in describing a pain. Mirror their language for the problem, name a specific consequence of leaving it unsolved, then propose a clarifying question that surfaces decision criteria.',
  },
  {
    persona: 'Generic B2B SaaS',
    actionType: 'send_follow_up',
    phase: 'problem',
    trigger: 'reply',
    promptBlock:
      'Scenario: contact replied with more problem context. Reflect the deeper understanding, name a sharper consequence, and propose a diagnostic question or a hypothesis they can validate.',
  },
  // ─── PROOF phase (Q2 (ii) — generic proof-point phrasing) ───────────
  {
    persona: 'Generic B2B SaaS',
    actionType: 'send_follow_up',
    phase: 'proof',
    trigger: 'initial_inbound',
    promptBlock:
      'Scenario: contact wrote in showing buying signals. Lead with a concrete proof point (specific data or evidence), tied to a specific outcome they care about. Close with a CTA toward decision (demo, trial, conversation).',
  },
  {
    persona: 'Generic B2B SaaS',
    actionType: 'send_follow_up',
    phase: 'proof',
    trigger: 'reply',
    promptBlock:
      'Scenario: contact replied to your proof outreach. Acknowledge their specific question or pushback, address it with one more concrete proof point, and reiterate the CTA toward decision.',
  },
  // ─── CLOSING phase ──────────────────────────────────────────────────
  {
    persona: 'Generic B2B SaaS',
    actionType: 'send_follow_up',
    phase: 'closing',
    trigger: 'initial_inbound',
    promptBlock:
      'Scenario: contact wrote in ready to move. Be DECISIVE and assumptive about next steps. Propose a specific next action (meeting time, contract review, kickoff) with concrete dates/details.',
  },
  {
    persona: 'Generic B2B SaaS',
    actionType: 'send_follow_up',
    phase: 'closing',
    trigger: 'reply',
    promptBlock:
      'Scenario: contact replied during deal close. Confirm the specific decision they signaled, propose the exact next step (meeting/contract/kickoff), and remove friction (offer to draft, schedule, coordinate).',
  },
];
