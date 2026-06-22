/**
 * KAN-1219 Slice G1 — Vehicle target extraction helper.
 *
 * Substrate for the orchestrator's vehicle-dimension extraction (G3 wires
 * this into `handleChatTurn` when `state.entityType.value === 'vehicle'`).
 * Mirrors the `dimensionValueExample('product')` extraction shape but
 * targets Vehicle inventory (KAN-1211): year / make / model / trim /
 * bodyStyle / condition / price-range. The actual VIN→Vehicle resolution
 * (LLM picks specific VINs from the tenant's live inventory) happens at
 * confirm time in G3.
 *
 * # SPO Q2 lock — lazy-load entity metadata
 *
 * This helper only captures the OPERATOR'S DESCRIPTIVE INTENT (e.g. "the
 * 2023 Camry under $25k"). The actual Vehicle.id resolution + metadata
 * fetch (name, photos, dealer-lot location) lands at send-time, NOT
 * persisted into Campaign.proposedPlan snapshots. Vehicle prices and
 * inventory change daily; lazy-load avoids stale-data sends.
 *
 * # SPO Q5 lock — specific VINs at confirm
 *
 * The output shape carries an optional `vinHints: string[]` for when the
 * operator says "campaign for VIN 1HG... and VIN 5N1...". G3 will match
 * vinHints against live inventory + populate Campaign.targetEntityIds at
 * confirm. Vehicles with `removedAt` set are skipped at send-time
 * (operator sees the honest skipped count; campaign does NOT auto-pause).
 *
 * # Memo 39 codebase-precedent
 *
 * VIN regex mirrors `apps/api/src/lib/drivegood-mapper.ts:194` (ISO 3779).
 * Body-style enum aligns with `packages/shared/src/vehicles.ts` BODY_STYLES.
 */
import { z } from "zod";

// ─────────────────────────────────────────────
// Vehicle dimension value contract
// ─────────────────────────────────────────────

/**
 * Operator's descriptive intent for the campaign's vehicle target. All
 * fields optional — the LLM extracts whatever the operator has expressed;
 * G3 resolves the descriptive intent against live inventory at confirm.
 *
 * Use case examples:
 *   "all 2023 SUVs"               → { year: 2023, bodyStyle: 'suv' }
 *   "VIN 1HG... and VIN 5N1..."    → { vinHints: ['1HG...', '5N1...'] }
 *   "Hondas under $20k"            → { make: 'Honda', priceMax: 20000 }
 *   "the 4 trucks we just took on" → { bodyStyle: 'truck', maxCount: 4 }
 */
export const VehicleDimensionValueSchema = z.object({
  year: z.number().int().min(1900).max(2100).optional(),
  make: z.string().min(1).max(60).optional(),
  model: z.string().min(1).max(60).optional(),
  trim: z.string().min(1).max(60).optional(),
  bodyStyle: z
    .enum([
      "suv",
      "sedan",
      "truck",
      "hatchback",
      "coupe",
      "convertible",
      "minivan",
      "van",
      "wagon",
    ])
    .optional(),
  condition: z.enum(["new", "used", "cpo"]).optional(),
  priceMin: z.number().nonnegative().optional(),
  priceMax: z.number().nonnegative().optional(),
  /**
   * Specific VINs the operator referenced. ISO 3779 — 17 alphanumeric
   * excluding I, O, Q. G3 validates each against live inventory + drops
   * unknown VINs with operator-facing clarification.
   */
  vinHints: z
    .array(z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/i))
    .max(50)
    .optional(),
  /**
   * Operator may cap the campaign reach explicitly ("the 4 SUVs"). G3
   * uses this as an upper bound when materializing target VINs from a
   * descriptive query.
   */
  maxCount: z.number().int().min(1).max(500).optional(),
});
export type VehicleDimensionValue = z.infer<typeof VehicleDimensionValueSchema>;

// ─────────────────────────────────────────────
// LLM output normalization
// ─────────────────────────────────────────────

/**
 * Maps the canonical orchestrator extraction envelope into a validated
 * VehicleDimensionValue, with graceful fallback to clarification when the
 * LLM emits a shape we can't recognize. Field-name aliasing is generous
 * per KAN-1203 doctrine (e.g. LLM emits `year_min` vs `priceMin`).
 */
