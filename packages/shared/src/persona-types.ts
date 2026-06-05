/**
 * KAN-1093 (Cluster IV-B PR I) — Persona canonical types + DEFAULT.
 *
 * Lives in @growth/shared (cross-rootDir-clean cohort) so both
 * packages/api (blueprint-persona-resolver) and apps/* (operator UI surfaces
 * for persona config — Cluster IV-A consumers when activated) consume one
 * definition. Same structural-drift discipline as engine-phase-types.ts
 * (Cluster II precedent) + engine-phase-stage-map-types.ts (Cluster III).
 *
 * Closes the Cluster II → Cluster IV bridge documented at
 * engine-phase-types.ts:46-48: "No `tone` (Cluster IV concern), no
 * `defaultActionType` (Cluster III concern). Future clusters extend
 * additively." Cluster III shipped enginePhaseStageMap; Cluster IV-B PR I
 * ships Persona.
 *
 * **Note on BrainSuggestedTone duplication (strike #3)**: this file declares
 * `BrainSuggestedTone` as a parallel literal union to the existing one at
 * `packages/api/src/services/brain-service.ts:102`. The two declarations are
 * structurally identical literal unions (TypeScript treats them as the same
 * type at assignment sites). This is the THIRD cross-rootDir type
 * duplication via lockstep parallel declaration (strikes 1+2: EnginePhaseKey
 * in Cluster II + ThreadTurn/ThreadTurnLocal in Cluster I); future
 * consolidation tracked by KAN-1097 (Phase 2.5). Both declarations MUST stay
 * in lockstep on any tone-vocab extension until KAN-1097 activates.
 * See `feedback_three_strikes_pattern_extract_to_shared_when_duplication_recurs.md`.
 */

import type { EnginePhaseKey } from './engine-phase-types.js';

/**
 * Canonical brain-suggested tone vocabulary. Lockstep-mirrored at
 * `packages/api/src/services/brain-service.ts:102`. See file-level comment
 * above for the three-strikes consolidation tracker (KAN-1097).
 *
 * Engine emits one of these in `BrainNextBestAction.suggestedTone`; the
 * persona's per-phase tone defaults below constrain to this same union for
 * type-safety across Cluster IV-A activation (composer's tone resolution
 * chain selects from this set).
 */
export type BrainSuggestedTone = 'curious' | 'professional' | 'urgent' | 'closing';

/**
 * Per-Blueprint Persona config carried in `Blueprint.persona Json?`
 * (per-vertical default) + `Tenant.personaOverride Json?` (per-tenant
 * override). Resolution via `blueprint-persona-resolver.ts`.
 *
 * Phase 1 Q2 lock — fields chosen to match the Cluster IV-A consumer needs
 * (per-phase tone in composer's tone resolution chain at PR I close;
 * persona name + voice in composer's userPrompt at PR II Phase 2):
 *
 *   - `name`: human-readable persona label (e.g., 'Generic B2B SaaS')
 *   - `voice`: free-form voice description used by composer's brand-voice
 *     prompt line (replaces existing snapshot.companyTruth.tone fallback in
 *     Cluster IV-A PR I)
 *   - `toneDefaults`: per-phase tone preferences (Partial — unset phases
 *     fall back to engine-suggested tone OR voice OR snapshot fallback)
 *   - `brandAttributes`: free-form brand-claim strings (e.g.,
 *     ['modern', 'data-driven']); used by composer to ground LLM in
 *     consistent brand voice
 *   - `voiceExamples`: free-form example message openers; few-shot prompt
 *     content for the composer in Cluster IV-A activation
 */
export interface BlueprintPersona {
  /** Human-readable persona name. */
  name: string;
  /** Free-form voice description (e.g., 'professional yet conversational'). */
  voice: string;
  /**
   * Per-phase tone preferences. `Partial<Record<>>` because each phase entry
   * is optional — unset phase falls back to engine-suggested tone (composer's
   * tone resolution chain in Cluster IV-A PR I).
   *
   * Values constrained to `BrainSuggestedTone` union — no new tone vocab.
   * Per Q5 lock: existing vocab is the canonical surface; persona just
   * picks per-phase defaults from it.
   */
  toneDefaults: Partial<Record<EnginePhaseKey, BrainSuggestedTone>>;
  /**
   * Free-form brand-claim strings. Used by composer's Cluster IV-A PR I
   * integration to ground LLM in consistent brand voice. Empty array =
   * no brand claims (composer's userPrompt drops the brand-attributes line).
   */
  brandAttributes: string[];
  /**
   * Free-form example message openers. Few-shot content for composer
   * Cluster IV-A activation. Empty array = no few-shot examples (composer
   * uses zero-shot prompt).
   */
  voiceExamples: string[];
}

/**
 * Default Persona for the Generic B2B SaaS vertical when no Blueprint or
 * Tenant override is configured.
 *
 * **Discipline-pin-1 framing**: `toneDefaults` + `brandAttributes` +
 * `voiceExamples` ship EMPTY/empty-array specifically so cognitive defaults
 * stay unopinionated. Design partners populate per-tenant during onboarding
 * (per KAN-1093 Phase 1 Q2 lock + Fred's observation #1).
 *
 * `name` + `voice` ship with non-empty generic-fallback values per Q2
 * sub-option (i) — these strings render naked in templates if empty (e.g.,
 * `Brand voice: ` with no value); non-empty generic values are unopinionated
 * fallbacks, not aesthetic positions.
 */
export const DEFAULT_PERSONA_GENERIC_B2B: BlueprintPersona = {
  name: 'Generic B2B SaaS',
  voice: 'professional yet conversational',
  toneDefaults: {},
  brandAttributes: [],
  voiceExamples: [],
};
