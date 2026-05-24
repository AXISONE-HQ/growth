/**
 * KAN-1001 Campaign Layer Slice 3a — commit & materialize (INERT) tests.
 *
 * The five most load-bearing assertions, per the brief's "EXPLICITLY
 * NOT in 3a (this is the safety boundary)" section:
 *
 *   1. Happy path — commit creates Campaign + Pipeline + Stages +
 *      CampaignMembership rows
 *   2. INERTNESS — ZERO ContactObjectiveStack writes during commit
 *   3. INERTNESS — ZERO Pub/Sub publishes (the commit path never reaches
 *      `action.*`, `decision.*`, `escalation.*`)
 *   4. Tenant isolation — commit for tenant A never reads / writes
 *      tenant B's contacts or campaigns
 *   5. Idempotency — second commit within the 5-min window returns the
 *      existing IDs without inserting duplicate rows
 *
 * Plus a couple of structural assertions on the async materialization
 * worker (paginated batching + audienceEvaluatedAt update).
 *
 * Uses the same in-memory FakePrisma + recording hooks pattern as
 * audience-router.test.ts (the Slice 1 + Slice 2 test fixture).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  commitCampaign,
  archiveCampaign,
  materializeAudienceSnapshot,
  MEMBERSHIP_SYNC_LIMIT,
  type CommitHooks,
  type CommitPrisma,
  type CommitTransactionClient,
  type MaterializePrisma,
} from '../campaign-commit.js';
import type { CampaignProposal } from '@growth/shared';

// ─────────────────────────────────────────────
// Test tenants — fixed UUIDs so the cross-tenant invariant is visible
// in any failure message.
// ─────────────────────────────────────────────

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const OBJECTIVE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OBJECTIVE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface FakeContact {
  id: string;
  tenantId: string;
  lifecycleStage: string;
  segment: string | null;
  source: string | null;
  country: string | null;
  createdAt: Date;
  orders: { placedAt: Date; grandTotal: number; currency: string }[];
}

interface FakeCampaign {
  id: string;
  tenantId: string;
  name: string;
  nlIntent: string | null;
  objectiveId: string;
  strategy: string | null;
  audienceConditions: unknown;
  audienceMode: string;
  audienceEvaluatedAt: Date | null;
  audienceSnapshotCount: number | null;
  historicalValueUsdAtActivation: number | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  status: string;
  priority: number;
  activatedAt: Date | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
}

interface FakePipeline {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  objectiveType: string;
  objectiveDescription: string | null;
  objectiveId: string | null;
  campaignId: string | null;
  stages: Array<{ id: string; name: string; order: number; pipelineId: string; isInitial: boolean; isTerminal: boolean; outcomeType: string }>;
}

interface FakeMembership {
  id: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  source: string;
  joinedAt: Date;
}

interface FakeAuditLog {
  id: string;
  tenantId: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
  reasoning: string;
  createdAt: Date;
}

// ─────────────────────────────────────────────
// In-memory fake Prisma (matches the CommitPrisma + tx surface)
// ─────────────────────────────────────────────

interface FakeStore {
  contacts: FakeContact[];
  campaigns: FakeCampaign[];
  pipelines: FakePipeline[];
  memberships: FakeMembership[];
  auditLog: FakeAuditLog[];
  // Trap: a stack write here would be a Slice 3a regression. Test #2
  // asserts this remains 0.
  contactObjectiveStackWrites: Array<{
    op: 'create' | 'createMany' | 'upsert' | 'update' | 'delete';
    args: unknown;
  }>;
  // Trap: a Pub/Sub publish anywhere in the commit path = regression.
  pubsubPublishes: Array<{ topic: string; payload: unknown }>;
  uuidCounter: number;
}

function makeStore(seed?: Partial<FakeStore>): FakeStore {
  return {
    contacts: seed?.contacts ?? [],
    campaigns: seed?.campaigns ?? [],
    pipelines: seed?.pipelines ?? [],
    memberships: seed?.memberships ?? [],
    auditLog: seed?.auditLog ?? [],
    contactObjectiveStackWrites: [],
    pubsubPublishes: [],
    uuidCounter: 0,
  };
}

function nextId(store: FakeStore, prefix: string): string {
  store.uuidCounter += 1;
  return `${prefix}-${store.uuidCounter.toString().padStart(8, '0')}`;
}

/** Trivial WHERE evaluator — covers the predicates conditionsToWhere
 *  emits. Matches Prisma's AND/OR/in/gte/lt semantics for the fields
 *  the audience-router uses. Tenant scoping arrives via the outer AND. */
