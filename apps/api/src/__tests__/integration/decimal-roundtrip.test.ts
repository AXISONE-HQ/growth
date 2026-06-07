/**
 * Prisma Decimal write-path round-trip regression lock.
 *
 * Sibling to KAN-851 (display-side regression: Service.price.toFixed crash
 * because Prisma serializes Decimal columns as strings). KAN-851 added a
 * static-grep regression test for the DISPLAY side; this test locks the
 * WRITE-PATH round-trip: Prisma.Decimal → Postgres NUMERIC(12,2) →
 * read-back must round-trip cleanly without precision loss.
 *
 * Per KAN-1112 doctrine (every $queryRaw* site exercises real Postgres)
 * + 13th memo (sentinel tests for backend behavior must exercise real
 * backend, not mock) + `feedback_prisma_decimal_serializes_as_string.md`
 * memo (banked from KAN-851).
 *
 * Audited 2026-06-07 per KAN-1132 PR 2.
 *
 * Q1 lock: **Prisma-direct round-trip** (no tRPC chain). Step 0 confirmed
 * no superjson transformer is registered — Prisma.Decimal serializes
 * natively to JSON string at the tRPC boundary, so exercising the Prisma
 * → Postgres → Prisma path covers the entire round-trip surface. Adding
 * tRPC harness wiring would add zero new failure-mode coverage.
 *
 * Schema reality: both Deal.value and Order's 4 money columns are
 * `@db.Decimal(12, 2)`. Max storable value: 9,999,999,999.99.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  createContact,
  createDeal,
  createOrder,
  createPipeline,
  createTenant,
  withRollback,
} from './setup.js';

/** Asserts that a Prisma.Decimal value (returned from the DB) equals the
 * given expected value (string or number). Uses Decimal#equals for the
 * canonical comparison; falls back to a string-equality check for the
 * explicit format assertion when needed. */
function expectDecimalEquals(actual: Prisma.Decimal, expected: string | number): void {
  expect(actual.equals(new Prisma.Decimal(expected))).toBe(true);
}

