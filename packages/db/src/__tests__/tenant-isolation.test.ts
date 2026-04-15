/**
 * Tenant Isolation Tests
 * KAN-100: Verify multi-tenancy data isolation
 *
 * Tests that tenant-scoped queries never leak data across tenants.
 */

import { PrismaClient } from '@prisma/client';
import { tenantMiddleware, withTenantContext, extractTenantId } from '../src/middleware/tenant';

// ─── Test Utilities ───────────────────────────────────────

const prisma = new PrismaClient();

const TENANT_A_ID = 'test-tenant-aaa-001';
const TENANT_B_ID = 'test-tenant-bbb-002';

async function cleanupTestData() {
  // Clean up in reverse dependency order
  await prisma.action.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.decision.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.outcome.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.contactState.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.pipelineCard.deleteMany({
    where: {
      pipeline: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
    },
  });
  await prisma.escalation.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.conversation.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.customer.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.contact.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.objective.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.pipeline.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.strategyWeight.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.brainSnapshot.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.knowledgeBase.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.aiAgentConfig.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.auditLog.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.user.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: [TENANT_A_ID, TENANT_B_ID] } },
  });
}

// ─── Test Suite ───────────────────────────────────────────

describe('Multi-Tenant Isolation', () => {
  beforeAll(async () => {
    await cleanupTestData();

    // Create two test tenants
    await prisma.tenant.createMany({
      data: [
        {
          id: TENANT_A_ID,
          name: 'Tenant A - Test Corp',
          slug: 'test-tenant-a',
          planTier: 'pro',
        },
        {
          id: TENANT_B_ID,
          name: 'Tenant B - Other Inc',
          slug: 'test-tenant-b',
          planTier: 'starter',
        },
      ],
    });

    // Seed contacts for both tenants
    await prisma.contact.createMany({
      data: [
        {
          tenantId: TENANT_A_ID,
          email: 'alice@tenanta.com',
          firstName: 'Alice',
          lastName: 'Anderson',
          lifecycleStage: 'active',
        },
        {
          tenantId: TENANT_A_ID,
          email: 'bob@tenanta.com',
          firstName: 'Bob',
          lastName: 'Baker',
          lifecycleStage: 'new',
        },
        {
          tenantId: TENANT_B_ID,
          email: 'charlie@tenantb.com',
          firstName: 'Charlie',
          lastName: 'Clark',
          lifecycleStage: 'active',
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanupTestData();
    await prisma.$disconnect();
  });

  // ─── Middleware Unit Tests ────────────────────────────

  describe('tenantMiddleware', () => {
    it('should inject tenantId on create operations', async () => {
      const middleware = tenantMiddleware(TENANT_A_ID);

      const params: any = {
        model: 'Contact',
        action: 'create',
        args: {
          data: { email: 'test@example.com', firstName: 'Test' },
        },
      };

      let capturedParams: any;
      const next = async (p: any) => {
        capturedParams = p;
        return {};
      };

      await middleware(params, next);

      expect(capturedParams.args.data.tenantId).toBe(TENANT_A_ID);
    });

    it('should inject tenantId filter on findMany operations', async () => {
      const middleware = tenantMiddleware(TENANT_A_ID);

      const params: any = {
        model: 'Contact',
        action: 'findMany',
        args: {
          where: { lifecycleStage: 'active' },
        },
      };

      let capturedParams: any;
      const next = async (p: any) => {
        capturedParams = p;
        return [];
      };

      await middleware(params, next);

      expect(capturedParams.args.where.tenantId).toBe(TENANT_A_ID);
      expect(capturedParams.args.where.lifecycleStage).toBe('active');
    });

    it('should inject tenantId on createMany operations', async () => {
      const middleware = tenantMiddleware(TENANT_A_ID);

      const params: any = {
        model: 'Contact',
        action: 'createMany',
        args: {
          data: [
            { email: 'a@test.com' },
            { email: 'b@test.com' },
          ],
        },
      };

      let capturedParams: any;
      const next = async (p: any) => {
        capturedParams = p;
        return { count: 2 };
      };

      await middleware(params, next);

      expect(capturedParams.args.data[0].tenantId).toBe(TENANT_A_ID);
      expect(capturedParams.args.data[1].tenantId).toBe(TENANT_A_ID);
    });

    it('should NOT modify queries for global models (Blueprint)', async () => {
      const middleware = tenantMiddleware(TENANT_A_ID);

      const params: any = {
        model: 'Blueprint',
        action: 'findMany',
        args: {
          where: { isActive: true },
        },
      };

      let capturedParams: any;
      const next = async (p: any) => {
        capturedParams = p;
        return [];
      };

      await middleware(params, next);

      expect(capturedParams.args.where.tenantId).toBeUndefined();
    });

    it('should handle upsert by injecting tenantId in both where and create', async () => {
      const middleware = tenantMiddleware(TENANT_A_ID);

      const params: any = {
        model: 'Contact',
        action: 'upsert',
        args: {
          where: { id: 'some-id' },
          create: { email: 'new@test.com' },
          update: { email: 'updated@test.com' },
        },
      };

      let capturedParams: any;
      const next = async (p: any) => {
        capturedParams = p;
        return {};
      };

      await middleware(params, next);

      expect(capturedParams.args.where.tenantId).toBe(TENANT_A_ID);
      expect(capturedParams.args.create.tenantId).toBe(TENANT_A_ID);
    });
  });

  // ─── Integration Tests: Data Isolation ───────────────

  describe('Data Isolation', () => {
    it('Tenant A should only see their own contacts', async () => {
      const tenantAPrisma = withTenantContext(new PrismaClient(), TENANT_A_ID);

      try {
        const contacts = await tenantAPrisma.contact.findMany();
        expect(contacts).toHaveLength(2);
        expect(contacts.every((c) => c.tenantId === TENANT_A_ID)).toBe(true);
        expect(contacts.map((c) => c.email)).toEqual(
          expect.arrayContaining(['alice@tenanta.com', 'bob@tenanta.com'])
        );
      } finally {
        await tenantAPrisma.$disconnect();
      }
    });

    it('Tenant B should only see their own contacts', async () => {
      const tenantBPrisma = withTenantContext(new PrismaClient(), TENANT_B_ID);

      try {
        const contacts = await tenantBPrisma.contact.findMany();
        expect(contacts).toHaveLength(1);
        expect(contacts[0].tenantId).toBe(TENANT_B_ID);
        expect(contacts[0].email).toBe('charlie@tenantb.com');
      } finally {
        await tenantBPrisma.$disconnect();
      }
    });

    it('Tenant A count should not include Tenant B data', async () => {
      const tenantAPrisma = withTenantContext(new PrismaClient(), TENANT_A_ID);

      try {
        const count = await tenantAPrisma.contact.count();
        expect(count).toBe(2);
      } finally {
        await tenantAPrisma.$disconnect();
      }
    });

    it('Tenant B cannot update Tenant A contacts', async () => {
      const tenantBPrisma = withTenantContext(new PrismaClient(), TENANT_B_ID);

      try {
        // Try to update all contacts — should only affect Tenant B's
        const result = await tenantBPrisma.contact.updateMany({
          where: { lifecycleStage: 'active' },
          data: { segment: 'attempted-cross-tenant-update' },
        });

        // Should only update Tenant B's active contact (Charlie)
        expect(result.count).toBe(1);

        // Verify Tenant A's contacts are untouched
        const tenantAContacts = await prisma.contact.findMany({
          where: { tenantId: TENANT_A_ID, segment: 'attempted-cross-tenant-update' },
        });
        expect(tenantAContacts).toHaveLength(0);
      } finally {
        await tenantBPrisma.$disconnect();
      }
    });

    it('Tenant A create should auto-assign tenantId', async () => {
      const tenantAPrisma = withTenantContext(new PrismaClient(), TENANT_A_ID);

      try {
        const contact = await tenantAPrisma.contact.create({
          data: {
            email: 'auto-assigned@test.com',
            firstName: 'AutoAssigned',
          },
        });

        expect(contact.tenantId).toBe(TENANT_A_ID);

        // Clean up
        await prisma.contact.delete({ where: { id: contact.id } });
      } finally {
        await tenantAPrisma.$disconnect();
      }
    });
  });

  // ─── extractTenantId Tests ───────────────────────────

  describe('extractTenantId', () => {
    it('should extract tenant ID from x-tenant-id header', () => {
      const req = {
        headers: { 'x-tenant-id': TENANT_A_ID },
      };
      expect(extractTenantId(req)).toBe(TENANT_A_ID);
    });

    it('should extract tenant ID from JWT auth claims', () => {
      const req = {
        headers: {},
        auth: { tenantId: TENANT_B_ID, userId: 'user-1', role: 'admin' },
      };
      expect(extractTenantId(req)).toBe(TENANT_B_ID);
    });

    it('should prefer header over JWT when both present', () => {
      const req = {
        headers: { 'x-tenant-id': TENANT_A_ID },
        auth: { tenantId: TENANT_B_ID, userId: 'user-1', role: 'admin' },
      };
      expect(extractTenantId(req)).toBe(TENANT_A_ID);
    });

    it('should return null when no tenant context exists', () => {
      const req = { headers: {} };
      expect(extractTenantId(req)).toBeNull();
    });
  });

  // ─── Edge Cases ──────────────────────────────────────

  describe('Edge Cases', () => {
    it('withTenantContext should throw if tenantId is empty', () => {
      expect(() => {
        withTenantContext(new PrismaClient(), '');
      }).toThrow('tenantId is required');
    });

    it('should handle findMany with empty where clause', async () => {
      const middleware = tenantMiddleware(TENANT_A_ID);

      const params: any = {
        model: 'Contact',
        action: 'findMany',
        args: {},
      };

      let capturedParams: any;
      const next = async (p: any) => {
        capturedParams = p;
        return [];
      };

      await middleware(params, next);

      expect(capturedParams.args.where.tenantId).toBe(TENANT_A_ID);
    });

    it('should handle deleteMany with tenant scope', async () => {
      const middleware = tenantMiddleware(TENANT_A_ID);

      const params: any = {
        model: 'AuditLog',
        action: 'deleteMany',
        args: {
          where: { actionType: 'test' },
        },
      };

      let capturedParams: any;
      const next = async (p: any) => {
        capturedParams = p;
        return { count: 0 };
      };

      await middleware(params, next);

      expect(capturedParams.args.where.tenantId).toBe(TENANT_A_ID);
      expect(capturedParams.args.where.actionType).toBe('test');
    });
  });
});