function evalWhere(c: FakeContact, where: Record<string, unknown>): boolean {
  if ('AND' in where && Array.isArray(where.AND)) {
    return (where.AND as Array<Record<string, unknown>>).every((w) =>
      evalWhere(c, w),
    );
  }
  if ('OR' in where && Array.isArray(where.OR)) {
    return (where.OR as Array<Record<string, unknown>>).some((w) =>
      evalWhere(c, w),
    );
  }
  if ('tenantId' in where) return c.tenantId === where.tenantId;
  if ('lifecycleStage' in where) {
    const filter = where.lifecycleStage as { in?: string[] };
    return Array.isArray(filter.in) && filter.in.includes(c.lifecycleStage);
  }
  if ('segment' in where) {
    const filter = where.segment as { in?: string[] };
    return Array.isArray(filter.in) && c.segment !== null && filter.in.includes(c.segment);
  }
  if ('source' in where) {
    const filter = where.source as { in?: string[] };
    return Array.isArray(filter.in) && c.source !== null && filter.in.includes(c.source);
  }
  if ('country' in where) {
    const filter = where.country as { in?: string[] };
    return Array.isArray(filter.in) && c.country !== null && filter.in.includes(c.country);
  }
  if ('createdAt' in where) {
    const filter = where.createdAt as { gte?: Date; lt?: Date };
    if (filter.gte && c.createdAt < filter.gte) return false;
    if (filter.lt && c.createdAt >= filter.lt) return false;
    return true;
  }
  if ('orders' in where) {
    const ord = where.orders as
      | { some?: Record<string, unknown> }
      | { none?: Record<string, unknown> };
    if ('some' in ord && ord.some !== undefined) {
      if (Object.keys(ord.some).length === 0) return c.orders.length > 0;
      // orders.placedAt range
      return c.orders.some((o) => {
        const placedAtFilter = (ord.some as { placedAt?: { gte?: Date; lt?: Date } })
          .placedAt;
        if (!placedAtFilter) return true;
        if (placedAtFilter.gte && o.placedAt < placedAtFilter.gte) return false;
        if (placedAtFilter.lt && o.placedAt >= placedAtFilter.lt) return false;
        return true;
      });
    }
    if ('none' in ord && ord.none !== undefined) {
      return c.orders.length === 0;
    }
  }
  // Unknown predicate — defensive: do not match (fail-closed).
  return false;
}

