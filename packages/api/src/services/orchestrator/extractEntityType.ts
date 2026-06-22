/**
 * KAN-1219 Slice G1 — entityType extraction helper.
 *
 * Substrate for the orchestrator's 5-dimension extraction flow (G3 wires
 * this into `handleChatTurn`). Classifies the operator's utterance as
 * `product` or `vehicle` so the downstream entity-resolution step knows
 * which catalog to read.
 *
 * # SPO Q1 lock
 *
 * entityType is the FIRST dimension extracted — see `DIMENSION_ORDER` in
 * `packages/shared/src/conversation-types.ts`. Operator sees an explicit
 * branch decision before the orchestrator commits to a product- or
 * vehicle-specific extraction prompt. Memo 19/42 affordance-honesty.
 *
 * # Memo 39 codebase-precedent
 *
 * Mirrors the `dimensionValueExample('entityType')` contract in
 * `conversational-orchestrator.ts` — LLM emits a raw string `"product"` or
 * `"vehicle"`, OR returns `kind: "clarification"` for ambiguous utterances.
 * This module wraps that pattern as a standalone helper that G3 calls from
 * the orchestrator state machine.
 */
import {
  CampaignTargetEntityTypeEnum,
  type CampaignTargetEntityType,
} from "@growth/shared";

export type EntityTypeExtractionResult =
  | { kind: "extracted"; entityType: CampaignTargetEntityType; confidence: "high" | "medium" | "low" }
  | { kind: "clarification"; aiMessage: string };

/**
 * Normalize raw LLM extraction output into a discriminated result the
 * orchestrator state machine can consume. The input shape mirrors what
 * `parseDimensionExtraction()` already returns from the canonical LLM
 * envelope; this helper specifically interprets `value` as a
 * CampaignTargetEntityType discriminator.
 */
export function normalizeEntityTypeExtraction(
  parsed:
    | { kind: "extracted"; value: unknown; confidence: "high" | "medium" | "low"; aiMessage: string }
    | { kind: "clarification"; aiMessage: string },
): EntityTypeExtractionResult {
  if (parsed.kind === "clarification") {
    return { kind: "clarification", aiMessage: parsed.aiMessage };
  }

  const raw = typeof parsed.value === "string" ? parsed.value.trim().toLowerCase() : "";
  const enumParse = CampaignTargetEntityTypeEnum.safeParse(raw);
  if (!enumParse.success) {
    // LLM emitted something we can't map (e.g. "service", "subscription",
    // "auto", "" empty). Defer to clarification rather than guessing.
    return {
      kind: "clarification",
      aiMessage:
        parsed.aiMessage ||
        "Is this campaign about a product in your catalog, or a vehicle from your dealer inventory?",
    };
  }

  return {
    kind: "extracted",
    entityType: enumParse.data,
    confidence: parsed.confidence,
  };
}

/**
 * Heuristic pre-filter — short-circuit cheap classifications before paying
 * for an LLM round-trip. Returns null when the utterance is ambiguous and
 * we should delegate to the LLM extraction path.
 *
 * Vehicle signals: VIN-shaped tokens (17 alnum chars), explicit body-style
 * words ("SUV", "sedan", "truck", "minivan"), year+make patterns.
 * Product signals: "subscription", "SKU", "catalog", explicit product
 * keyword.
 *
 * Used by `selectTier()` in the orchestrator (G3) to route cheap-tier
 * classifications without burning reasoning-tier budget.
 */
export function heuristicEntityType(
  message: string,
): CampaignTargetEntityType | null {
  // Pad with spaces so word-boundary matching catches first/last tokens
  // without requiring trailing-space variants of every keyword.
  const padded = ` ${message.toLowerCase()} `;

  // Strong vehicle signals — word-boundary matched to avoid e.g.
  // "subscription" matching "sub" or "production" matching "product".
  const vehicleKeywords = [
    " suv ",
    " suvs ",
    " sedan ",
    " sedans ",
    " truck ",
    " trucks ",
    " minivan ",
    " coupe ",
    " convertible ",
    " hatchback ",
    " vehicle ",
    " vehicles ",
    " car ",
    " cars ",
    " vin ",
    " dealer ",
    " inventory ",
    " trade-in ",
  ];
  for (const kw of vehicleKeywords) {
    if (padded.includes(kw)) return "vehicle";
  }
  // VIN-shaped token (17 alnum excl. I/O/Q per ISO 3779).
  if (/\b[a-hj-npr-z0-9]{17}\b/i.test(message)) return "vehicle";

  // Strong product signals.
  const productKeywords = [
    " subscription ",
    " subscriptions ",
    " sku ",
    " skus ",
    " catalog ",
    " plan ",
    " plans ",
    " tier ",
    " tiers ",
    " license ",
    " licenses ",
    " seat ",
    " seats ",
  ];
  for (const kw of productKeywords) {
    if (padded.includes(kw)) return "product";
  }

  return null;
}
