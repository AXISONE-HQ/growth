/**
 * KAN-1219 — Product scraper service integration tests (Slice 5 of KAN-1212).
 *
 * Validates the scraper boundary contract sealed by the M4 doctrine sibling
 * (product-service.ts) + KAN-1217 H3 subdomain-match deferral. 6 scenarios
 * per Phase 1 lock + Memo 46 sub-cat 6 calibration:
 *
 *   1. Happy path — full extract → status='active' + AuditLog written
 *   2. Domain rejection — input URL hostname mismatch → domain_not_allowed
 *   3. Subdomain accepted — store.example.com on example.com tenant → scraped
 *   4. Fetch failure (timeout) — AbortError surfaces as fetch_failed
 *   5. Response cap exceeded — 250KB body → response_too_large
 *   6. Partial extract → draft — only name extracted; rest missing →
 *      isScrapeSuccess=false + extractGaps[] + status='draft'
 *
 * Uses `withCleanup` (NOT `withRollback`) — same rationale as KAN-1216b:
 * scrapeProduct opens prisma.$transaction internally via createProduct,
 * which conflicts with withRollback's outer rollback (nested-tx TypeError).
 *
 * fetch() is mocked per-scenario via a fetchImpl parameter override —
 * cleaner than vi.stubGlobal across module boundaries (the service signature
 * accepts fetchImpl as the 6th arg specifically for testability).
 *
 * Service module loaded via variable-specifier dynamic import (KAN-689 cohort).
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant, getPrisma } from "./setup.js";

// ── Variable-specifier dynamic loader ─────────────────────────────────────
interface ProductScraperServiceModule {
  scrapeProduct: (
    prisma: unknown,
    tenantId: string,
    input: { url: string },
    actor: string,
    hooks: unknown,
    fetchImpl?: typeof fetch,
  ) => Promise<ScrapeResult>;
  hostnameMatches: (input: string, configured: string) => boolean;
}

type ScrapeResult =
  | { kind: "scraped"; productId: string; isScrapeSuccess: boolean; extractGaps: string[] }
  | { kind: "domain_not_allowed"; hostname: string; configuredDomain: string }
  | { kind: "fetch_failed"; reason: string }
  | { kind: "parse_failed"; reason: string }
  | { kind: "response_too_large"; maxBytes: number; actualBytes: number }
  | { kind: "tenant_marketing_domain_not_configured" };

let svc: ProductScraperServiceModule;

beforeAll(async () => {
  const spec = "../../../../../packages/api/src/services/product-scraper.js";
  svc = (await import(spec)) as ProductScraperServiceModule;
});

// ── Test hooks (mirror buildProductHooks in router.ts) ────────────────────
function buildTestHooks() {
  return {
    auditLog: {
      writeInTx: async (
        tx: unknown,
        payload: {
          tenantId: string;
          actor: string;
          actionType: string;
          payload: Record<string, unknown>;
          reasoning: string;
        },
      ): Promise<{ id: string }> =>
        (tx as { auditLog: { create: (args: unknown) => Promise<{ id: string }> } }).auditLog.create({
          data: {
            tenantId: payload.tenantId,
            actor: payload.actor,
            actionType: payload.actionType,
            payload: payload.payload,
            reasoning: payload.reasoning,
          },
        }),
    },
  };
}

// ── Cleanup: FK order Product → AuditLog → Tenant ─────────────────────────
async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  await (prisma as unknown as { product: { deleteMany: (args: unknown) => Promise<unknown> } })
    .product.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

// ── Mock fetch builder — returns a fetch-like that yields a single response ─
function buildMockFetch(html: string, options: { status?: number; contentType?: string } = {}): typeof fetch {
  return (async () => {
    return {
      ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
      status: options.status ?? 200,
      headers: {
        get: (key: string) => {
          if (key.toLowerCase() === "content-type") return options.contentType ?? "text/html; charset=utf-8";
          return null;
        },
      },
      text: async () => html,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function buildAbortingFetch(): typeof fetch {
  return (async () => {
    const err = new Error("The operation was aborted");
    (err as { name: string }).name = "AbortError";
    throw err;
  }) as unknown as typeof fetch;
}

// ── Full-extract sample HTML (all 4 fields present) ───────────────────────
const FULL_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta property="og:title" content="Premium Widget" />
    <meta property="og:description" content="A high-quality widget for all your widgeting needs." />
    <meta property="og:image" content="https://example.com/widget.jpg" />
  </head>
  <body>
    <h1>Premium Widget</h1>
    <p>Listed at $49.99 — limited stock.</p>
  </body>
</html>
`;

// ── Partial-extract sample HTML (only h1 name present) ────────────────────
const PARTIAL_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Bare Page</title></head>
  <body><h1>Bare Widget</h1></body>
</html>
`;

describe("KAN-1219 — Product scraper service", () => {
  it("happy path — full extract → status='active' + AuditLog written", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "example.com" },
        });

        const result = await svc.scrapeProduct(
          prisma as unknown as object,
          tenantId,
          { url: "https://example.com/products/widget" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(FULL_HTML),
        );

        expect(result.kind).toBe("scraped");
        if (result.kind !== "scraped") throw new Error("type narrow");
        expect(result.isScrapeSuccess).toBe(true);
        expect(result.extractGaps).toEqual([]);

        const product = await (prisma as unknown as {
          product: { findUnique: (args: unknown) => Promise<{ id: string; status: string; name: string; price: unknown } | null> };
        }).product.findUnique({ where: { id: result.productId } });
        expect(product?.status).toBe("active");
        expect(product?.name).toBe("Premium Widget");

        // Memo 53 — scraper-origin audit_log row carries product.scraped
        // (NOT product.created). Provenance distinguishability is mandatory
        // per the dual-audit-type discipline (Memo 32 family + KAN-1190 J7).
        const audits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "product.scraped" },
        });
        expect(audits.length).toBe(1);
        // Also assert payload carries scraper-specific fields.
        const audit = audits[0];
        const payload = audit?.payload as { productId: string; externalUrl: string; extractGaps: string[] };
        expect(payload.productId).toBe(result.productId);
        expect(payload.externalUrl).toBe("https://example.com/product/widget");
        expect(payload.extractGaps).toEqual([]);

        // Negative assertion: no product.created rows leaked.
        const createdAudits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "product.created" },
        });
        expect(createdAudits.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("domain rejection — competitor.com URL on example.com tenant → domain_not_allowed", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "example.com" },
        });

        const result = await svc.scrapeProduct(
          prisma as unknown as object,
          tenantId,
          { url: "https://competitor.com/products/rival" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(FULL_HTML), // should never be called
        );

        expect(result.kind).toBe("domain_not_allowed");
        if (result.kind !== "domain_not_allowed") throw new Error("type narrow");
        expect(result.hostname).toBe("competitor.com");
        expect(result.configuredDomain).toBe("example.com");

        // No product persisted, no AuditLog row.
        const products = await (prisma as unknown as {
          product: { findMany: (args: unknown) => Promise<unknown[]> };
        }).product.findMany({ where: { tenantId } });
        expect(products.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("subdomain accepted — store.example.com on example.com tenant → scraped", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "example.com" },
        });

        const result = await svc.scrapeProduct(
          prisma as unknown as object,
          tenantId,
          { url: "https://store.example.com/products/widget" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(FULL_HTML),
        );

        expect(result.kind).toBe("scraped");

        // Sanity-check the helper directly (KAN-1217 H3 boundary invariant).
        expect(svc.hostnameMatches("store.example.com", "example.com")).toBe(true);
        expect(svc.hostnameMatches("EXAMPLE.com", "example.com")).toBe(true);
        expect(svc.hostnameMatches("notexample.com", "example.com")).toBe(false);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("fetch failure (timeout / AbortError) → fetch_failed", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "example.com" },
        });

        const result = await svc.scrapeProduct(
          prisma as unknown as object,
          tenantId,
          { url: "https://example.com/slow-page" },
          "operator-1",
          buildTestHooks(),
          buildAbortingFetch(),
        );

        expect(result.kind).toBe("fetch_failed");
        if (result.kind !== "fetch_failed") throw new Error("type narrow");
        expect(result.reason).toBe("timeout");

        const products = await (prisma as unknown as {
          product: { findMany: (args: unknown) => Promise<unknown[]> };
        }).product.findMany({ where: { tenantId } });
        expect(products.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("response cap exceeded — 250KB body → response_too_large", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "example.com" },
        });

        // 250KB of ASCII filler — 250 * 1024 bytes > 200KB cap.
        const oversize = "x".repeat(250 * 1024);

        const result = await svc.scrapeProduct(
          prisma as unknown as object,
          tenantId,
          { url: "https://example.com/huge-page" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(oversize),
        );

        expect(result.kind).toBe("response_too_large");
        if (result.kind !== "response_too_large") throw new Error("type narrow");
        expect(result.maxBytes).toBe(200 * 1024);
        expect(result.actualBytes).toBeGreaterThanOrEqual(200 * 1024);

        const products = await (prisma as unknown as {
          product: { findMany: (args: unknown) => Promise<unknown[]> };
        }).product.findMany({ where: { tenantId } });
        expect(products.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("partial extract — only name → isScrapeSuccess=false + status='draft' + extractGaps", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "example.com" },
        });

        const result = await svc.scrapeProduct(
          prisma as unknown as object,
          tenantId,
          { url: "https://example.com/products/bare" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(PARTIAL_HTML),
        );

        expect(result.kind).toBe("scraped");
        if (result.kind !== "scraped") throw new Error("type narrow");
        expect(result.isScrapeSuccess).toBe(false);
        expect(result.extractGaps).toEqual(
          expect.arrayContaining(["price", "description", "primaryImageUrl"]),
        );

        const product = await (prisma as unknown as {
          product: { findUnique: (args: unknown) => Promise<{ id: string; status: string; name: string; customFields: unknown } | null> };
        }).product.findUnique({ where: { id: result.productId } });
        expect(product?.status).toBe("draft");
        expect(product?.name).toBe("Bare Widget");
        const cf = product?.customFields as { extractGaps?: string[] } | null;
        expect(cf?.extractGaps).toEqual(
          expect.arrayContaining(["price", "description", "primaryImageUrl"]),
        );
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });
});