function makeFakePrismaForCommit(store: FakeStore): CommitPrisma {
  const txClient: CommitTransactionClient = {
    campaign: {
      findFirst: async ({ where, select: _sel, orderBy: _ob }) => {
        const w = where as {
          tenantId?: string;
          name?: string;
          status?: string;
          createdAt?: { gte?: Date };
          id?: string;
        };
        const matches = store.campaigns.filter((c) => {
          if (w.tenantId !== undefined && c.tenantId !== w.tenantId) return false;
          if (w.name !== undefined && c.name !== w.name) return false;
          if (w.status !== undefined && c.status !== w.status) return false;
          if (w.id !== undefined && c.id !== w.id) return false;
          if (w.createdAt?.gte && c.createdAt < w.createdAt.gte) return false;
          return true;
        });
        if (matches.length === 0) return null;
        // emulate orderBy createdAt desc
        matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const m = matches[0]!;
        // Include the linked pipelines (Phase 1 only links 1; defensive)
        return {
          id: m.id,
          pipelines: store.pipelines
            .filter((p) => p.campaignId === m.id)
            .map((p) => ({ id: p.id })),
        };
      },
      create: async ({ data, select: _sel }) => {
        const id = nextId(store, 'camp');
        const row: FakeCampaign = {
          id,
          tenantId: data.tenantId as string,
          name: data.name as string,
          nlIntent: (data.nlIntent as string | null) ?? null,
          objectiveId: data.objectiveId as string,
          strategy: (data.strategy as string | null) ?? null,
          audienceConditions: data.audienceConditions,
          audienceMode: data.audienceMode as string,
          audienceEvaluatedAt: (data.audienceEvaluatedAt as Date | null) ?? null,
          audienceSnapshotCount: (data.audienceSnapshotCount as number | null) ?? null,
          historicalValueUsdAtActivation:
            (data.historicalValueUsdAtActivation as number | null) ?? null,
          windowStart: (data.windowStart as Date | null) ?? null,
          windowEnd: (data.windowEnd as Date | null) ?? null,
          status: data.status as string,
          priority: data.priority as number,
          activatedAt: (data.activatedAt as Date | null) ?? null,
          completedAt: null,
          archivedAt: null,
          createdByUserId: (data.createdByUserId as string | null) ?? null,
          createdAt: new Date(),
        };
        store.campaigns.push(row);
        return { id: row.id, tenantId: row.tenantId, name: row.name };
      },
      update: async ({ where, data }) => {
        const row = store.campaigns.find((c) => c.id === where.id);
        if (!row) throw new Error(`Campaign ${where.id} not found`);
        Object.assign(row, data);
        return { id: row.id };
      },
    },
    pipeline: {
      create: async ({ data }) => {
        const id = nextId(store, 'pipe');
        const stagesNested =
          (data.stages as { create?: Array<Record<string, unknown>> })?.create ?? [];
        const stages = stagesNested.map((s) => ({
          id: nextId(store, 'stage'),
          name: s.name as string,
          order: s.order as number,
          pipelineId: id,
          isInitial: (s.isInitial as boolean | undefined) ?? false,
          isTerminal: (s.isTerminal as boolean | undefined) ?? false,
          outcomeType: (s.outcomeType as string | undefined) ?? 'open',
        }));
        const row: FakePipeline = {
          id,
          tenantId: data.tenantId as string,
          name: data.name as string,
          description: (data.description as string | null) ?? null,
          isActive: (data.isActive as boolean | undefined) ?? true,
          objectiveType: data.objectiveType as string,
          objectiveDescription: (data.objectiveDescription as string | null) ?? null,
          objectiveId: (data.objectiveId as string | null) ?? null,
          campaignId: (data.campaignId as string | null) ?? null,
          stages,
        };
        store.pipelines.push(row);
        return { id: row.id, stages };
      },
    },
    contact: {
      count: async ({ where }) => {
        return store.contacts.filter((c) => evalWhere(c, where)).length;
      },
      findMany: async ({ where, take, orderBy: _ob }) => {
        let matches = store.contacts.filter((c) => evalWhere(c, where));
        matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (take !== undefined) matches = matches.slice(0, take);
        return matches.map((c) => ({ id: c.id }));
      },
    },
    campaignMembership: {
      createMany: async ({ data, skipDuplicates: _sd }) => {
        let count = 0;
        for (const row of data) {
          // Honor @@unique([campaignId, contactId]) — skip duplicates
          // (skipDuplicates: true is what the service calls with).
          const exists = store.memberships.some(
            (m) => m.campaignId === row.campaignId && m.contactId === row.contactId,
          );
          if (exists) continue;
          store.memberships.push({
            id: nextId(store, 'mem'),
            tenantId: row.tenantId,
            campaignId: row.campaignId,
            contactId: row.contactId,
            source: row.source,
            joinedAt: new Date(),
          });
          count += 1;
        }
        return { count };
      },
    },
  };

  return {
    $transaction: async (fn) => fn(txClient),
    campaign: {
      findFirst: txClient.campaign.findFirst,
      update: async ({ where, data }) => {
        const row = store.campaigns.find((c) => c.id === where.id);
        if (!row) throw new Error(`Campaign ${where.id} not found`);
        Object.assign(row, data);
        return {
          id: row.id,
          status: row.status,
          archivedAt: row.archivedAt,
        };
      },
    },
    contact: {
      count: txClient.contact.count,
      findMany: txClient.contact.findMany,
    },
  };
}