export function normalizeVehicleExtraction(
  parsed:
    | { kind: "extracted"; value: unknown; confidence: "high" | "medium" | "low"; aiMessage: string }
    | { kind: "clarification"; aiMessage: string },
):
  | { kind: "extracted"; value: VehicleDimensionValue; confidence: "high" | "medium" | "low" }
  | { kind: "clarification"; aiMessage: string } {
  if (parsed.kind === "clarification") {
    return { kind: "clarification", aiMessage: parsed.aiMessage };
  }
  if (parsed.value == null || typeof parsed.value !== "object") {
    return {
      kind: "clarification",
      aiMessage:
        parsed.aiMessage ||
        "Which vehicles should this campaign target? Year, make, model, or specific VIN?",
    };
  }
  const raw = parsed.value as Record<string, unknown>;

  // Field-name aliases — accept the canonical names + a few common LLM
  // variations the prompt examples might not perfectly fix.
  const normalized: Record<string, unknown> = {};
  if (typeof raw.year === "number") normalized.year = raw.year;
  if (typeof raw.make === "string") normalized.make = raw.make.trim();
  if (typeof raw.model === "string") normalized.model = raw.model.trim();
  if (typeof raw.trim === "string") normalized.trim = (raw.trim as string).trim();
  if (typeof raw.bodyStyle === "string")
    normalized.bodyStyle = (raw.bodyStyle as string).toLowerCase().trim();
  if (typeof raw.body_style === "string")
    normalized.bodyStyle = (raw.body_style as string).toLowerCase().trim();
  if (typeof raw.condition === "string")
    normalized.condition = (raw.condition as string).toLowerCase().trim();
  if (typeof raw.priceMin === "number") normalized.priceMin = raw.priceMin;
  if (typeof raw.price_min === "number") normalized.priceMin = raw.price_min;
  if (typeof raw.priceMax === "number") normalized.priceMax = raw.priceMax;
  if (typeof raw.price_max === "number") normalized.priceMax = raw.price_max;
  if (Array.isArray(raw.vinHints))
    normalized.vinHints = (raw.vinHints as unknown[]).filter(
      (v): v is string => typeof v === "string",
    );
  if (Array.isArray(raw.vins))
    normalized.vinHints = (raw.vins as unknown[]).filter(
      (v): v is string => typeof v === "string",
    );
  if (typeof raw.maxCount === "number") normalized.maxCount = raw.maxCount;
  if (typeof raw.max_count === "number") normalized.maxCount = raw.max_count;

  const result = VehicleDimensionValueSchema.safeParse(normalized);
  if (!result.success) {
    return {
      kind: "clarification",
      aiMessage:
        parsed.aiMessage ||
        "I couldn't parse those vehicle criteria. Could you clarify year, make, model, or VIN?",
    };
  }

  // Empty extraction = no useful intent surfaced. Treat as clarification.
  if (Object.keys(result.data).length === 0) {
    return {
      kind: "clarification",
      aiMessage:
        parsed.aiMessage ||
        "Which vehicles should this campaign target? Year, make, model, or specific VIN?",
    };
  }

  return {
    kind: "extracted",
    value: result.data,
    confidence: parsed.confidence,
  };
}

/**
 * Concrete JSON shape example for the LLM prompt — mirrors the
 * `dimensionValueExample()` pattern in `conversational-orchestrator.ts`.
 * G3 will wire this into `buildExtractionPrompt()` when the active
 * dimension is the vehicle dimension (gated by `state.entityType.value`).
 */
export const VEHICLE_DIMENSION_PROMPT_EXAMPLE = `Return value as a JSON OBJECT with whichever of these fields the operator referenced:
  {
    "year": <number>,
    "make": "<string>",
    "model": "<string>",
    "trim": "<string>",
    "bodyStyle": "suv" | "sedan" | "truck" | "hatchback" | "coupe" | "convertible" | "minivan" | "van" | "wagon",
    "condition": "new" | "used" | "cpo",
    "priceMin": <number>,
    "priceMax": <number>,
    "vinHints": ["<17-char VIN>", ...],
    "maxCount": <number>
  }

Omit fields the operator didn't mention. Examples:

For "all 2023 SUVs we have":
  "value": { "year": 2023, "bodyStyle": "suv" }

For "the 4 trucks we just took on trade":
  "value": { "bodyStyle": "truck", "maxCount": 4 }

For "VIN 1HGCM82633A123456":
  "value": { "vinHints": ["1HGCM82633A123456"] }

For "Hondas under $20k":
  "value": { "make": "Honda", "priceMax": 20000 }`;
