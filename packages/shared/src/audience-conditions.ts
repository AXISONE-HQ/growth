/**
 * KAN-997 Campaign Layer Slice 1 — AudienceConditions jsonb shape.
 *
 * Verify-don't-assume finding: the architecture reference described a
 * pipeline-wizard `audience_conditions` jsonb, but the real schema has
 * NO such column. This module defines the shape FRESH for Slice 1.
 * Architect (Slice 0 data-model reconciliation) may iterate on it.
 *
 * Shape: a recursive discriminated union of logical operators (`allOf`,
 * `anyOf`) wrapped around leaf conditions. The leaf condition set v1
 * covers what the canonical Slice 1 case requires:
 *
 *   - lifecycleStage (Contact.lifecycleStage enum)
 *   - segment        (Contact.segment string)
 *   - source         (Contact.source enum)
 *   - country        (Contact.country ISO-3166-1 alpha-2 string)
 *   - createdAt      (Contact.createdAt — half-open UTC range)
 *   - orders.placedAt (EXISTS Order in window — purchase-history axis)
 *   - orders.exists  (has-any-order toggle, true/false)
 *
 * Date ranges are half-open `[fromUtc, toUtcExclusive)` per
 * relative-dates.ts. UTC-anchored to avoid the KAN-cohort-3.5 / KAN-943
 * off-by-one class.
 *
 * Canonical NL case:
 *   "contacts that bought or sent a lead in March, April & May of last year"
 * (today = 2026-05-23 → last year = 2025) →
 *   {
 *     anyOf: [
 *       { field: 'orders.placedAt', op: 'between',
 *         fromUtc: '2025-03-01T00:00:00.000Z',
 *         toUtcExclusive: '2025-06-01T00:00:00.000Z' },
 *       { field: 'createdAt', op: 'between',
 *         fromUtc: '2025-03-01T00:00:00.000Z',
 *         toUtcExclusive: '2025-06-01T00:00:00.000Z' }
 *     ]
 *   }
 */
import { z } from 'zod';
// KAN-1000 Slice 2 fix-forward — consume the CANONICAL enums from
// enums.ts (PAIRS-tested against Prisma). Prior to this fix the local
// enums here drift'd from Prisma (added 'opportunity'/'churned',
// missing 'lost'; ContactSource had 7 made-up values vs Prisma's 10).
// LLM emitted Zod-valid values that exploded at Prisma + leaked the
// raw query string to the UI.
import { ContactSourceEnum, LifecycleStageEnum } from './enums.js';

const lifecycleStageLeaf = z.object({
  field: z.literal('lifecycleStage'),
  op: z.literal('in'),
  values: z.array(LifecycleStageEnum).min(1),
});

const segmentLeaf = z.object({
  field: z.literal('segment'),
  op: z.literal('in'),
  values: z.array(z.string().min(1)).min(1),
});

const sourceLeaf = z.object({
  field: z.literal('source'),
  op: z.literal('in'),
  values: z.array(ContactSourceEnum).min(1),
});

const countryLeaf = z.object({
  field: z.literal('country'),
  op: z.literal('in'),
  // ISO-3166-1 alpha-2 — schema only checks length=2 + uppercase shape
  // (data-quality of the ISO list itself is upstream — Contact.country
  // is currently a free-text String? at the schema level).
  values: z.array(z.string().length(2).regex(/^[A-Z]{2}$/)).min(1),
});

const createdAtLeaf = z.object({
  field: z.literal('createdAt'),
  op: z.literal('between'),
  fromUtc: z.string().datetime(),
  toUtcExclusive: z.string().datetime(),
});

const ordersPlacedAtLeaf = z.object({
  field: z.literal('orders.placedAt'),
  op: z.literal('between'),
  fromUtc: z.string().datetime(),
  toUtcExclusive: z.string().datetime(),
});

const ordersExistsLeaf = z.object({
  field: z.literal('orders.exists'),
  op: z.literal('eq'),
  value: z.boolean(),
});

/** Discriminated union of leaf conditions. */
export const LeafConditionSchema = z.discriminatedUnion('field', [
  lifecycleStageLeaf,
  segmentLeaf,
  sourceLeaf,
  countryLeaf,
  createdAtLeaf,
  ordersPlacedAtLeaf,
  ordersExistsLeaf,
]);

export type LeafCondition = z.infer<typeof LeafConditionSchema>;

// ─────────────────────────────────────────────
// Recursive AudienceConditions (allOf / anyOf / leaf)
// ─────────────────────────────────────────────

/**
 * Zod doesn't support cyclic discriminated unions ergonomically, so the
 * recursive shape is hand-rolled with z.lazy(). Runtime cost is one
 * function call per `parse` traversal — negligible at the call-site
 * volume (one parse per textToSegment call).
 */
export type AudienceConditions =
  | { allOf: AudienceConditions[] }
  | { anyOf: AudienceConditions[] }
  | LeafCondition;

export const AudienceConditionsSchema: z.ZodType<AudienceConditions> = z.lazy(() =>
  z.union([
    z.object({ allOf: z.array(AudienceConditionsSchema).min(1) }),
    z.object({ anyOf: z.array(AudienceConditionsSchema).min(1) }),
    LeafConditionSchema,
  ]),
);

/**
 * Type guards — useful for the count-side Prisma where-tree builder +
 * any future renderer that walks the tree.
 */
export function isAllOf(
  c: AudienceConditions,
): c is { allOf: AudienceConditions[] } {
  return typeof c === 'object' && c !== null && 'allOf' in c;
}

export function isAnyOf(
  c: AudienceConditions,
): c is { anyOf: AudienceConditions[] } {
  return typeof c === 'object' && c !== null && 'anyOf' in c;
}

export function isLeaf(c: AudienceConditions): c is LeafCondition {
  return typeof c === 'object' && c !== null && 'field' in c;
}
