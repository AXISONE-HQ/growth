/**
 * KAN-922 — Cohort 2.5 Configurable Field Matching.
 *
 * Coverage:
 *   - 4 matchers × matchKey variants (external_id / email / phone / domain /
 *     orderNumber / providerOrderId / auto-cascade)
 *   - resolveContactByMatchKey per kind (email / phone / external_id)
 *   - resolveDealByMatchKey (external_id)
 *   - projectRow externalIds tagging
 */
import { describe, it, expect, vi } from 'vitest';
import {
  matchContact,
  matchCompany,
  matchDeal,
  matchOrder,
  type MatchConfig,
  type ContactMatchKey,
  type CompanyMatchKey,
  type DealMatchKey,
  type OrderMatchKey,
} from '../import-dedup.js';
import { projectRow, type ProjectedContact, type ProjectedDeal, type ProjectedOrder } from '../lib/row-projection.js';
import {
  resolveContactByMatchKey,
  resolveDealByMatchKey,
} from '../import-commit.js';

// ─────────────────────────────────────────────
// projectRow — externalIds tagging
// ─────────────────────────────────────────────

describe('KAN-922 — projectRow externalIds tagging', () => {
  const ctx = { tenantId: 't1', importJobId: 'j1', sourceRowIndex: 0 };

  it('tags external_id under the source tag when both column and tag set', () => {
    const sourceRow = { user_id: 'hub_123', email: 'a@b.com' };
    const mappings = [
      { sourceColumn: 'user_id', targetField: 'external_id', confidence: 100 },
      { sourceColumn: 'email', targetField: 'email', confidence: 100 },
    ];
    const result = projectRow(sourceRow, mappings, 'contacts', ctx, 'hubspot') as ProjectedContact;
    expect(result.externalIds).toEqual({ hubspot: 'hub_123' });
  });

  it('returns empty externalIds when no external_id column mapped', () => {
    const sourceRow = { email: 'a@b.com' };
    const mappings = [
      { sourceColumn: 'email', targetField: 'email', confidence: 100 },
    ];
    const result = projectRow(sourceRow, mappings, 'contacts', ctx, 'hubspot') as ProjectedContact;
    expect(result.externalIds).toEqual({});
  });

  it('returns empty externalIds when externalSourceTag is null even if column mapped', () => {
    const sourceRow = { user_id: 'hub_123' };
    const mappings = [
      { sourceColumn: 'user_id', targetField: 'external_id', confidence: 100 },
    ];
    const result = projectRow(sourceRow, mappings, 'contacts', ctx, null) as ProjectedContact;
    expect(result.externalIds).toEqual({});
  });

  it('Deal: tags BOTH externalIds (deal own) AND contactExternalIds (linked customer)', () => {
    const sourceRow = { deal_id: 'opp_42', customer_id: 'cust_99' };
    const mappings = [
      { sourceColumn: 'deal_id', targetField: 'external_id', confidence: 100 },
      { sourceColumn: 'customer_id', targetField: 'customer_external_id', confidence: 100 },
    ];
    const result = projectRow(sourceRow, mappings, 'deals', ctx, 'hubspot') as ProjectedDeal;
    expect(result.externalIds).toEqual({ hubspot: 'opp_42' });
    expect(result.contactExternalIds).toEqual({ hubspot: 'cust_99' });
  });

  it('Order: tags THREE externalIds shapes (own / customer / deal)', () => {
    const sourceRow = { order_id: 'ord_1', customer_id: 'cust_2', deal_id: 'opp_3' };
    const mappings = [
      { sourceColumn: 'order_id', targetField: 'external_id', confidence: 100 },
      { sourceColumn: 'customer_id', targetField: 'customer_external_id', confidence: 100 },
      { sourceColumn: 'deal_id', targetField: 'deal_external_id', confidence: 100 },
    ];
    const result = projectRow(sourceRow, mappings, 'orders', ctx, 'stripe') as ProjectedOrder;
    expect(result.externalIds).toEqual({ stripe: 'ord_1' });
    expect(result.contactExternalIds).toEqual({ stripe: 'cust_2' });
    expect(result.dealExternalIds).toEqual({ stripe: 'opp_3' });
  });
});

// ─────────────────────────────────────────────
// matchContact — matchKey variants
// ─────────────────────────────────────────────

