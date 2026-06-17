/**
 * KAN-1217 — Tenant marketing domain config (Slice 3 of KAN-1212 epic).
 *
 * Validates the Prisma-layer behavior + audit-log contract that the
 * settingsRouter.setMarketingDomain mutation wraps:
 *   1. Fresh tenant default — marketingDomain is null until configured.
 *   2. URL → plaintext hostname extraction (lowercased) via new URL(input).hostname.
 *   3. Round-trip — getMarketingDomain returns what setMarketingDomain stored.
 *   4. AuditLog row written with actionType="tenant.marketing_domain_updated".
 *   5. Cross-tenant isolation — tenant B's marketingDomain stays null.
 *
 * Uses `withCleanup` (NOT `withRollback`) per
 * `integration_test_isolation_pattern_must_match_service_tx_shape` memo —
 * the mutation opens its own $transaction at the router layer.
 *
 * Tests the Prisma-level behavior + audit contract directly (NOT the tRPC
 * caller layer) — same shape as kan-1216d-category-crud.test.ts. The audit
 * action_type is a plain string (NOT in AuditActionType enum, per H6 lock).
 */
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

describe("KAN-1217 — Tenant marketing domain config", () => {
  it("setMarketingDomain extracts hostname + persists + writes AuditLog; round-trips; null default on fresh tenant; cross-tenant isolation", async () => {
    let tenantA = "";
    let tenantB = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const a = await createTenant(prisma);
        const b = await createTenant(prisma);
        tenantA = a.id;
        tenantB = b.id;

        // (1) Fresh tenant — marketingDomain default = null
        const freshA = await prisma.tenant.findUnique({
          where: { id: tenantA },
          select: { marketingDomain: true },
        });
        expect(freshA?.marketingDomain).toBeNull();

        // (2) Simulate setMarketingDomain — extract hostname + update + audit in tx
        const hostname = new URL("https://STORE.tenantA.example.com/products").hostname.toLowerCase();
        await prisma.$transaction(async (tx) => {
          await tx.tenant.update({
            where: { id: tenantA },
            data: { marketingDomain: hostname },
          });
          await tx.auditLog.create({
            data: {
              tenantId: tenantA,
              actor: "operator-A",
              actionType: "tenant.marketing_domain_updated",
              payload: { marketingDomain: hostname },
              reasoning: "tenant.marketing_domain_updated",
            },
          });
        });

        // (3) Round-trip — stored value is lowercased plain hostname (no protocol/path)
        const after = await prisma.tenant.findUnique({
          where: { id: tenantA },
          select: { marketingDomain: true },
        });
        expect(after?.marketingDomain).toBe("store.tenanta.example.com");

        // (4) AuditLog row written with the H6 plain-string action_type
        const audits = await prisma.auditLog.findMany({
          where: { tenantId: tenantA, actionType: "tenant.marketing_domain_updated" },
        });
        expect(audits.length).toBe(1);
        expect(audits[0]?.actor).toBe("operator-A");
        expect((audits[0]?.payload as { marketingDomain: string }).marketingDomain).toBe(
          "store.tenanta.example.com",
        );

        // (5) Cross-tenant isolation — tenant B's marketingDomain remains null
        const isolatedB = await prisma.tenant.findUnique({
          where: { id: tenantB },
          select: { marketingDomain: true },
        });
        expect(isolatedB?.marketingDomain).toBeNull();
      },
      async (prisma: PrismaClient) => {
        await prisma.auditLog.deleteMany({
          where: { tenantId: { in: [tenantA, tenantB] } },
        });
        await prisma.tenant.deleteMany({
          where: { id: { in: [tenantA, tenantB] } },
        });
      },
    );
  });
});
