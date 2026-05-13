/**
 * KAN-903 — Staging tables schema sanity tests.
 *
 * Schema-only PR; these tests pin the structural contract of the four
 * import-staging tables landed by Cohort 2.5 (PR 3/8). They exercise:
 *
 *   1. Default insert — only the 4 required cols (importJobId, tenantId,
 *      sourceRowIndex, sourceRowData) + auto-default `stagingStatus =
 *      'pending'`.
 *   2. Full mirror insert — every typed column populated.
 *   3. `@@unique([importJobId, sourceRowIndex])` enforcement per table.
 *   4. `ON DELETE CASCADE` from ImportJob — deleting the parent drops
 *      its staging rows across all 4 tables.
 *   5. `tenantId` FK — staging rows require a valid Tenant.
 *   6. `StagingStatus` enum — rejects unknown values.
 *
 * Follows the orphan harness pattern of tenant-isolation.test.ts.
 * packages/db has no active vitest runner today; the load-bearing CI
 * validation for this PR is `prisma migrate diff --exit-code` +
 * TypeScript typecheck (both wired in CI). KAN-692 will give
 * packages/db its own runner alongside packages/api.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const TENANT_ID = 'test-tenant-kan903-staging-001';
const OTHER_TENANT_ID = 'test-tenant-kan903-staging-002';
const USER_ID = 'test-user-kan903-staging-001';
const IMPORT_JOB_ID = 'test-importjob-kan903-staging-001';

async function cleanup() {
  // Order matters — staging FKs CASCADE on ImportJob delete, but tenant
  // delete needs staging gone first (RESTRICT on tenantId).
  await prisma.importStagingContact.deleteMany({
    where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } },
  });
  await prisma.importStagingCompany.deleteMany({
    where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } },
  });
  await prisma.importStagingDeal.deleteMany({
    where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } },
  });
  await prisma.importStagingOrder.deleteMany({
    where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } },
  });
  await prisma.importJob.deleteMany({
    where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } },
  });
  await prisma.user.deleteMany({
    where: { id: USER_ID },
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: [TENANT_ID, OTHER_TENANT_ID] } },
  });
}

describe('KAN-903 — Staging tables schema', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.tenant.create({
      data: { id: TENANT_ID, name: 'KAN-903 Test', slug: 'kan-903-test' },
    });
    await prisma.user.create({
      data: { id: USER_ID, tenantId: TENANT_ID, email: 'kan903@test.com' },
    });
    await prisma.importJob.create({
      data: {
        id: IMPORT_JOB_ID,
        tenantId: TENANT_ID,
        createdByUserId: USER_ID,
        fileName: 'test.csv',
        fileSize: 100,
        fileMimeType: 'text/csv',
        gcsObjectPath: `tenants/${TENANT_ID}/imports/${IMPORT_JOB_ID}/test.csv`,
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // ─── (1) Default-insert sanity ────────────────────────────

  it('ImportStagingContact — minimal insert defaults stagingStatus=pending', async () => {
    const row = await prisma.importStagingContact.create({
      data: {
        importJobId: IMPORT_JOB_ID,
        tenantId: TENANT_ID,
        sourceRowIndex: 1,
        sourceRowData: { email: 'a@test.com' } as Prisma.InputJsonValue,
      },
    });
    expect(row.stagingStatus).toBe('pending');
    expect(row.matchDecision).toBeNull();
    expect(row.targetContactId).toBeNull();
    expect(row.email).toBeNull(); // mirror cols default to null
    await prisma.importStagingContact.delete({ where: { id: row.id } });
  });

  it('ImportStagingCompany — minimal insert defaults stagingStatus=pending', async () => {
    const row = await prisma.importStagingCompany.create({
      data: {
        importJobId: IMPORT_JOB_ID,
        tenantId: TENANT_ID,
        sourceRowIndex: 2,
        sourceRowData: { name: 'Acme' } as Prisma.InputJsonValue,
      },
    });
    expect(row.stagingStatus).toBe('pending');
    expect(row.targetCompanyId).toBeNull();
    expect(row.domain).toBeNull();
    await prisma.importStagingCompany.delete({ where: { id: row.id } });
  });

  it('ImportStagingDeal — minimal insert defaults stagingStatus=pending', async () => {
    const row = await prisma.importStagingDeal.create({
      data: {
        importJobId: IMPORT_JOB_ID,
        tenantId: TENANT_ID,
        sourceRowIndex: 3,
        sourceRowData: { name: 'Test Deal' } as Prisma.InputJsonValue,
      },
    });
    expect(row.stagingStatus).toBe('pending');
    expect(row.targetDealId).toBeNull();
    expect(row.pipelineName).toBeNull();
    expect(row.stageName).toBeNull();
    expect(row.contactEmail).toBeNull();
    await prisma.importStagingDeal.delete({ where: { id: row.id } });
  });

  it('ImportStagingOrder — minimal insert defaults stagingStatus=pending', async () => {
    const row = await prisma.importStagingOrder.create({
      data: {
        importJobId: IMPORT_JOB_ID,
        tenantId: TENANT_ID,
        sourceRowIndex: 4,
        sourceRowData: { orderNumber: 'INV-1' } as Prisma.InputJsonValue,
      },
    });
    expect(row.stagingStatus).toBe('pending');
    expect(row.targetOrderId).toBeNull();
    expect(row.orderNumber).toBeNull();
    expect(row.providerOrderId).toBeNull();
    await prisma.importStagingOrder.delete({ where: { id: row.id } });
  });

  // ─── (2) Full-mirror insert ───────────────────────────────

  it('ImportStagingContact — full mirror cols round-trip', async () => {
    const row = await prisma.importStagingContact.create({
      data: {
        importJobId: IMPORT_JOB_ID,
        tenantId: TENANT_ID,
        sourceRowIndex: 10,
        sourceRowData: {} as Prisma.InputJsonValue,
        email: 'full@test.com',
        phone: '+15555550001',
        firstName: 'Full',
        lastName: 'Mirror',
        companyName: 'Mirror Co',
        lifecycleStage: 'mql',
        source: 'csv_import',
      },
    });
    expect(row.email).toBe('full@test.com');
    expect(row.lifecycleStage).toBe('mql');
    expect(row.source).toBe('csv_import');
    await prisma.importStagingContact.delete({ where: { id: row.id } });
  });

  it('ImportStagingDeal — full mirror cols round-trip (raw resolution fields)', async () => {
    const row = await prisma.importStagingDeal.create({
      data: {
        importJobId: IMPORT_JOB_ID,
        tenantId: TENANT_ID,
        sourceRowIndex: 11,
        sourceRowData: {} as Prisma.InputJsonValue,
        name: 'Big Deal',
        value: '12345.67',
        currency: 'USD',
        status: 'open',
        expectedCloseDate: new Date('2026-06-30'),
        contactEmail: 'buyer@test.com',
        companyName: 'Buyer Co',
        pipelineName: 'Sales',
        stageName: 'Negotiation',
      },
    });
    expect(row.name).toBe('Big Deal');
    expect(row.value?.toString()).toBe('12345.67');
    expect(row.pipelineName).toBe('Sales');
    expect(row.stageName).toBe('Negotiation');
    expect(row.contactEmail).toBe('buyer@test.com');
    await prisma.importStagingDeal.delete({ where: { id: row.id } });
  });

  // ─── (3) Unique constraint enforcement ────────────────────

  it('rejects duplicate (importJobId, sourceRowIndex) on the same staging table', async () => {
    await prisma.importStagingContact.create({
      data: {
        importJobId: IMPORT_JOB_ID,
        tenantId: TENANT_ID,
        sourceRowIndex: 20,
        sourceRowData: {} as Prisma.InputJsonValue,
      },
    });
    await expect(
      prisma.importStagingContact.create({
        data: {
          importJobId: IMPORT_JOB_ID,
          tenantId: TENANT_ID,
          sourceRowIndex: 20,
          sourceRowData: {} as Prisma.InputJsonValue,
        },
      }),
    ).rejects.toThrow(/Unique constraint/i);
    await prisma.importStagingContact.deleteMany({
      where: { importJobId: IMPORT_JOB_ID, sourceRowIndex: 20 },
    });
  });

  // ─── (4) CASCADE on ImportJob delete ──────────────────────

  it('deleting an ImportJob cascades to all 4 staging tables', async () => {
    const job = await prisma.importJob.create({
      data: {
        id: 'test-importjob-kan903-cascade',
        tenantId: TENANT_ID,
        createdByUserId: USER_ID,
        fileName: 'cascade.csv',
        fileSize: 1,
        fileMimeType: 'text/csv',
        gcsObjectPath: 'cascade',
      },
    });
    await prisma.importStagingContact.create({
      data: {
        importJobId: job.id,
        tenantId: TENANT_ID,
        sourceRowIndex: 0,
        sourceRowData: {} as Prisma.InputJsonValue,
      },
    });
    await prisma.importStagingCompany.create({
      data: {
        importJobId: job.id,
        tenantId: TENANT_ID,
        sourceRowIndex: 0,
        sourceRowData: {} as Prisma.InputJsonValue,
      },
    });
    await prisma.importStagingDeal.create({
      data: {
        importJobId: job.id,
        tenantId: TENANT_ID,
        sourceRowIndex: 0,
        sourceRowData: {} as Prisma.InputJsonValue,
      },
    });
    await prisma.importStagingOrder.create({
      data: {
        importJobId: job.id,
        tenantId: TENANT_ID,
        sourceRowIndex: 0,
        sourceRowData: {} as Prisma.InputJsonValue,
      },
    });

    await prisma.importJob.delete({ where: { id: job.id } });

    for (const m of [
      'importStagingContact',
      'importStagingCompany',
      'importStagingDeal',
      'importStagingOrder',
    ] as const) {
      const remaining = await (prisma[m] as any).count({
        where: { importJobId: job.id },
      });
      expect(remaining).toBe(0);
    }
  });

  // ─── (5) tenantId FK ──────────────────────────────────────

  it('rejects insert with a non-existent tenantId', async () => {
    await expect(
      prisma.importStagingContact.create({
        data: {
          importJobId: IMPORT_JOB_ID,
          tenantId: 'tenant-that-does-not-exist',
          sourceRowIndex: 30,
          sourceRowData: {} as Prisma.InputJsonValue,
        },
      }),
    ).rejects.toThrow(/Foreign key constraint/i);
  });

  // ─── (6) StagingStatus enum coercion ──────────────────────

  it('rejects unknown StagingStatus values', async () => {
    await expect(
      prisma.importStagingContact.create({
        data: {
          importJobId: IMPORT_JOB_ID,
          tenantId: TENANT_ID,
          sourceRowIndex: 40,
          sourceRowData: {} as Prisma.InputJsonValue,
          // @ts-expect-error — runtime check that invalid enum value is rejected.
          stagingStatus: 'totally_invalid',
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts all 6 valid StagingStatus values', async () => {
    const statuses = [
      'pending',
      'mapping_error',
      'dedup_error',
      'ready',
      'committed',
      'skipped',
    ] as const;
    const created = [];
    for (let i = 0; i < statuses.length; i++) {
      const row = await prisma.importStagingContact.create({
        data: {
          importJobId: IMPORT_JOB_ID,
          tenantId: TENANT_ID,
          sourceRowIndex: 50 + i,
          sourceRowData: {} as Prisma.InputJsonValue,
          stagingStatus: statuses[i],
        },
      });
      expect(row.stagingStatus).toBe(statuses[i]);
      created.push(row.id);
    }
    await prisma.importStagingContact.deleteMany({
      where: { id: { in: created } },
    });
  });
});