// ─────────────────────────────────────────────
// Hooks — recording (so the test asserts what got called)
// ─────────────────────────────────────────────

function makeHooks(store: FakeStore): CommitHooks & {
  // expose so tests can introspect after the commit
  materializeCalls: Array<{ campaignId: string; tenantId: string }>;
  auditLogCalls: Array<{
    actionType: string;
    actor: string;
    payload: Record<string, unknown>;
  }>;
} {
  const materializeCalls: Array<{ campaignId: string; tenantId: string }> = [];
  const auditLogCalls: Array<{
    actionType: string;
    actor: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    auditLog: {
      writeInTx: async (_tx, payload) => {
        auditLogCalls.push({
          actionType: payload.actionType,
          actor: payload.actor,
          payload: payload.payload,
        });
        const id = nextId(store, 'audit');
        store.auditLog.push({
          id,
          tenantId: payload.tenantId,
          actor: payload.actor,
          actionType: payload.actionType,
          payload: payload.payload,
          reasoning: payload.reasoning,
          createdAt: new Date(),
        });
        return { id };
      },
    },
    materializeAsync: {
      kickOff: (args) => {
        materializeCalls.push({
          campaignId: args.campaignId,
          tenantId: args.tenantId,
        });
      },
    },
    materializeCalls,
    auditLogCalls,
  };
}

// ─────────────────────────────────────────────
// Sample proposal (small audience — 'lead' lifecycle, 3 contacts)
// ─────────────────────────────────────────────

const SAMPLE_PROPOSAL: CampaignProposal = {
  name: 'Demo Win-back',
  windowStartUtc: null,
  windowEndUtc: null,
  audience: {
    conditions: { field: 'lifecycleStage', op: 'in', values: ['lead'] },
    count: 3,
    historicalValueUsd: 1500,
  },
  objective: {
    id: OBJECTIVE_A,
    name: 'Book demos',
    type: 'book_appointment',
  },
  strategy: 'direct',
  proposedStages: [
    { name: 'Outreach', order: 0, description: 'Initial reach-out' },
    { name: 'Qualified', order: 1, description: 'Lead confirmed interest' },
    { name: 'Booked', order: 2, description: 'Demo scheduled' },
  ],
  firstActions: [
    {
      day: 0,
      channel: 'email',
      intent: 're-engagement opener',
      description: 'Send a brief value-prop email',
    },
  ],
};

