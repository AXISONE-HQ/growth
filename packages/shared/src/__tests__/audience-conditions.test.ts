/**
 * KAN-997 Slice 1 — AudienceConditions Zod schema validation.
 *
 * Pins the discriminated-union shape so a future edit (or the architect's
 * Slice 0 reconciliation) can't silently break the contract between the
 * LLM extractor and the count-side Prisma where-tree.
 */
import { describe, it, expect } from 'vitest';
import {
  AudienceConditionsSchema,
  LeafConditionSchema,
  isAllOf,
  isAnyOf,
  isLeaf,
  type AudienceConditions,
} from '../audience-conditions.js';

describe('KAN-997 — Leaf condition schemas', () => {
  it('lifecycleStage leaf — accepts canonical shape', () => {
    expect(() =>
      LeafConditionSchema.parse({
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead', 'mql'],
      }),
    ).not.toThrow();
  });

  it('lifecycleStage leaf — rejects unknown enum value', () => {
    expect(() =>
      LeafConditionSchema.parse({
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead', 'invalid_stage'],
      }),
    ).toThrow();
  });

  it('lifecycleStage leaf — rejects empty values[]', () => {
    expect(() =>
      LeafConditionSchema.parse({
        field: 'lifecycleStage',
        op: 'in',
        values: [],
      }),
    ).toThrow();
  });

  it('createdAt leaf — accepts ISO datetimes', () => {
    expect(() =>
      LeafConditionSchema.parse({
        field: 'createdAt',
        op: 'between',
        fromUtc: '2025-03-01T00:00:00.000Z',
        toUtcExclusive: '2025-06-01T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('createdAt leaf — rejects non-ISO date strings', () => {
    expect(() =>
      LeafConditionSchema.parse({
        field: 'createdAt',
        op: 'between',
        fromUtc: 'March 1 2025',
        toUtcExclusive: '2025-06-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('orders.placedAt leaf — accepts canonical shape', () => {
    expect(() =>
      LeafConditionSchema.parse({
        field: 'orders.placedAt',
        op: 'between',
        fromUtc: '2025-03-01T00:00:00.000Z',
        toUtcExclusive: '2025-06-01T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('orders.exists leaf — boolean value', () => {
    expect(() =>
      LeafConditionSchema.parse({
        field: 'orders.exists',
        op: 'eq',
        value: true,
      }),
    ).not.toThrow();
  });

  it('country leaf — rejects 3-letter codes (alpha-2 only)', () => {
    expect(() =>
      LeafConditionSchema.parse({ field: 'country', op: 'in', values: ['USA'] }),
    ).toThrow();
    expect(() =>
      LeafConditionSchema.parse({ field: 'country', op: 'in', values: ['US', 'CA'] }),
    ).not.toThrow();
  });

  it('rejects unknown field (closed discriminator)', () => {
    expect(() =>
      LeafConditionSchema.parse({
        field: 'mysterious_field',
        op: 'in',
        values: ['x'],
      }),
    ).toThrow();
  });
});

describe('KAN-997 — Recursive AudienceConditions tree', () => {
  it('canonical case parses cleanly: anyOf [orders.placedAt-range, createdAt-range]', () => {
    const canonical: AudienceConditions = {
      anyOf: [
        {
          field: 'orders.placedAt',
          op: 'between',
          fromUtc: '2025-03-01T00:00:00.000Z',
          toUtcExclusive: '2025-06-01T00:00:00.000Z',
        },
        {
          field: 'createdAt',
          op: 'between',
          fromUtc: '2025-03-01T00:00:00.000Z',
          toUtcExclusive: '2025-06-01T00:00:00.000Z',
        },
      ],
    };
    expect(() => AudienceConditionsSchema.parse(canonical)).not.toThrow();
  });

  it('nested allOf inside anyOf parses cleanly', () => {
    const nested: AudienceConditions = {
      anyOf: [
        {
          allOf: [
            { field: 'lifecycleStage', op: 'in', values: ['customer'] },
            { field: 'country', op: 'in', values: ['US'] },
          ],
        },
        { field: 'orders.exists', op: 'eq', value: true },
      ],
    };
    expect(() => AudienceConditionsSchema.parse(nested)).not.toThrow();
  });

  it('empty allOf[] rejected (must be ≥1)', () => {
    expect(() => AudienceConditionsSchema.parse({ allOf: [] })).toThrow();
    expect(() => AudienceConditionsSchema.parse({ anyOf: [] })).toThrow();
  });

  it('single leaf at the root parses cleanly (no wrapper required)', () => {
    expect(() =>
      AudienceConditionsSchema.parse({
        field: 'lifecycleStage',
        op: 'in',
        values: ['customer'],
      }),
    ).not.toThrow();
  });
});

describe('KAN-997 — Type guards for where-tree walking', () => {
  it('isAllOf / isAnyOf / isLeaf identify each node kind', () => {
    const leaf: AudienceConditions = {
      field: 'lifecycleStage',
      op: 'in',
      values: ['lead'],
    };
    const allOf: AudienceConditions = { allOf: [leaf] };
    const anyOf: AudienceConditions = { anyOf: [leaf] };

    expect(isLeaf(leaf)).toBe(true);
    expect(isAllOf(leaf)).toBe(false);
    expect(isAnyOf(leaf)).toBe(false);

    expect(isAllOf(allOf)).toBe(true);
    expect(isAnyOf(allOf)).toBe(false);
    expect(isLeaf(allOf)).toBe(false);

    expect(isAnyOf(anyOf)).toBe(true);
    expect(isAllOf(anyOf)).toBe(false);
    expect(isLeaf(anyOf)).toBe(false);
  });
});