describe('KAN-1132 PR 2 — Prisma Decimal write-path round-trip', () => {
  // ──────────────────────────────────────────────────────────────────
  // deals.create — 5 tests covering the canonical write-path edge cases
  // ──────────────────────────────────────────────────────────────────
  describe('deals.create — Deal.value @db.Decimal(12, 2)', () => {
    it('round-trips a standard 2-decimal value (12345.67) without precision loss', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const pipeline = await createPipeline(prisma, tenant.id);
        const deal = await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 12345.67,
        });

        const readBack = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
        expectDecimalEquals(readBack.value, '12345.67');
      });
    });

    it('round-trips zero (0.00) without coercion to null', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const pipeline = await createPipeline(prisma, tenant.id);
        const deal = await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 0,
        });

        const readBack = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
        expect(readBack.value).not.toBeNull();
        expectDecimalEquals(readBack.value, '0.00');
      });
    });

    it('round-trips a small value (0.01) at the column precision boundary', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const pipeline = await createPipeline(prisma, tenant.id);
        const deal = await prisma.deal.create({
          data: {
            tenantId: tenant.id,
            contactId: contact.id,
            pipelineId: pipeline.id,
            currentStageId: pipeline.stageId,
            value: new Prisma.Decimal('0.01'),
          },
          select: { id: true },
        });

        const readBack = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
        expectDecimalEquals(readBack.value, '0.01');
      });
    });

    it('round-trips a near-maximum value (9999999999.99) without overflow', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const pipeline = await createPipeline(prisma, tenant.id);
        const deal = await prisma.deal.create({
          data: {
            tenantId: tenant.id,
            contactId: contact.id,
            pipelineId: pipeline.id,
            currentStageId: pipeline.stageId,
            // 10 digits before decimal — the @db.Decimal(12, 2) upper bound.
            value: new Prisma.Decimal('9999999999.99'),
          },
          select: { id: true },
        });

        const readBack = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
        expectDecimalEquals(readBack.value, '9999999999.99');
      });
    });

    it('rejects overflow values exceeding @db.Decimal(12, 2) at the Postgres NUMERIC layer', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const pipeline = await createPipeline(prisma, tenant.id);

        // 1e10 = 10_000_000_000 — exceeds the 10-digit pre-decimal cap.
        // Postgres rejects with NUMERIC field overflow (SQLSTATE 22003).
        await expect(
          prisma.deal.create({
            data: {
              tenantId: tenant.id,
              contactId: contact.id,
              pipelineId: pipeline.id,
              currentStageId: pipeline.stageId,
              value: new Prisma.Decimal('10000000000.00'),
            },
          }),
        ).rejects.toThrow();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // deals.update — 2 tests covering mutation round-trip + non-monetary mutation
  // ──────────────────────────────────────────────────────────────────
  describe('deals.update — Deal.value mutation', () => {
    it('round-trips a value mutation (100.00 → 250.50) without precision loss', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const pipeline = await createPipeline(prisma, tenant.id);
        const deal = await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 100,
        });

        await prisma.deal.update({
          where: { id: deal.id },
          data: { value: new Prisma.Decimal('250.50') },
        });

        const readBack = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
        expectDecimalEquals(readBack.value, '250.50');
      });
    });

    it('preserves Decimal value when mutating a non-monetary field (status)', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const pipeline = await createPipeline(prisma, tenant.id);
        const deal = await createDeal(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stageId,
          value: 999.99,
        });

        await prisma.deal.update({
          where: { id: deal.id },
          data: { status: 'won' },
        });

        const readBack = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
        expectDecimalEquals(readBack.value, '999.99');
        expect(readBack.status).toBe('won');
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // orders.create — 5 tests covering the 4-column round-trip + edges
  // ──────────────────────────────────────────────────────────────────
  describe('orders.create — Order 4 Decimal columns @db.Decimal(12, 2)', () => {
    it('round-trips standard 2-decimal values across all 4 money columns', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const order = await createOrder(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          totalAmount: '1000.00',
          taxAmount: '85.50',
          discountAmount: '50.00',
          grandTotal: '1035.50',
        });

        const readBack = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expectDecimalEquals(readBack.totalAmount, '1000.00');
        expectDecimalEquals(readBack.taxAmount, '85.50');
        expectDecimalEquals(readBack.discountAmount, '50.00');
        expectDecimalEquals(readBack.grandTotal, '1035.50');
      });
    });

    it('round-trips zero across all 4 columns (Decimal default behavior)', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        // No money overrides — relies on schema defaults (Decimal @default(0)).
        const order = await createOrder(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
        });

        const readBack = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expectDecimalEquals(readBack.totalAmount, '0.00');
        expectDecimalEquals(readBack.taxAmount, '0.00');
        expectDecimalEquals(readBack.discountAmount, '0.00');
        expectDecimalEquals(readBack.grandTotal, '0.00');
      });
    });

    it('round-trips mixed small (0.01) and large (9999999999.99) values across columns', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const order = await createOrder(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          totalAmount: '9999999999.99',
          taxAmount: '0.01',
          discountAmount: '0.02',
          grandTotal: '9999999999.98',
        });

        const readBack = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expectDecimalEquals(readBack.totalAmount, '9999999999.99');
        expectDecimalEquals(readBack.taxAmount, '0.01');
        expectDecimalEquals(readBack.discountAmount, '0.02');
        expectDecimalEquals(readBack.grandTotal, '9999999999.98');
      });
    });

    it('rejects overflow on grandTotal (1e10) at the Postgres NUMERIC layer', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);

        await expect(
          createOrder(prisma, {
            tenantId: tenant.id,
            contactId: contact.id,
            grandTotal: '10000000000.00',
          }),
        ).rejects.toThrow();
      });
    });

    it('round-trips when initialized with `number` typed input (vs Prisma.Decimal class instance)', async () => {
      // Tests Prisma's input type coercion — number arg gets converted to
      // Decimal at the boundary; read-back is still Prisma.Decimal.
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const order = await createOrder(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          totalAmount: 1234.56,
          taxAmount: 100,
          discountAmount: 0,
          grandTotal: 1334.56,
        });

        const readBack = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expectDecimalEquals(readBack.totalAmount, '1234.56');
        expectDecimalEquals(readBack.taxAmount, '100.00');
        expectDecimalEquals(readBack.discountAmount, '0.00');
        expectDecimalEquals(readBack.grandTotal, '1334.56');
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // orders.update — 2 tests covering mutation round-trip
  // ──────────────────────────────────────────────────────────────────
  describe('orders.update — Order Decimal mutation', () => {
    it('round-trips a grandTotal mutation (1000.00 → 1500.25) without precision loss', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const order = await createOrder(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
          grandTotal: '1000.00',
        });

        await prisma.order.update({
          where: { id: order.id },
          data: { grandTotal: new Prisma.Decimal('1500.25') },
        });

        const readBack = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expectDecimalEquals(readBack.grandTotal, '1500.25');
      });
    });

    it('round-trips a simultaneous mutation across all 4 Decimal columns', async () => {
      await withRollback(async (prisma) => {
        const tenant = await createTenant(prisma);
        const contact = await createContact(prisma, tenant.id);
        const order = await createOrder(prisma, {
          tenantId: tenant.id,
          contactId: contact.id,
        });

        await prisma.order.update({
          where: { id: order.id },
          data: {
            totalAmount: new Prisma.Decimal('500.00'),
            taxAmount: new Prisma.Decimal('40.00'),
            discountAmount: new Prisma.Decimal('25.50'),
            grandTotal: new Prisma.Decimal('514.50'),
          },
        });

        const readBack = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expectDecimalEquals(readBack.totalAmount, '500.00');
        expectDecimalEquals(readBack.taxAmount, '40.00');
        expectDecimalEquals(readBack.discountAmount, '25.50');
        expectDecimalEquals(readBack.grandTotal, '514.50');
      });
    });
  });
});