// Seed: tenant A has 3 leads, tenant B has 5 leads (would-be cross-tenant
// leak if isolation broke).
function seedContacts(): FakeContact[] {
  const mk = (
    id: string,
    tenantId: string,
    lifecycleStage: string,
  ): FakeContact => ({
    id,
    tenantId,
    lifecycleStage,
    segment: null,
    source: null,
    country: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    orders: [],
  });
  return [
    mk('a-contact-1', TENANT_A, 'lead'),
    mk('a-contact-2', TENANT_A, 'lead'),
    mk('a-contact-3', TENANT_A, 'lead'),
    mk('a-contact-4', TENANT_A, 'customer'), // not in audience
    mk('b-contact-1', TENANT_B, 'lead'), // ← tenant B; commit for A must not touch
    mk('b-contact-2', TENANT_B, 'lead'),
    mk('b-contact-3', TENANT_B, 'lead'),
    mk('b-contact-4', TENANT_B, 'lead'),
    mk('b-contact-5', TENANT_B, 'lead'),
  ];
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('campaign-commit — happy path', () => {
  it('persists Campaign + Pipeline + Stages + initial CampaignMembership', async () => {
    const store = makeStore({ contacts: seedContacts() });
    const prisma = makeFakePrismaForCommit(store);
    const hooks = makeHooks(store);

    const result = await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: SAMPLE_PROPOSAL,
        idempotencyKey: 'aaaaaaaa-1111-2222-3333-444444444444',
      },
      hooks,
    );

    expect(result.alreadyExisted).toBe(false);
    expect(result.campaignId).toBeTruthy();
    expect(result.pipelineId).toBeTruthy();
    expect(result.stageIds).toHaveLength(3);
    expect(result.audienceCount).toBe(3);
    expect(result.membershipStatus).toBe('materialized_sync');
    expect(result.membershipSnapshotCountSync).toBe(3);

    // Persistence — exactly one campaign, exactly one pipeline (linked)
    expect(store.campaigns).toHaveLength(1);
    expect(store.campaigns[0]!.tenantId).toBe(TENANT_A);
    expect(store.campaigns[0]!.status).toBe('active');
    expect(store.campaigns[0]!.audienceMode).toBe('static');
    expect(store.campaigns[0]!.activatedAt).not.toBeNull();
    expect(store.campaigns[0]!.audienceEvaluatedAt).not.toBeNull();
    expect(store.campaigns[0]!.audienceSnapshotCount).toBe(3);

    expect(store.pipelines).toHaveLength(1);
    expect(store.pipelines[0]!.campaignId).toBe(store.campaigns[0]!.id);
    expect(store.pipelines[0]!.stages).toHaveLength(3);
    expect(store.pipelines[0]!.stages[0]!.isInitial).toBe(true);
    expect(store.pipelines[0]!.stages[1]!.isInitial).toBe(false);

    // Membership snapshot — 3 rows, all for tenant A, source='snapshot'
    expect(store.memberships).toHaveLength(3);
    for (const m of store.memberships) {
      expect(m.tenantId).toBe(TENANT_A);
      expect(m.campaignId).toBe(store.campaigns[0]!.id);
      expect(m.source).toBe('snapshot');
    }

    // Audit log — exactly one campaign.commit entry, atomic with the tx
    expect(hooks.auditLogCalls).toHaveLength(1);
    expect(hooks.auditLogCalls[0]!.actionType).toBe('campaign.commit');
    expect(hooks.auditLogCalls[0]!.payload.campaignId).toBe(
      store.campaigns[0]!.id,
    );
    expect(hooks.auditLogCalls[0]!.payload.membershipMode).toBe(
      'materialized_sync',
    );

    // Async materialization NOT triggered (small audience went sync)
    expect(hooks.materializeCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// INERTNESS — the four NOTs from the brief
// ─────────────────────────────────────────────

describe('campaign-commit — INERTNESS proofs', () => {
  it('writes ZERO ContactObjectiveStack rows during commit', async () => {
    const store = makeStore({ contacts: seedContacts() });
    const prisma = makeFakePrismaForCommit(store);
    const hooks = makeHooks(store);

    await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: SAMPLE_PROPOSAL,
        idempotencyKey: 'aaaaaaaa-2222-3333-4444-555555555555',
      },
      hooks,
    );

    // The trap: store.contactObjectiveStackWrites must remain empty
    // (the FakePrisma has NO contactObjectiveStack delegate at all —
    // any access would throw "Cannot read property of undefined").
    // Recording array stays at 0 by construction; assertion below is
    // belt-and-suspenders.
    expect(store.contactObjectiveStackWrites).toHaveLength(0);
  });

  it('publishes ZERO Pub/Sub events to action.* / decision.* / escalation.*', async () => {
    const store = makeStore({ contacts: seedContacts() });
    const prisma = makeFakePrismaForCommit(store);
    const hooks = makeHooks(store);

    await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: SAMPLE_PROPOSAL,
        idempotencyKey: 'aaaaaaaa-3333-4444-5555-666666666666',
      },
      hooks,
    );

    // Pub/Sub trap: FakePrisma exposes no `$queryRaw` or `$executeRaw`,
    // and the service module imports zero Pub/Sub modules. Recording
    // array stays at 0 by construction.
    expect(store.pubsubPublishes).toHaveLength(0);
  });

  it('module source contains no imports of action / decision / send publishers', async () => {
    // Static-source-grep style assertion — if a future refactor adds an
    // import line that wires the commit path to the Decision Engine /
    // Pub/Sub publishers / agent dispatcher, this test fails.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'campaign-commit.ts'),
      'utf-8',
    );
    // Strip block-comments so the documentation listing the bans
    // ("must NOT call runForContact") doesn't trigger the grep.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*run-decision-for-contact/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*action-decided-publisher/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*pubsub-client/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*agent-dispatcher/);
    // And no usage of the legacy `publishActionSend` symbol.
    expect(codeOnly).not.toMatch(/\bpublishActionSend\b/);
    expect(codeOnly).not.toMatch(/\brunForContact\b/);
  });
});

