/**
 * KAN-1010 — SAE PR5 activate / pause / drip publisher tests.
 *
 * Pinned outcomes per brief's unit-test matrix:
 *   - activate happy path → state flip + stack upsert + drip publish
 *   - activate blocked on audienceEvaluatedAt=NULL (the PR3 interlock)
 *   - activate blocked on each non-committed status
 *   - activate idempotent on already-active (no re-publish)
 *   - pause-halts (campaign + stack flip to paused)
 *   - pause idempotent on already-inactive
 *   - drip-cap respected (publishesPerSecond bounds the call rate)
 *
 * Plus INERTNESS source-grep extending the PR3/PR4 regression discipline.
 *
 * Uses the in-memory fake-prisma pattern from campaign-commit.test.ts /
 * sae-pr3-subscribers.test.ts. Hooks are vi.fn() recordings so we can
 * assert per-call audit-log + per-member pubsub publish counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  activateCampaign,
  pauseCampaign,
  dripPublishDecisionRun,
  DEFAULT_DRIP_PUBLISHES_PER_SECOND,
  DRIP_BATCH_SIZE,
  type ActivatePrisma,
  type ActivateTransactionClient,
  type ActivateHooks,
  type PauseHooks,
} from '../campaign-activation.js';

// ─────────────────────────────────────────────
// Fixtures + fake prisma
// ─────────────────────────────────────────────

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN_A = '33333333-3333-3333-3333-333333333333';
const OBJECTIVE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

interface FakeCampaign {
  id: string;
  tenantId: string;
  status: string;
  audienceEvaluatedAt: Date | null;
  objectiveId: string;
  priority: number;
  audienceSnapshotCount: number | null;
  activatedAt: Date | null;
}

interface FakeMembership {
  id: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  exitedAt: Date | null;
}

interface FakeStackRow {
  id: string;
  tenantId: string;
  contactId: string;
  objectiveId: string;
  campaignId: string | null;
  priority: number;
  status: string;
}

interface FakeStore {
  campaigns: FakeCampaign[];
  memberships: FakeMembership[];
  stack: FakeStackRow[];
  uuidCounter: number;
}

function makeStore(seed?: Partial<FakeStore>): FakeStore {
  return {
    campaigns: seed?.campaigns ?? [],
    memberships: seed?.memberships ?? [],
    stack: seed?.stack ?? [],
    uuidCounter: 0,
  };
}

function nextId(store: FakeStore, prefix: string): string {
  store.uuidCounter += 1;
  return `${prefix}-${store.uuidCounter.toString().padStart(6, '0')}`;
}

function makeFakePrismaForActivate(store: FakeStore): ActivatePrisma {
  const tx: ActivateTransactionClient = {
    campaign: {
      update: async ({ where, data }) => {
        const row = store.campaigns.find((c) => c.id === where.id);
        if (!row) throw new Error(`campaign ${where.id} not found`);
        Object.assign(row, data);
        return { id: row.id, status: row.status };
      },
    },
    campaignMembership: {
      findMany: async ({ where }) => {
        return store.memberships
          .filter((m) => m.campaignId === where.campaignId && m.tenantId === where.tenantId)
          .map((m) => ({ contactId: m.contactId }));
      },
    },
    contactObjectiveStack: {
      createMany: async ({ data }) => {
        let count = 0;
        for (const row of data) {
          // Honor @@unique([contactId, objectiveId])
          const exists = store.stack.some(
            (s) => s.contactId === row.contactId && s.objectiveId === row.objectiveId,
          );
          if (exists) continue;
          store.stack.push({
            id: nextId(store, 'stack'),
            tenantId: row.tenantId,
            contactId: row.contactId,
            objectiveId: row.objectiveId,
            campaignId: row.campaignId,
            priority: row.priority,
            status: row.status,
          });
          count += 1;
        }
        return { count };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of store.stack) {
          if (where.tenantId !== undefined && row.tenantId !== where.tenantId) continue;
          if (where.campaignId !== undefined && row.campaignId !== where.campaignId) continue;
          if (where.status !== undefined) {
            if (typeof where.status === 'string') {
              if (row.status !== where.status) continue;
            } else if ('in' in where.status && Array.isArray(where.status.in)) {
              if (!where.status.in.includes(row.status)) continue;
            }
          }
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
  };

  return {
    $transaction: async (fn) => fn(tx),
    campaign: {
      findFirst: async ({ where, select: _sel }) => {
        const row = store.campaigns.find(
          (c) => c.id === where.id && c.tenantId === where.tenantId,
        );
        if (!row) return null;
        return {
          id: row.id,
          status: row.status,
          audienceEvaluatedAt: row.audienceEvaluatedAt,
          objectiveId: row.objectiveId,
          priority: row.priority,
          audienceSnapshotCount: row.audienceSnapshotCount,
        };
      },
    },
    campaignMembership: {
      findMany: async ({ where }) => {
        return store.memberships
          .filter(
            (m) =>
              m.campaignId === where.campaignId &&
              m.tenantId === where.tenantId &&
              m.exitedAt === null,
          )
          .map((m) => ({ contactId: m.contactId }));
      },
    },
    contactObjectiveStack: {
      findMany: async ({ where, take, cursor, skip }) => {
        let rows = store.stack.filter(
          (s) =>
            s.tenantId === where.tenantId &&
            s.campaignId === where.campaignId &&
            where.status.in.includes(s.status),
        );
        rows.sort((a, b) => (a.id < b.id ? -1 : 1));
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          if (idx >= 0) rows = rows.slice(idx + (skip ?? 0));
          else rows = [];
        }
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((r) => ({ id: r.id, contactId: r.contactId }));
      },
    },
  };
}

function makeActivateHooks(): ActivateHooks & {
  auditLogCalls: Array<{ actionType: string; payload: Record<string, unknown> }>;
  pubsubCalls: Array<{ tenantId: string; contactId: string; campaignId: string }>;
} {
  const auditLogCalls: Array<{ actionType: string; payload: Record<string, unknown> }> = [];
  const pubsubCalls: Array<{ tenantId: string; contactId: string; campaignId: string }> = [];
  return {
    auditLog: {
      writeInTx: async (_tx, payload) => {
        auditLogCalls.push({ actionType: payload.actionType, payload: payload.payload });
        return { id: `audit-${auditLogCalls.length}` };
      },
    },
    pubsub: {
      publishDecisionRun: async (args) => {
        pubsubCalls.push(args);
        return `msg-${pubsubCalls.length}`;
      },
    },
    auditLogCalls,
    pubsubCalls,
  };
}

function makePauseHooks(): PauseHooks & {
  auditLogCalls: Array<{ actionType: string; payload: Record<string, unknown> }>;
} {
  const auditLogCalls: Array<{ actionType: string; payload: Record<string, unknown> }> = [];
  return {
    auditLog: {
      writeInTx: async (_tx, payload) => {
        auditLogCalls.push({ actionType: payload.actionType, payload: payload.payload });
        return { id: `audit-${auditLogCalls.length}` };
      },
    },
    auditLogCalls,
  };
}

function seedCommittedCampaign(opts: {
  audienceEvaluatedAt?: Date | null;
  memberContactIds: string[];
}): FakeStore {
  // Distinguish "key absent" (use default) from "key=null" (interlock test).
  // `??` would coerce null → default; need explicit `in` check.
  const audienceEvaluatedAt =
    'audienceEvaluatedAt' in opts ? opts.audienceEvaluatedAt ?? null : new Date('2026-05-24T15:00:00Z');
  const campaign: FakeCampaign = {
    id: CAMPAIGN_A,
    tenantId: TENANT_A,
    status: 'committed',
    audienceEvaluatedAt,
    objectiveId: OBJECTIVE_A,
    priority: 100,
    audienceSnapshotCount: opts.memberContactIds.length,
    activatedAt: new Date('2026-05-24T15:00:00Z'),
  };
  const memberships: FakeMembership[] = opts.memberContactIds.map((cid, i) => ({
    id: `mem-${i}`,
    tenantId: TENANT_A,
    campaignId: CAMPAIGN_A,
    contactId: cid,
    exitedAt: null,
  }));
  return makeStore({ campaigns: [campaign], memberships, stack: [] });
}

// Helper for tests that need to drive drip without real timers
async function noSleep(_ms: number): Promise<void> {
  // resolve immediately
}

// ─────────────────────────────────────────────
// activate() — happy path + preconditions + idempotency
// ─────────────────────────────────────────────

describe('activateCampaign — happy path', () => {
  it('flips status to active, creates stack entries, drip-publishes per member', async () => {
    const store = seedCommittedCampaign({
      memberContactIds: ['contact-1', 'contact-2', 'contact-3'],
    });
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makeActivateHooks();

    const result = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks, {
      publishesPerSecond: 1000, // fast for test
    });

    expect(result.kind).toBe('activated');
    if (result.kind !== 'activated') return;
    expect(result.memberCount).toBe(3);
    expect(result.stackEntriesCreated).toBe(3);
    expect(result.stackEntriesReactivated).toBe(0);

    // Campaign status flipped
    expect(store.campaigns[0]!.status).toBe('active');
    // Stack entries created (3 active rows tagged to this campaign)
    expect(store.stack).toHaveLength(3);
    for (const s of store.stack) {
      expect(s.status).toBe('active');
      expect(s.campaignId).toBe(CAMPAIGN_A);
      expect(s.tenantId).toBe(TENANT_A);
      expect(s.objectiveId).toBe(OBJECTIVE_A);
    }

    // Audit log written
    expect(hooks.auditLogCalls).toHaveLength(1);
    expect(hooks.auditLogCalls[0]!.actionType).toBe('campaign.activated');

    // Drip publish — IS fire-and-forget; we need to wait for it.
    // Easiest: small sleep to let the IIFE drain.
    await new Promise((r) => setTimeout(r, 50));
    expect(hooks.pubsubCalls).toHaveLength(3);
    const contactIds = hooks.pubsubCalls.map((c) => c.contactId).sort();
    expect(contactIds).toEqual(['contact-1', 'contact-2', 'contact-3']);
    for (const c of hooks.pubsubCalls) {
      expect(c.campaignId).toBe(CAMPAIGN_A);
      expect(c.tenantId).toBe(TENANT_A);
    }
  });

  it('reactivates paused stack entries (e.g., pause→activate cycle)', async () => {
    const store = seedCommittedCampaign({
      memberContactIds: ['contact-1', 'contact-2'],
    });
    // Pre-seed an existing paused stack entry for contact-1
    store.stack.push({
      id: 'pre-existing-1',
      tenantId: TENANT_A,
      contactId: 'contact-1',
      objectiveId: OBJECTIVE_A,
      campaignId: CAMPAIGN_A,
      priority: 100,
      status: 'paused',
    });
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makeActivateHooks();

    const result = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks, {
      publishesPerSecond: 1000,
    });

    expect(result.kind).toBe('activated');
    if (result.kind !== 'activated') return;
    // createMany skipped contact-1 (already exists with @@unique), created contact-2
    expect(result.stackEntriesCreated).toBe(1);
    // updateMany flipped the paused contact-1 row to active
    expect(result.stackEntriesReactivated).toBe(1);

    expect(store.stack.find((s) => s.contactId === 'contact-1')!.status).toBe('active');
    expect(store.stack.find((s) => s.contactId === 'contact-2')!.status).toBe('active');
  });
});

// ─────────────────────────────────────────────
// activate() — precondition gates (the PR3 interlock + status gating)
// ─────────────────────────────────────────────

describe('activateCampaign — preconditions', () => {
  it('REJECTS on audienceEvaluatedAt=NULL (partial materialization interlock)', async () => {
    const store = seedCommittedCampaign({
      audienceEvaluatedAt: null,
      memberContactIds: ['contact-1'],
    });
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makeActivateHooks();

    const result = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);

    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'audience_not_evaluated',
    });
    // CRITICAL: no state mutation
    expect(store.campaigns[0]!.status).toBe('committed');
    expect(store.stack).toHaveLength(0);
    expect(hooks.auditLogCalls).toHaveLength(0);
    expect(hooks.pubsubCalls).toHaveLength(0);
  });

  it('REJECTS on status=draft', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    store.campaigns[0]!.status = 'draft';
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makeActivateHooks();
    const result = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);
    expect(result).toMatchObject({ kind: 'rejected', reason: 'status_draft' });
    expect(hooks.pubsubCalls).toHaveLength(0);
  });

  it('REJECTS on status=paused', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    store.campaigns[0]!.status = 'paused';
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makeActivateHooks();
    const result = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);
    expect(result).toMatchObject({ kind: 'rejected', reason: 'status_paused' });
  });

  it('REJECTS on status=completed', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    store.campaigns[0]!.status = 'completed';
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makeActivateHooks();
    const result = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);
    expect(result).toMatchObject({ kind: 'rejected', reason: 'status_completed' });
  });

  it('REJECTS on status=archived', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    store.campaigns[0]!.status = 'archived';
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makeActivateHooks();
    const result = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);
    expect(result).toMatchObject({ kind: 'rejected', reason: 'status_archived' });
  });

  it('REJECTS on campaign not found in tenant scope', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makeActivateHooks();
    const result = await activateCampaign(
      prisma,
      '99999999-9999-9999-9999-999999999999', // wrong tenant
      { campaignId: CAMPAIGN_A },
      hooks,
    );
    expect(result).toMatchObject({ kind: 'rejected', reason: 'campaign_not_found' });
  });
});

// ─────────────────────────────────────────────
// activate() — idempotency
// ─────────────────────────────────────────────

describe('activateCampaign — idempotency', () => {
  it('returns already_active without re-publishing on second invocation', async () => {
    const store = seedCommittedCampaign({
      memberContactIds: ['contact-1', 'contact-2'],
    });
    const prisma = makeFakePrismaForActivate(store);
    const hooks1 = makeActivateHooks();
    const hooks2 = makeActivateHooks();

    const first = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks1, {
      publishesPerSecond: 1000,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(first.kind).toBe('activated');
    expect(hooks1.pubsubCalls).toHaveLength(2);

    // Second invocation — should be a no-op (no audit, no publish, no
    // state mutation beyond reading the row)
    const second = await activateCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks2);
    await new Promise((r) => setTimeout(r, 30));

    expect(second).toMatchObject({
      kind: 'already_active',
      memberCount: 2,
    });
    expect(hooks2.auditLogCalls).toHaveLength(0);
    expect(hooks2.pubsubCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// pause() — halts + idempotency + status gating
// ─────────────────────────────────────────────

describe('pauseCampaign — halts', () => {
  it('flips active campaign + all active stack entries to paused', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1', 'c2'] });
    store.campaigns[0]!.status = 'active';
    store.stack.push(
      {
        id: 's1',
        tenantId: TENANT_A,
        contactId: 'c1',
        objectiveId: OBJECTIVE_A,
        campaignId: CAMPAIGN_A,
        priority: 100,
        status: 'active',
      },
      {
        id: 's2',
        tenantId: TENANT_A,
        contactId: 'c2',
        objectiveId: OBJECTIVE_A,
        campaignId: CAMPAIGN_A,
        priority: 100,
        status: 'active',
      },
    );
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makePauseHooks();

    const result = await pauseCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);

    expect(result).toMatchObject({ kind: 'paused', stackEntriesPaused: 2 });
    expect(store.campaigns[0]!.status).toBe('paused');
    expect(store.stack.every((s) => s.status === 'paused')).toBe(true);
    expect(hooks.auditLogCalls).toHaveLength(1);
    expect(hooks.auditLogCalls[0]!.actionType).toBe('campaign.paused');
  });

  it('does not touch terminal stack rows (achieved/abandoned/superseded)', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    store.campaigns[0]!.status = 'active';
    store.stack.push(
      {
        id: 's1',
        tenantId: TENANT_A,
        contactId: 'c1',
        objectiveId: OBJECTIVE_A,
        campaignId: CAMPAIGN_A,
        priority: 100,
        status: 'achieved', // terminal — pause should not touch
      },
    );
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makePauseHooks();

    const result = await pauseCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);

    expect(result).toMatchObject({ kind: 'paused', stackEntriesPaused: 0 });
    // achieved → stays achieved
    expect(store.stack[0]!.status).toBe('achieved');
  });
});

describe('pauseCampaign — idempotency + gating', () => {
  it('is a no-op on already-paused', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    store.campaigns[0]!.status = 'paused';
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makePauseHooks();
    const result = await pauseCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);
    expect(result).toMatchObject({ kind: 'already_inactive', currentStatus: 'paused' });
    expect(hooks.auditLogCalls).toHaveLength(0);
  });

  it('is a no-op on archived', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    store.campaigns[0]!.status = 'archived';
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makePauseHooks();
    const result = await pauseCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);
    expect(result).toMatchObject({ kind: 'already_inactive', currentStatus: 'archived' });
  });

  it('REJECTS on committed (nothing to halt)', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    // status='committed' from seed
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makePauseHooks();
    const result = await pauseCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);
    expect(result).toMatchObject({ kind: 'rejected', reason: 'status_committed' });
  });

  it('REJECTS on draft', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    store.campaigns[0]!.status = 'draft';
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makePauseHooks();
    const result = await pauseCampaign(prisma, TENANT_A, { campaignId: CAMPAIGN_A }, hooks);
    expect(result).toMatchObject({ kind: 'rejected', reason: 'status_draft' });
  });

  it('REJECTS on campaign not found in tenant scope', async () => {
    const store = seedCommittedCampaign({ memberContactIds: ['c1'] });
    const prisma = makeFakePrismaForActivate(store);
    const hooks = makePauseHooks();
    const result = await pauseCampaign(
      prisma,
      '99999999-9999-9999-9999-999999999999',
      { campaignId: CAMPAIGN_A },
      hooks,
    );
    expect(result).toMatchObject({ kind: 'rejected', reason: 'campaign_not_found' });
  });
});

// ─────────────────────────────────────────────
// dripPublishDecisionRun — pagination + rate-limit + error tolerance
// ─────────────────────────────────────────────

describe('dripPublishDecisionRun — direct unit', () => {
  it('paginates through stack entries + publishes one per active row', async () => {
    const store = seedCommittedCampaign({ memberContactIds: [] });
    store.campaigns[0]!.status = 'active';
    // 3 stack entries — all active
    for (let i = 0; i < 3; i++) {
      store.stack.push({
        id: `s-${i}`,
        tenantId: TENANT_A,
        contactId: `c-${i}`,
        objectiveId: OBJECTIVE_A,
        campaignId: CAMPAIGN_A,
        priority: 100,
        status: 'active',
      });
    }
    const prisma = makeFakePrismaForActivate(store);
    const calls: Array<{ tenantId: string; contactId: string; campaignId: string }> = [];
    const result = await dripPublishDecisionRun(
      prisma,
      {
        tenantId: TENANT_A,
        campaignId: CAMPAIGN_A,
        publishesPerSecond: 10000,
        sleep: noSleep,
      },
      {
        publishDecisionRun: async (args) => {
          calls.push(args);
          return `msg-${calls.length}`;
        },
      },
    );

    expect(result).toMatchObject({
      totalStackEntriesProcessed: 3,
      totalPublished: 3,
      totalPublishErrors: 0,
    });
    expect(calls).toHaveLength(3);
  });

  it('skips paused stack rows (respects mid-flight pause)', async () => {
    const store = seedCommittedCampaign({ memberContactIds: [] });
    store.stack.push(
      {
        id: 's-1',
        tenantId: TENANT_A,
        contactId: 'c-1',
        objectiveId: OBJECTIVE_A,
        campaignId: CAMPAIGN_A,
        priority: 100,
        status: 'active',
      },
      {
        id: 's-2',
        tenantId: TENANT_A,
        contactId: 'c-2',
        objectiveId: OBJECTIVE_A,
        campaignId: CAMPAIGN_A,
        priority: 100,
        status: 'paused', // mid-flight pause
      },
    );
    const prisma = makeFakePrismaForActivate(store);
    const calls: Array<{ tenantId: string; contactId: string; campaignId: string }> = [];
    await dripPublishDecisionRun(
      prisma,
      { tenantId: TENANT_A, campaignId: CAMPAIGN_A, publishesPerSecond: 10000, sleep: noSleep },
      {
        publishDecisionRun: async (a) => {
          calls.push(a);
          return `msg`;
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.contactId).toBe('c-1');
  });

  it('continues on per-publish error + counts errors separately', async () => {
    const store = seedCommittedCampaign({ memberContactIds: [] });
    for (let i = 0; i < 4; i++) {
      store.stack.push({
        id: `s-${i}`,
        tenantId: TENANT_A,
        contactId: `c-${i}`,
        objectiveId: OBJECTIVE_A,
        campaignId: CAMPAIGN_A,
        priority: 100,
        status: 'active',
      });
    }
    const prisma = makeFakePrismaForActivate(store);
    let n = 0;
    const result = await dripPublishDecisionRun(
      prisma,
      { tenantId: TENANT_A, campaignId: CAMPAIGN_A, publishesPerSecond: 10000, sleep: noSleep },
      {
        publishDecisionRun: async () => {
          n += 1;
          if (n === 2) throw new Error('simulated transient publish error');
          return `msg-${n}`;
        },
      },
    );
    expect(result.totalPublished).toBe(3);
    expect(result.totalPublishErrors).toBe(1);
    expect(result.totalStackEntriesProcessed).toBe(4);
  });

  it('respects publishesPerSecond — sleeps the correct interval between publishes', async () => {
    const store = seedCommittedCampaign({ memberContactIds: [] });
    for (let i = 0; i < 3; i++) {
      store.stack.push({
        id: `s-${i}`,
        tenantId: TENANT_A,
        contactId: `c-${i}`,
        objectiveId: OBJECTIVE_A,
        campaignId: CAMPAIGN_A,
        priority: 100,
        status: 'active',
      });
    }
    const prisma = makeFakePrismaForActivate(store);
    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    await dripPublishDecisionRun(
      prisma,
      {
        tenantId: TENANT_A,
        campaignId: CAMPAIGN_A,
        publishesPerSecond: 5, // 1000/5 = 200ms per publish
        sleep: fakeSleep,
      },
      { publishDecisionRun: async () => 'msg' },
    );
    // 3 publishes → 3 sleeps of 200ms each
    expect(sleepCalls).toEqual([200, 200, 200]);
  });
});

// ─────────────────────────────────────────────
// INERTNESS source-grep regression
// ─────────────────────────────────────────────

describe('campaign-activation source — INERTNESS regression', () => {
  it('contains NO imports of send-path / dispatch modules', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'campaign-activation.ts'),
      'utf-8',
    );
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*action-decided-publisher/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*action-executed-push/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*send-policy/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*message-composer/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*agent-dispatcher/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*run-decision-for-contact/);
    // No direct symbol use of send-path functions
    expect(codeOnly).not.toMatch(/\bpublishActionSend\b/);
    expect(codeOnly).not.toMatch(/\bpublishActionDecided\b/);
    expect(codeOnly).not.toMatch(/\brunDecisionForContact\b/);
    expect(codeOnly).not.toMatch(/\brunForContact\b/);
  });

  it('only publishes to decision.run topic (no send/action topics)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'campaign-activation.ts'),
      'utf-8',
    );
    // The hook interface is publishDecisionRun — that's the only outbound.
    // No literal 'action.decided' / 'action.send' / 'action.executed' strings.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/['"]action\.decided['"]/);
    expect(codeOnly).not.toMatch(/['"]action\.send['"]/);
    expect(codeOnly).not.toMatch(/['"]action\.executed['"]/);
  });
});

// Suppress unused-var lint for fixture exports
void DEFAULT_DRIP_PUBLISHES_PER_SECOND;
void DRIP_BATCH_SIZE;
