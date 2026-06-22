/**
 * KAN-1219 Slice G1 — Campaign polymorphic target Zod schema.
 *
 * Replaces the single-product `goalProductId` soft pointer with a
 * discriminated (entityType, ids[]) pair. Campaigns can now target either:
 *   - 'product'  → Product entity (KAN-1212 substrate; currently dormant)
 *   - 'vehicle'  → Vehicle entity (KAN-1211 live; 4mkauto daily sync)
 *
 * # SPO 5-decision locks (G1 Phase 1)
 *
 * - Q1 — entityType is a 5th INDEPENDENT conversation dimension extracted
 *   FIRST. The orchestrator state machine (G3) inserts entityType ahead of
 *   product/vehicle resolution. See `DIMENSION_ORDER` in conversation-types.ts.
 * - Q2 — entityIds are stored as the soft-pointer array. UI lazy-loads the
 *   entity metadata (name, price, photos) at render/send time — no snapshot
 *   in `Campaign.proposedPlan` / `committedPlan`. Avoids stale data when
 *   vehicle inventory changes daily.
 * - Q5 — array shape supports specific multi-target campaigns ("these 4
 *   VINs"). At send time the consumer filters out any VIN whose `removedAt`
 *   is set and surfaces an honest skipped-count to the operator (no
 *   auto-pause — Memo 19/42 affordance-honesty).
 *
 * # Memo 39 codebase-precedent
 *
 * Discriminated-union pattern mirrors `GoalShapeSchema` in
 * `feasibility-context-types.ts:34-68` and `AudienceConditionsSchema`'s
 * recursive `allOf` / `anyOf` shape. Entity-list array shape is the same
 * scalar-array pattern already used elsewhere in the schema (e.g.
 * `Vehicle.photoUrls`, `Vehicle.features`).
 */
import { z } from 'zod';

// ─────────────────────────────────────────────
// Entity-type discriminator
// ─────────────────────────────────────────────

export const CampaignTargetEntityTypeEnum = z.enum(['product', 'vehicle']);
export type CampaignTargetEntityType = z.infer<
  typeof CampaignTargetEntityTypeEnum
>;

export const CAMPAIGN_TARGET_ENTITY_TYPE_LABELS: Record<
  CampaignTargetEntityType,
  string
> = {
  product: 'Product',
  vehicle: 'Vehicle',
};

// ─────────────────────────────────────────────
// CampaignTargetSchema — discriminated union
// ─────────────────────────────────────────────

/**
 * Per-entity-type variant of the target. The `ids` array carries soft
 * pointers (Product.id UUIDs or Vehicle.id UUIDs depending on the
 * `entityType` discriminator). Empty array is valid during the draft phase
 * before the operator confirms specific entity selection.
 *
 * The Prisma column shape (`target_entity_type` TEXT NULL +
 * `target_entity_ids` TEXT[]) maps cleanly to this union when paired with
 * `helpers.fromCampaignRow` / `helpers.toCampaignRow` below.
 */
export const CampaignTargetSchema = z.discriminatedUnion('entityType', [
  z.object({
    entityType: z.literal('product'),
    ids: z.array(z.string().uuid()).max(100).default([]),
  }),
  z.object({
    entityType: z.literal('vehicle'),
    ids: z.array(z.string().uuid()).max(100).default([]),
  }),
]);
export type CampaignTarget = z.infer<typeof CampaignTargetSchema>;

// ─────────────────────────────────────────────
// Row-shape adapters
// ─────────────────────────────────────────────

/**
 * Map a Prisma Campaign row's `targetEntityType` + `targetEntityIds` to the
 * discriminated CampaignTarget. Returns null when no target has been
 * confirmed yet (draft phase). Throws on invalid `targetEntityType` — the
 * DB CHECK constraint should already reject these, so reaching this path
 * indicates schema drift.
 */
export function fromCampaignRow(row: {
  targetEntityType: string | null;
  targetEntityIds: string[];
}): CampaignTarget | null {
  if (row.targetEntityType == null) return null;
  const parsed = CampaignTargetEntityTypeEnum.safeParse(row.targetEntityType);
  if (!parsed.success) {
    throw new Error(
      `Invalid Campaign.targetEntityType: ${row.targetEntityType}. ` +
        `Expected 'product' | 'vehicle' | null.`,
    );
  }
  return CampaignTargetSchema.parse({
    entityType: parsed.data,
    ids: row.targetEntityIds,
  });
}

/**
 * Inverse of `fromCampaignRow`. Always returns the column pair shape so
 * callers can spread into a Prisma update args object:
 *
 *   prisma.campaign.update({ where: { id }, data: toCampaignRow(target) });
 */
export function toCampaignRow(
  target: CampaignTarget,
): { targetEntityType: CampaignTargetEntityType; targetEntityIds: string[] } {
  return {
    targetEntityType: target.entityType,
    targetEntityIds: target.ids,
  };
}