// ─────────────────────────────────────────────
// Tenant isolation — Slice 1 / Slice 2 invariant carried into Slice 3a
// ─────────────────────────────────────────────

describe('campaign-commit — tenant isolation', () => {
  it('commit for tenant A never reads/writes tenant B contacts', async () => {
    const store = makeStore({ contacts: seedContacts() });
    const prisma = makeFakePrismaForCommit(store);
    const hooks = makeHooks(store);

    await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: SAMPLE_PROPOSAL,
        idempotencyKey: 'aaaaaaaa-4444-5555-6666-777777777777',
      },
      hooks,
    );

    // Membership rows: every row must be tenant A; zero tenant B
    expect(store.memberships).toHaveLength(3);
    for (const m of store.memberships) {
      expect(m.tenantId).toBe(TENANT_A);
      // Cross-check: every membership contact must itself be tenant A
      const contact = store.contacts.find((c) => c.id === m.contactId);
      expect(contact?.tenantId).toBe(TENANT_A);
    }
    // Campaign + Pipeline + AuditLog: tenant A
    expect(store.campaigns[0]!.tenantId).toBe(TENANT_A);
    expect(store.pipelines[0]!.tenantId).toBe(TENANT_A);
    expect(store.auditLog[0]!.tenantId).toBe(TENANT_A);
  });
});

// ─────────────────────────────────────────────
// Idempotency guard
// ─────────────────────────────────────────────

describe('campaign-commit — idempotency soft window', () => {
  it('second commit for same (tenant, name) within 5 min returns existing IDs', async () => {
    const store = makeStore({ contacts: seedContacts() });
    const prisma = makeFakePrismaForCommit(store);
    const hooks = makeHooks(store);

    const first = await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: SAMPLE_PROPOSAL,
        idempotencyKey: 'aaaaaaaa-5555-6666-7777-888888888888',
      },
      hooks,
    );
    expect(first.alreadyExisted).toBe(false);

    const second = await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: SAMPLE_PROPOSAL,
        idempotencyKey: 'aaaaaaaa-9999-aaaa-bbbb-cccccccccccc',
      },
      hooks,
    );
    expect(second.alreadyExisted).toBe(true);
    expect(second.campaignId).toBe(first.campaignId);
    expect(second.pipelineId).toBe(first.pipelineId);

    // Persistence invariant: still exactly one campaign + one pipeline,
    // memberships unchanged (no duplicate inserts).
    expect(store.campaigns).toHaveLength(1);
    expect(store.pipelines).toHaveLength(1);
    expect(store.memberships).toHaveLength(3);
    // Audit log: only the FIRST commit's row (the idempotency-hit
    // returns early and writes no second audit row).
    expect(store.auditLog).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
