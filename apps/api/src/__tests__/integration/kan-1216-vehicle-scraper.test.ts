/**
 * KAN-1216 — Vehicle scraper service integration tests (Slice 4 of KAN-1211).
 *
 * Validates the scraper boundary contract sealed by the KAN-1219 sibling
 * (product-scraper.ts) + KAN-1217 H3 subdomain-match precedent. 7 scenarios
 * per Phase 1 lock + Memo 46 sub-cat 6 calibration:
 *
 *   1. schema_org_full — full JSON-LD extract → extracted_full + AuditLog
 *   2. og_title_year_make_model — partial og:* extract → extracted_partial (NO persist; Option B fix-forward)
 *   3. hostname_mismatch — input URL hostname rejection
 *   4. fetch_timeout — AbortError surfaces as fetch_timeout
 *   5. response_too_large — 250KB body cap rejection
 *   6. extraction_failed — barebones HTML, generic h1, no ld+json
 *   7. drivegood_adapter — URL VIN pattern extraction wins over body text
 *
 * Uses `withCleanup` (NOT `withRollback`) — same rationale as KAN-1219:
 * scrapeVehicleUrl opens prisma.$transaction internally, which conflicts
 * with withRollback's outer rollback (nested-tx TypeError).
 *
 * fetch() is mocked per-scenario via a fetchImpl parameter override —
 * cleaner than vi.stubGlobal across module boundaries (the service signature
 * accepts fetchImpl as the 6th arg specifically for testability).
 *
 * Service module loaded via variable-specifier dynamic import (KAN-689 cohort).
 *
 * Q4 lock — synthesized fixtures only; no live network in CI.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

// ── Variable-specifier dynamic loader ─────────────────────────────────────
interface VehicleScraperServiceModule {
  scrapeVehicleUrl: (
    prisma: unknown,
    tenantId: string,
    input: { url: string },
    actor: string,
    hooks: unknown,
    fetchImpl?: typeof fetch,
  ) => Promise<ScrapeResult>;
}

interface ExtractedVehicleFieldsMirror {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  vin: string | null;
  mileage: number | null;
  bodyStyle: string | null;
  transmission: string | null;
  fuelType: string | null;
  drivetrain: string | null;
  condition: string | null;
  exteriorColor: string | null;
  interiorColor: string | null;
  stockNumber: string | null;
  dealerLot: string | null;
}

type ScrapeResult =
  | { kind: "extracted_full"; vehicleId: string }
  | {
      kind: "extracted_partial";
      extractedFields: ExtractedVehicleFieldsMirror;
      extractGaps: string[];
    }
  | { kind: "tenant_marketing_domain_not_configured" }
  | { kind: "hostname_mismatch"; hostname: string; configuredDomain: string }
  | { kind: "fetch_timeout" }
  | { kind: "response_too_large"; maxBytes: number; actualBytes: number }
  | { kind: "extraction_failed"; reason: string };

let svc: VehicleScraperServiceModule;

beforeAll(async () => {
  const spec = "../../../../../packages/api/src/services/vehicle-scraper.js";
  svc = (await import(spec)) as VehicleScraperServiceModule;
});

// ── Test hooks (mirror buildProductHooks shape from KAN-1219) ─────────────
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

// ── Cleanup: FK order Vehicle → AuditLog → Tenant ─────────────────────────
async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  await (prisma as unknown as { vehicle: { deleteMany: (args: unknown) => Promise<unknown> } })
    .vehicle.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

// ── Mock fetch builder — returns a fetch-like that yields a single response ─
function buildMockFetch(
  html: string,
  options: { status?: number; contentType?: string } = {},
): typeof fetch {
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

// ── Sample HTML fixtures (Q4 — synthesized, no live network) ──────────────

const SCHEMA_ORG_FULL_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta property="og:title" content="2024 Honda Civic EX-L - 4mk Auto" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Vehicle",
        "name": "2024 Honda Civic",
        "modelYear": "2024",
        "manufacturer": "Honda",
        "model": "Civic",
        "vehicleConfiguration": "EX-L",
        "vehicleIdentificationNumber": "1HGCM82633A123456",
        "mileageFromOdometer": { "value": 12000, "unitCode": "SMI" },
        "bodyType": "Sedan",
        "vehicleTransmission": "Automatic",
        "fuelType": "Gas",
        "driveWheelConfiguration": "FWD",
        "itemCondition": "Used",
        "color": "Silver",
        "vehicleInteriorColor": "Black"
      }
    </script>
  </head>
  <body><h1>2024 Honda Civic EX-L</h1></body>
</html>`;

const OG_TITLE_PARTIAL_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta property="og:title" content="2024 Honda Civic EX-L - 4mk Auto" />
    <meta property="og:site_name" content="4mk Auto" />
  </head>
  <body><p>Listed at $28,500 — call dealer for details.</p></body>
</html>`;

const BAREBONES_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Inventory</title></head>
  <body><h1>Inventory</h1><p>Browse our selection.</p></body>
</html>`;

const DRIVEGOOD_ADAPTER_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta property="og:title" content="2024 Honda Civic EX-L" />
    <script type="application/ld+json">
      {
        "@type": "Vehicle",
        "modelYear": "2024",
        "manufacturer": "Honda",
        "model": "Civic",
        "vehicleConfiguration": "EX-L",
        "bodyType": "Sedan",
        "vehicleTransmission": "Automatic",
        "fuelType": "Gas",
        "driveWheelConfiguration": "FWD",
        "itemCondition": "Used"
      }
    </script>
  </head>
  <body>
    <h1>2024 Honda Civic EX-L</h1>
    <div data-stock-number="STK-12345">Stock #STK-12345</div>
  </body>
</html>`;

describe("KAN-1216 — Vehicle scraper service", () => {
  it("scenario 1 — schema.org JSON-LD full extract → extracted_full + AuditLog written", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "4mkauto.com" },
        });

        const result = await svc.scrapeVehicleUrl(
          prisma as unknown as object,
          tenantId,
          { url: "https://4mkauto.com/inventory/civic-ex-l" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(SCHEMA_ORG_FULL_HTML),
        );

        expect(result.kind).toBe("extracted_full");
        if (result.kind !== "extracted_full") throw new Error("type narrow");

        const vehicle = await (prisma as unknown as {
          vehicle: {
            findUnique: (args: unknown) => Promise<{
              id: string;
              year: number;
              make: string;
              model: string;
              vin: string | null;
              bodyStyle: string;
              transmission: string;
              fuelType: string;
              drivetrain: string;
              condition: string;
              status: string;
            } | null>;
          };
        }).vehicle.findUnique({ where: { id: result.vehicleId } });

        expect(vehicle?.status).toBe("active");
        expect(vehicle?.year).toBe(2024);
        expect(vehicle?.make).toBe("Honda");
        expect(vehicle?.model).toBe("Civic");
        expect(vehicle?.vin).toBe("1HGCM82633A123456");
        expect(vehicle?.bodyStyle).toBe("sedan");
        expect(vehicle?.transmission).toBe("automatic");
        expect(vehicle?.fuelType).toBe("gas");
        expect(vehicle?.drivetrain).toBe("fwd");
        expect(vehicle?.condition).toBe("used");

        // Memo 53 — vehicle.scraped action_type provenance (4th sibling of
        // product.* family). Operational analytics need row-level
        // distinguishability between operator-created and scraper-created
        // vehicles.
        const audits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "vehicle.scraped" },
        });
        expect(audits.length).toBe(1);
        const payload = audits[0]?.payload as {
          vehicleId: string;
          externalUrl: string;
          extractGaps: string[];
        };
        expect(payload.vehicleId).toBe(result.vehicleId);
        expect(payload.externalUrl).toBe("https://4mkauto.com/inventory/civic-ex-l");
        expect(payload.extractGaps).toEqual([]);

        // Negative assertion — no vehicle.created rows leaked.
        const createdAudits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "vehicle.created" },
        });
        expect(createdAudits.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 2 — og:title partial extract → extracted_partial returns fields without persisting (Option B)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "4mkauto.com" },
        });

        const result = await svc.scrapeVehicleUrl(
          prisma as unknown as object,
          tenantId,
          { url: "https://4mkauto.com/inventory/civic" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(OG_TITLE_PARTIAL_HTML),
        );

        expect(result.kind).toBe("extracted_partial");
        if (result.kind !== "extracted_partial") throw new Error("type narrow");

        // KAN-1216 fix-forward (Option B): partial extract does NOT persist
        // because the Vehicle Prisma model requires NON-nullable enums.
        // Operator completes via /settings/inventory Create form.
        const vehicles = await (prisma as unknown as {
          vehicle: {
            findMany: (args: unknown) => Promise<Array<{ id: string }>>;
          };
        }).vehicle.findMany({ where: { tenantId } });
        expect(vehicles.length).toBe(0);

        // og:title stripSiteSuffix removes "- 4mk Auto"; remaining year/make/model
        // parse: "2024 Honda Civic EX-L" → year=2024 make=Honda model=Civic trim=EX-L
        expect(result.extractedFields.year).toBe(2024);
        expect(result.extractedFields.make).toBe("Honda");
        expect(result.extractedFields.model).toBe("Civic");

        // All 5 enum fields + VIN should be in extractGaps (no JSON-LD,
        // no body text providing enums).
        expect(result.extractGaps).toEqual(
          expect.arrayContaining([
            "bodyStyle",
            "transmission",
            "fuelType",
            "drivetrain",
            "condition",
            "vin",
          ]),
        );
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 3 — hostname_mismatch when URL host differs from marketingDomain", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "4mkauto.com" },
        });

        const result = await svc.scrapeVehicleUrl(
          prisma as unknown as object,
          tenantId,
          { url: "https://competitor.com/inventory/v1" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(SCHEMA_ORG_FULL_HTML), // should never be called
        );

        expect(result.kind).toBe("hostname_mismatch");
        if (result.kind !== "hostname_mismatch") throw new Error("type narrow");
        expect(result.hostname).toBe("competitor.com");
        expect(result.configuredDomain).toBe("4mkauto.com");

        // No vehicle persisted, no AuditLog row.
        const vehicles = await (prisma as unknown as {
          vehicle: { findMany: (args: unknown) => Promise<unknown[]> };
        }).vehicle.findMany({ where: { tenantId } });
        expect(vehicles.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 4 — fetch_timeout when fetch raises AbortError", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "4mkauto.com" },
        });

        const result = await svc.scrapeVehicleUrl(
          prisma as unknown as object,
          tenantId,
          { url: "https://4mkauto.com/inventory/slow" },
          "operator-1",
          buildTestHooks(),
          buildAbortingFetch(),
        );

        expect(result.kind).toBe("fetch_timeout");
        const vehicles = await (prisma as unknown as {
          vehicle: { findMany: (args: unknown) => Promise<unknown[]> };
        }).vehicle.findMany({ where: { tenantId } });
        expect(vehicles.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 5 — response_too_large when body exceeds 200KB cap", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "4mkauto.com" },
        });

        const oversize = "x".repeat(250 * 1024);

        const result = await svc.scrapeVehicleUrl(
          prisma as unknown as object,
          tenantId,
          { url: "https://4mkauto.com/inventory/huge" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(oversize),
        );

        expect(result.kind).toBe("response_too_large");
        if (result.kind !== "response_too_large") throw new Error("type narrow");
        expect(result.maxBytes).toBe(200 * 1024);
        expect(result.actualBytes).toBeGreaterThanOrEqual(200 * 1024);

        const vehicles = await (prisma as unknown as {
          vehicle: { findMany: (args: unknown) => Promise<unknown[]> };
        }).vehicle.findMany({ where: { tenantId } });
        expect(vehicles.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 6 — extraction_failed when no parseable vehicle structure", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "4mkauto.com" },
        });

        const result = await svc.scrapeVehicleUrl(
          prisma as unknown as object,
          tenantId,
          { url: "https://4mkauto.com/inventory/page" },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(BAREBONES_HTML),
        );

        expect(result.kind).toBe("extraction_failed");
        const vehicles = await (prisma as unknown as {
          vehicle: { findMany: (args: unknown) => Promise<unknown[]> };
        }).vehicle.findMany({ where: { tenantId } });
        expect(vehicles.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 7 — drivegood adapter extracts VIN from URL pattern", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        // drivegood.com tenant for adapter dispatch.
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });

        // URL matches DRIVEGOOD_VIN_URL_PATTERN: /inventory/{VIN}/{slug}.
        const result = await svc.scrapeVehicleUrl(
          prisma as unknown as object,
          tenantId,
          {
            url: "https://drivegood.com/inventory/1HGCM82633A123456/2024-honda-civic",
          },
          "operator-1",
          buildTestHooks(),
          buildMockFetch(DRIVEGOOD_ADAPTER_HTML),
        );

        expect(result.kind).toBe("extracted_full");
        if (result.kind !== "extracted_full") throw new Error("type narrow");

        const vehicle = await (prisma as unknown as {
          vehicle: {
            findUnique: (args: unknown) => Promise<{
              vin: string | null;
              stockNumber: string | null;
              make: string;
              model: string;
            } | null>;
          };
        }).vehicle.findUnique({ where: { id: result.vehicleId } });

        // VIN from URL pattern (regex match), uppercased per J3 contract.
        expect(vehicle?.vin).toBe("1HGCM82633A123456");
        // Adapter parseStockNumber pulled from data-stock-number attribute.
        expect(vehicle?.stockNumber).toBe("STK-12345");
        expect(vehicle?.make).toBe("Honda");
        expect(vehicle?.model).toBe("Civic");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });
});