describe('KAN-922 — matchContact with matchKey', () => {
  const existing = [
    { id: 'c1', email: 'alice@a.com', phone: '+15551234567', firstName: 'Alice', lastName: 'A', companyName: null,
      externalIds: { hubspot: 'hub_1', stripe: 'cus_1' } },
    { id: 'c2', email: 'bob@b.com', phone: '+15559999999', firstName: 'Bob', lastName: 'B', companyName: null,
      externalIds: { hubspot: 'hub_2' } },
    { id: 'c3', email: 'carol@c.com', phone: null, firstName: 'Carol', lastName: 'C', companyName: null,
      externalIds: {} },
  ];
  const buckets = new Map();

  it('matchKey="external_id" with source tag hits only on externalIds[tag] match', () => {
    const config: MatchConfig<ContactMatchKey> = { matchKey: 'external_id', externalSourceTag: 'hubspot' };
    const result = matchContact(
      { externalIds: { hubspot: 'hub_2' } },
      existing,
      buckets,
      config,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].existingEntityId).toBe('c2');
    expect(result.candidates[0].score).toBe(100);
    expect(result.candidates[0].matchedFields).toEqual(['external_id_exact']);
    expect(result.suggestedAction).toBe('update');
  });

  it('matchKey="external_id" returns no candidates when staging has no externalIds[tag]', () => {
    const config: MatchConfig<ContactMatchKey> = { matchKey: 'external_id', externalSourceTag: 'hubspot' };
    const result = matchContact({ externalIds: {} }, existing, buckets, config);
    expect(result.candidates).toHaveLength(0);
    expect(result.suggestedAction).toBe('insert');
  });

  it('matchKey="external_id" returns no candidates when externalSourceTag missing', () => {
    const config: MatchConfig<ContactMatchKey> = { matchKey: 'external_id' };
    const result = matchContact(
      { externalIds: { hubspot: 'hub_1' } },
      existing, buckets, config,
    );
    expect(result.candidates).toHaveLength(0);
  });

  it('matchKey="email" is strict — only email_exact fires, no phone/fuzzy fallback', () => {
    const config: MatchConfig<ContactMatchKey> = { matchKey: 'email' };
    // Staging has matching phone for c1 but different email
    const result = matchContact(
      { email: 'alice@a.com', phone: '+15559999999' }, // phone matches c2, email matches c1
      existing, buckets, config,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].existingEntityId).toBe('c1');
    expect(result.candidates[0].matchedFields).toEqual(['email_exact']);
  });

  it('matchKey="phone" is strict — only phone_exact fires', () => {
    const config: MatchConfig<ContactMatchKey> = { matchKey: 'phone' };
    const result = matchContact(
      { phone: '5551234567' }, // matches c1's phone via NANP normalization
      existing, buckets, config,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].existingEntityId).toBe('c1');
    expect(result.candidates[0].matchedFields).toEqual(['phone_exact']);
  });

  it('matchKey undefined → backwards-compat heuristic cascade still works (regression)', () => {
    const result = matchContact(
      { email: 'alice@a.com' },
      existing,
      new Map([['a', [existing[0]]]]),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].matchedFields).toContain('email_exact');
  });
});

// ─────────────────────────────────────────────
// matchCompany / matchDeal / matchOrder — matchKey variants
// ─────────────────────────────────────────────

describe('KAN-922 — matchCompany with matchKey', () => {
  const existing = [
    { id: 'co1', name: 'Acme', legalName: 'Acme Inc', domain: 'acme.io', externalIds: { hubspot: 'h_co_1' } },
    { id: 'co2', name: 'Beta', legalName: null, domain: 'beta.io', externalIds: { stripe: 's_co_2' } },
  ];
  const buckets = new Map();

  it('matchKey="external_id" matches via externalIds[tag]', () => {
    const config: MatchConfig<CompanyMatchKey> = { matchKey: 'external_id', externalSourceTag: 'stripe' };
    const result = matchCompany({ externalIds: { stripe: 's_co_2' } }, existing, buckets, config);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].existingEntityId).toBe('co2');
  });

  it('matchKey="domain" is strict', () => {
    const config: MatchConfig<CompanyMatchKey> = { matchKey: 'domain' };
    const result = matchCompany({ domain: 'acme.io' }, existing, buckets, config);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].matchedFields).toEqual(['domain_exact']);
  });

  it('matchKey undefined → heuristic cascade (domain → name fuzzy)', () => {
    const result = matchCompany(
      { domain: 'acme.io' },
      existing,
      new Map(),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].matchedFields).toContain('domain_exact');
  });
});

describe('KAN-922 — matchDeal with matchKey', () => {
  const existing = [
    { id: 'd1', name: 'Big Deal', expectedCloseDate: null, contact: null,
      externalIds: { hubspot: 'opp_1' } },
  ];
  const buckets = new Map();

  it('matchKey="external_id" matches via externalIds[tag]', () => {
    const config: MatchConfig<DealMatchKey> = { matchKey: 'external_id', externalSourceTag: 'hubspot' };
    const result = matchDeal({ externalIds: { hubspot: 'opp_1' } }, existing, buckets, config);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].existingEntityId).toBe('d1');
    expect(result.candidates[0].matchedFields).toEqual(['external_id_exact']);
  });

  it('matchKey undefined → heuristic (requires both name + contactEmail)', () => {
    const result = matchDeal({ name: 'Big Deal' }, existing, new Map());
    expect(result.candidates).toHaveLength(0); // conservative — no contactEmail
  });
});

