/**
 * KAN-1140 Phase 3 PR 6 — Per-layer confidence-trigger derivation.
 *
 * Reads the three independent confidence ordinals already on the wire:
 *   - format detection confidence (PR #304)
 *   - language detection confidence (PR #306)
 *   - Haiku extraction confidence (KAN-792 / PR #232+)
 *
 * Q1 lock: per-layer threshold — escalate if ANY layer returns 'low'.
 * Each layer's signal is independent; there is no composite-confidence
 * derivation. The forensic trail (which layer was uncertain) flows on
 * `verdict.reasons` for operator surfacing in the Recommendations queue.
 *
 * Pure function; no IO; no side effects.
 */

export type Confidence = "high" | "medium" | "low";

export interface ParseConfidenceInputs {
  formatConfidence?: Confidence;
  languageConfidence?: Confidence;
  extractionConfidence?: Confidence;
}

export interface ParseConfidenceVerdict {
  shouldEscalate: boolean;
  reasons: string[];
  breakdown: ParseConfidenceInputs;
}

export function deriveParseConfidenceVerdict(
  inputs: ParseConfidenceInputs,
): ParseConfidenceVerdict {
  const reasons: string[] = [];
  if (inputs.formatConfidence === "low") reasons.push("format detection LOW");
  if (inputs.languageConfidence === "low") reasons.push("language detection LOW");
  if (inputs.extractionConfidence === "low") reasons.push("Haiku extraction LOW");
  return {
    shouldEscalate: reasons.length > 0,
    reasons,
    breakdown: inputs,
  };
}