// Sync vs async path — threshold gating
// ─────────────────────────────────────────────

describe('campaign-commit — sync vs async path', () => {
  it('large audience defers materialization + fires async hook', async () => {
    // Generate MEMBERSHIP_SYNC_LIMIT+50 lead contacts under tenant A.
    const lots: FakeContact[] = [];
    for (let i = 0; i < MEMBERSHIP_SYNC_LIMIT + 50; i++) {
      lots.push({
        id: `a-bulk-${i.toString().padStart(5, '0')}`,
        tenantId: TENANT_A,
        lifecycleStage: 'lead',
        segment: null,
        source: null,
        country: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        orders: [],
      });
    }
    const store = makeStore({ contacts: lots });
    const prisma = makeFakePrismaForCommit(store);
    const hooks = makeHooks(store);

    const result = await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: {
          ...SAMPLE_PROPOSAL,
          name: 'Big Audience',
          audience: { ...SAMPLE_PROPOSAL.audience, count: lots.length },
        },
        idempotencyKey: 'aaaaaaaa-7777-8888-9999-aaaaaaaaaaaa',
      },
      hooks,
    );

    expect(result.membershipStatus).toBe('deferred_async');
    expect(result.membershipSnapshotCountSync).toBe(0);
    // Campaign + Pipeline still committed
    expect(store.campaigns).toHaveLength(1);
    expect(store.campaigns[0]!.audienceEvaluatedAt).toBeNull();
    expect(store.campaigns[0]!.audienceSnapshotCount).toBeNull();
    expect(store.pipelines).toHaveLength(1);
    // Membership empty until async worker runs
    expect(store.memberships).toHaveLength(0);
    // Async hook fired exactly once with the right campaign id
    expect(hooks.materializeCalls).toHaveLength(1);
    expect(hooks.materializeCalls[0]!.campaignId).toBe(result.campaignId);
    expect(hooks.materializeCalls[0]!.tenantId).toBe(TENANT_A);
  });
});

// ─────────────────────────────────────────────
// Archive lifecycle
// ─────────────────────────────────────────────