describe('KAN-922 — matchOrder with matchKey', () => {
  const existing = [
    { id: 'o1', orderNumber: 'ORD-001', providerOrderId: 'pi_xxx', placedAt: null,
      contact: null, externalIds: { stripe: 'pi_xxx' } },
    { id: 'o2', orderNumber: 'ORD-002', providerOrderId: null, placedAt: null,
      contact: null, externalIds: {} },
  ];
  const orderMap = new Map([['ORD-001', [existing[0]]], ['ORD-002', [existing[1]]]]);
  const providerMap = new Map([['pi_xxx', [existing[0]]]]);

  it('matchKey="external_id" matches', () => {
    const config: MatchConfig<OrderMatchKey> = { matchKey: 'external_id', externalSourceTag: 'stripe' };
    const result = matchOrder({ externalIds: { stripe: 'pi_xxx' } }, existing, orderMap, providerMap, config);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].existingEntityId).toBe('o1');
  });

  it('matchKey="orderNumber" strict', () => {
    const config: MatchConfig<OrderMatchKey> = { matchKey: 'orderNumber' };
    const result = matchOrder({ orderNumber: 'ORD-002' }, existing, orderMap, providerMap, config);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].matchedFields).toEqual(['order_number_exact']);
  });

  it('matchKey="providerOrderId" strict', () => {
    const config: MatchConfig<OrderMatchKey> = { matchKey: 'providerOrderId' };
    const result = matchOrder({ providerOrderId: 'pi_xxx' }, existing, orderMap, providerMap, config);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].matchedFields).toEqual(['provider_order_id_exact']);
  });
});

// ─────────────────────────────────────────────
// resolveContactByMatchKey / resolveDealByMatchKey
// ─────────────────────────────────────────────

describe('KAN-922 — resolveContactByMatchKey', () => {
  it('kind=email dispatches to contact.findFirst with insensitive email match', async () => {
    const fakePrisma = {
      contact: {
        findFirst: vi.fn().mockResolvedValue({ id: 'c1' }),
      },
    };
    const result = await resolveContactByMatchKey(
      fakePrisma as never,
      't1',
      { kind: 'email', value: 'Alice@A.com' },
    );
    expect(result).toEqual({ id: 'c1' });
    expect(fakePrisma.contact.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't1', email: { equals: 'Alice@A.com', mode: 'insensitive' } },
      select: { id: true },
    });
  });

  it('kind=phone dispatches to phone equality', async () => {
    const fakePrisma = {
      contact: {
        findFirst: vi.fn().mockResolvedValue({ id: 'c2' }),
      },
    };
    await resolveContactByMatchKey(
      fakePrisma as never,
      't1',
      { kind: 'phone', value: '+15551234567' },
    );
    expect(fakePrisma.contact.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't1', phone: '+15551234567' },
      select: { id: true },
    });
  });

  it('kind=external_id dispatches to JSON path filter (post-KAN-921: OR-wrapped for multi-value support)', async () => {
    const fakePrisma = {
      contact: {
        findFirst: vi.fn().mockResolvedValue({ id: 'c3' }),
      },
    };
    await resolveContactByMatchKey(
      fakePrisma as never,
      't1',
      { kind: 'external_id', source: 'hubspot', value: 'hub_123' },
    );
    // KAN-921: resolver now splits delimited values and OR-batches the
    // lookups. Single-value inputs produce a 1-element OR — semantically
    // equivalent to pre-KAN-921 exact-match.
    expect(fakePrisma.contact.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 't1',
        OR: [{ externalIds: { path: ['hubspot'], equals: 'hub_123' } }],
      },
      select: { id: true },
    });
  });

  it('returns null when value is null/undefined/empty (any kind)', async () => {
    const fakePrisma = { contact: { findFirst: vi.fn() } };
    expect(await resolveContactByMatchKey(fakePrisma as never, 't1', { kind: 'email', value: null })).toBeNull();
    expect(await resolveContactByMatchKey(fakePrisma as never, 't1', { kind: 'phone', value: undefined })).toBeNull();
    expect(await resolveContactByMatchKey(fakePrisma as never, 't1', { kind: 'external_id', source: 'hubspot', value: '' })).toBeNull();
    expect(fakePrisma.contact.findFirst).not.toHaveBeenCalled();
  });
});

describe('KAN-922 — resolveDealByMatchKey', () => {
  it('kind=external_id dispatches to JSON path filter on Deal (post-KAN-921: OR-wrapped)', async () => {
    const fakePrisma = {
      deal: {
        findFirst: vi.fn().mockResolvedValue({ id: 'd1' }),
      },
    };
    const result = await resolveDealByMatchKey(
      fakePrisma as never,
      't1',
      { kind: 'external_id', source: 'hubspot', value: 'opp_42' },
    );
    expect(result).toEqual({ id: 'd1' });
    // KAN-921: see sibling test on resolveContactByMatchKey for rationale.
    expect(fakePrisma.deal.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 't1',
        OR: [{ externalIds: { path: ['hubspot'], equals: 'opp_42' } }],
      },
      select: { id: true },
    });
  });

  it('returns null when value is empty', async () => {
    const fakePrisma = { deal: { findFirst: vi.fn() } };
    expect(await resolveDealByMatchKey(fakePrisma as never, 't1', { kind: 'external_id', source: 'hubspot', value: null })).toBeNull();
    expect(fakePrisma.deal.findFirst).not.toHaveBeenCalled();
  });
});
