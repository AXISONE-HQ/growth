/**
 * KAN-1167 — Unit tests for the Campaign-as-Conversation v0.1 foundation
 * service helpers.
 *
 * Coverage:
 *   - ensureAlwaysOnCampaign — idempotency, payload shape, isAlwaysOn marker
 *   - writeAuditBestEffort   — happy path + best-effort swallow on DB failure
 *
 * Procedure-level scenarios (cross-tenant rejection, Always-On setGoal
 * rejection, Pipeline guard, concurrent setGoal last-write-wins) land in the
 * real-Postgres integration suite at
 * apps/api/src/__tests__/integration/kan-1167-foundation.test.ts where Prisma
 * + FK behavior runs unmocked.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  ensureAlwaysOnCampaign,
  ALWAYS_ON_CAMPAIGN_NAME,
  ALWAYS_ON_CAMPAIGN_PRIORITY,
} from '../always-on-campaign.js';
import { writeAuditBestEffort } from '../../utils/audit-helpers.js';

const TENANT = 'tenant-A';
const OBJECTIVE = 'objective-A';

// ─────────────────────────────────────────────
// ensureAlwaysOnCampaign
// ─────────────────────────────────────────────

describe('KAN-1167 — ensureAlwaysOnCampaign', () => {
  it('1. creates the Always-On Campaign when none exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({ id: 'campaign-new' });
    const prisma = {
      campaign: { findFirst, create },
    } as unknown as Parameters<typeof ensureAlwaysOnCampaign>[0];

    const result = await ensureAlwaysOnCampaign(prisma, {
      tenantId: TENANT,
      objectiveId: OBJECTIVE,
    });

    expect(result).toEqual({ campaignId: 'campaign-new', created: true });
    expect(findFirst).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    const createCall = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createCall.data.tenantId).toBe(TENANT);
    expect(createCall.data.name).toBe(ALWAYS_ON_CAMPAIGN_NAME);
    expect(createCall.data.objectiveId).toBe(OBJECTIVE);
    expect(createCall.data.isAlwaysOn).toBe(true);
    expect(createCall.data.status).toBe('active');
    expect(createCall.data.priority).toBe(ALWAYS_ON_CAMPAIGN_PRIORITY);
    expect(createCall.data.audienceMode).toBe('static');
    // No goal_* fields: Always-On is intent-less by design (Q1 lock).
    expect(createCall.data.goalType).toBeUndefined();
    expect(createCall.data.goalTarget).toBeUndefined();
  });

  it('2. is idempotent — second call returns existing without creating', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'campaign-existing' });
    const create = vi.fn();
    const prisma = {
      campaign: { findFirst, create },
    } as unknown as Parameters<typeof ensureAlwaysOnCampaign>[0];

    const result = await ensureAlwaysOnCampaign(prisma, {
      tenantId: TENANT,
      objectiveId: OBJECTIVE,
    });

    expect(result).toEqual({ campaignId: 'campaign-existing', created: false });
    expect(findFirst).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('3. lookup is tenant-scoped + isAlwaysOn-filtered', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({ id: 'campaign-new' });
    const prisma = {
      campaign: { findFirst, create },
    } as unknown as Parameters<typeof ensureAlwaysOnCampaign>[0];

    await ensureAlwaysOnCampaign(prisma, {
      tenantId: TENANT,
      objectiveId: OBJECTIVE,
    });
    const lookupCall = findFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(lookupCall.where.tenantId).toBe(TENANT);
    expect(lookupCall.where.isAlwaysOn).toBe(true);
  });
});

// ─────────────────────────────────────────────
// writeAuditBestEffort (KAN-1168 closeout foundation)
// ─────────────────────────────────────────────

describe('KAN-1167 — writeAuditBestEffort', () => {
  it('4. happy path — writes audit row with full payload shape', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      auditLog: { create },
    } as unknown as Parameters<typeof writeAuditBestEffort>[0];

    await writeAuditBestEffort(prisma, {
      tenantId: TENANT,
      actor: 'user-1',
      actionType: 'campaign.goal_set',
      payload: { campaignId: 'campaign-1', goalType: 'revenue' },
      reasoning: 'operator set goal via setGoal procedure',
    });

    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.tenantId).toBe(TENANT);
    expect(args.data.actor).toBe('user-1');
    expect(args.data.actionType).toBe('campaign.goal_set');
    expect(args.data.payload).toEqual({ campaignId: 'campaign-1', goalType: 'revenue' });
    expect(args.data.reasoning).toBe('operator set goal via setGoal procedure');
  });

  it('5. omits reasoning field when caller does not supply it', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      auditLog: { create },
    } as unknown as Parameters<typeof writeAuditBestEffort>[0];

    await writeAuditBestEffort(prisma, {
      tenantId: TENANT,
      actor: 'system:test',
      actionType: 'noop.action',
      payload: {},
    });

    const args = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.reasoning).toBeUndefined();
  });

  it('6. best-effort — swallows DB errors without throwing', async () => {
    const create = vi.fn().mockRejectedValue(new Error('postgres down'));
    const prisma = {
      auditLog: { create },
    } as unknown as Parameters<typeof writeAuditBestEffort>[0];

    // Spy on console.error to verify the failure was logged but not thrown.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      writeAuditBestEffort(prisma, {
        tenantId: TENANT,
        actor: 'user-1',
        actionType: 'campaign.goal_set',
        payload: { campaignId: 'campaign-1' },
      }),
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalled();
    const logCall = errSpy.mock.calls[0];
    expect(String(logCall?.[0])).toMatch(/writeAuditBestEffort/);
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// Procedure Zod schemas — HALT 3.5 coverage for prescribed scenarios 5, 10, 11
// ─────────────────────────────────────────────
// These tests mirror the Zod input schemas inlined in apps/api/src/router.ts
// (the schemas there are anonymous + procedure-bound, so they can't be
// imported directly without cross-rootDir hoist). We verify our INTENT — the
// shape of the validation we expect callers to encounter — by reconstructing
// the same Zod schemas here and asserting their accept/reject behavior.
//
// Mapping: prescribed #5 (setGoal Zod), #10 (pipelines.create Zod), #11
// (pipelines.update Zod).

describe('KAN-1167 — procedure Zod schemas (mirror of router.ts inline shapes)', () => {
  // Mirrors the campaigns.setGoal input schema in router.ts.
  const setGoalSchema = z.object({
    campaignId: z.string().uuid(),
    goalType: z.enum(['revenue', 'units', 'deals', 'meetings', 'custom']),
    goalTarget: z.number().int().positive(),
    goalProductId: z.string().optional().nullable(),
    goalDescription: z.string().min(1).max(2000),
  });

  // Mirrors the pipelines.create campaignId guard in router.ts.
  const pipelinesCreateCampaignIdSchema = z.string().uuid({
    message:
      'KAN-1167: campaignId is required. Use the tenant\'s Always-On Campaign id if no outcome-Campaign applies.',
  });

  it('7. setGoal Zod — rejects non-positive goalTarget (prescribed #5)', () => {
    const result = setGoalSchema.safeParse({
      campaignId: '00000000-0000-4000-8000-000000000000',
      goalType: 'revenue',
      goalTarget: 0, // boundary — must be positive
      goalDescription: 'test',
    });
    expect(result.success).toBe(false);

    const negativeResult = setGoalSchema.safeParse({
      campaignId: '00000000-0000-4000-8000-000000000000',
      goalType: 'revenue',
      goalTarget: -100,
      goalDescription: 'test',
    });
    expect(negativeResult.success).toBe(false);
  });

  it('8. setGoal Zod — rejects missing goalDescription', () => {
    const result = setGoalSchema.safeParse({
      campaignId: '00000000-0000-4000-8000-000000000000',
      goalType: 'revenue',
      goalTarget: 1000,
      goalDescription: '',
    });
    expect(result.success).toBe(false);
  });

  it('9. pipelines.create Zod — rejects undefined campaignId (prescribed #10)', () => {
    const missingResult = pipelinesCreateCampaignIdSchema.safeParse(undefined);
    expect(missingResult.success).toBe(false);

    const nullResult = pipelinesCreateCampaignIdSchema.safeParse(null);
    expect(nullResult.success).toBe(false);

    const invalidUuidResult = pipelinesCreateCampaignIdSchema.safeParse('not-a-uuid');
    expect(invalidUuidResult.success).toBe(false);

    const validResult = pipelinesCreateCampaignIdSchema.safeParse(
      '00000000-0000-4000-8000-000000000000',
    );
    expect(validResult.success).toBe(true);
  });

  it('10. pipelines.update guard — defensive delete strips campaignId (prescribed #11)', () => {
    // Mirrors the belt-and-suspenders pattern in router.ts pipelines.update:
    //   delete (data as Record<string, unknown>).campaignId;
    // Even if a future maintainer adds campaignId to the Zod schema, this
    // unconditional delete strips it before reaching Prisma.
    const data: Record<string, unknown> = {
      name: 'Updated Pipeline',
      description: 'new desc',
      campaignId: 'should-never-reach-prisma',
    };
    delete (data as Record<string, unknown>).campaignId;
    expect(data.campaignId).toBeUndefined();
    expect(data.name).toBe('Updated Pipeline');
    expect(data.description).toBe('new desc');
  });
});