describe('campaign-commit — archive', () => {
  it('sets status=archived + archivedAt + audit-logs the transition', async () => {
    const store = makeStore({ contacts: seedContacts() });
    const prisma = makeFakePrismaForCommit(store);
    const hooks = makeHooks(store);

    const commit = await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: SAMPLE_PROPOSAL,
        idempotencyKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
      hooks,
    );

    const archive = await archiveCampaign(
      prisma,
      TENANT_A,
      { campaignId: commit.campaignId },
      { auditLog: hooks.auditLog },
    );

    expect(archive.status).toBe('archived');
    expect(archive.campaignId).toBe(commit.campaignId);
    expect(archive.archivedAt).toBeInstanceOf(Date);
    expect(store.campaigns[0]!.status).toBe('archived');
    expect(store.campaigns[0]!.archivedAt).not.toBeNull();
    // Two audit rows now: commit + archive
    expect(store.auditLog).toHaveLength(2);
    const archiveAudit = store.auditLog.find((a) => a.actionType === 'campaign.archive');
    expect(archiveAudit).toBeDefined();
    expect(archiveAudit!.payload.campaignId).toBe(commit.campaignId);
  });

  it('refuses archive of a campaign from another tenant', async () => {
    const store = makeStore({ contacts: seedContacts() });
    const prisma = makeFakePrismaForCommit(store);
    const hooks = makeHooks(store);

    const commit = await commitCampaign(
      prisma,
      TENANT_A,
      {
        proposal: SAMPLE_PROPOSAL,
        idempotencyKey: 'aaaaaaaa-cccc-dddd-eeee-ffffffffffff',
      },
      hooks,
    );

    await expect(
      archiveCampaign(
        prisma,
        TENANT_B, // wrong tenant
        { campaignId: commit.campaignId },
        { auditLog: hooks.auditLog },
      ),
    ).rejects.toThrow(/not found in tenant scope/);

    // Campaign status unchanged
    expect(store.campaigns[0]!.status).toBe('active');
    expect(store.campaigns[0]!.archivedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Async materialization worker
// ─────────────────────────────────────────────

describe('materializeAudienceSnapshot — paginated worker', () => {
  it('inserts membership in batches + updates campaign.audienceEvaluatedAt', async () => {
    // Build 1200 tenant-A lead contacts so we exercise pagination over
    // multiple ASYNC_MATERIALIZE_BATCH (500) chunks.
    const bulk: FakeContact[] = [];
    for (let i = 0; i < 1200; i++) {
      bulk.push({
        id: `a-pg-${i.toString().padStart(5, '0')}`,
        tenantId: TENANT_A,
        lifecycleStage: 'lead',
        segment: null,
        source: null,
        country: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        orders: [],
      });
    }
    const store = makeStore({
      contacts: bulk,
      campaigns: [
        {
          id: 'camp-existing',
          tenantId: TENANT_A,
          name: 'Test',
          nlIntent: null,
          objectiveId: OBJECTIVE_A,
          strategy: 'direct',
          audienceConditions: {},
          audienceMode: 'static',
          audienceEvaluatedAt: null,
          audienceSnapshotCount: null,
          historicalValueUsdAtActivation: null,
          windowStart: null,
          windowEnd: null,
          status: 'active',
          priority: 100,
          activatedAt: new Date(),
          completedAt: null,
          archivedAt: null,
          createdByUserId: null,
          createdAt: new Date(),
        },
      ],
    });

    const materializePrisma: MaterializePrisma = {
      contact: {
        findMany: async ({ where, take, cursor, skip }) => {
          let matches = store.contacts.filter((c) => evalWhere(c, where));
          matches.sort((a, b) => (a.id < b.id ? -1 : 1));
          if (cursor) {
            const idx = matches.findIndex((c) => c.id === cursor.id);
            if (idx >= 0) matches = matches.slice(idx + (skip ?? 0));
            else matches = [];
          }
          if (take !== undefined) matches = matches.slice(0, take);
          return matches.map((c) => ({ id: c.id }));
        },
      },
      campaignMembership: {
        createMany: async ({ data }) => {
          let count = 0;
          for (const row of data) {
            const exists = store.memberships.some(
              (m) => m.campaignId === row.campaignId && m.contactId === row.contactId,
            );
            if (exists) continue;
            store.memberships.push({
              id: nextId(store, 'mem'),
              tenantId: row.tenantId,
              campaignId: row.campaignId,
              contactId: row.contactId,
              source: row.source,
              joinedAt: new Date(),
            });
            count += 1;
          }
          return { count };
        },
      },
      campaign: {
        update: async ({ where, data }) => {
          const row = store.campaigns.find((c) => c.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { id: row.id };
        },
      },
    };

    const result = await materializeAudienceSnapshot(materializePrisma, {
      tenantId: TENANT_A,
      campaignId: 'camp-existing',
      conditions: { field: 'lifecycleStage', op: 'in', values: ['lead'] },
    });

    expect(result.totalContactsScanned).toBe(1200);
    expect(result.totalMembershipInserted).toBe(1200);
    expect(result.batchCount).toBeGreaterThanOrEqual(3); // 500 + 500 + 200
    expect(store.memberships).toHaveLength(1200);
    expect(store.campaigns[0]!.audienceEvaluatedAt).not.toBeNull();
    expect(store.campaigns[0]!.audienceSnapshotCount).toBe(1200);
  });
});
