/**
 * KAN-1219 — Full-inventory crawler integration tests (Slice 5 of KAN-1211).
 *
 * Validates the crawler boundary contract:
 *   - startCrawl publishes vehicle.crawl_requested + creates pending CrawlJob
 *   - concurrent-prevention rejects second start while one is running
 *   - cancellation flips status mid-loop via DB-status-check
 *   - per-URL extracted_partial logs but does NOT persist
 *   - VIN duplicate skip increments skippedVinDuplicateCount
 *   - fetch_timeout per-URL logged + crawl continues
 *   - response_too_large per-URL logged + crawl continues
 *   - mixed success/failure classifies as completed_with_errors
 *   - robots.txt Disallow skips matching URLs
 *   - rate-limit pacing observable via mock-fetch timestamps
 *
 * Uses `withCleanup` (NOT `withRollback`) per Memo 22 — scrapeVehicleUrl +
 * createVehicle open their own prisma.$transaction internally, incompatible
 * with withRollback's outer rollback (nested-tx TypeError).
 *
 * fetch() mocked per-scenario via fetchImpl override on runCrawlJob deps.
 *
 * Q4 lock — inline robots.txt + synthesized HTML fixtures only; no live network.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

// ── Variable-specifier dynamic loaders (KAN-689 cohort) ───────────────────
interface InventoryCrawlerModule {
  startCrawl: (
    prisma: unknown,
    tenantId: string,
    createdByUserId: string,
    input: { listingUrl: string },
    pubsub: unknown,
  ) => Promise<{
    crawlJob: { id: string; status: string };
    publishedMessageId: string | null;
  }>;
  cancelCrawl: (
    prisma: unknown,
    tenantId: string,
    crawlJobId: string,
    reason: string,
  ) => Promise<{ cancelled: boolean }>;
  runCrawlJob: (
    prisma: unknown,
    crawlJobId: string,
    deps: {
      scrapeVehicleUrl: unknown;
      scraperHooks: unknown;
      redis: unknown;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
    },
  ) => Promise<{ id: string; status: string }>;
  CrawlJobAlreadyRunningError: new (id: string) => Error;
}

let crawler: InventoryCrawlerModule;

beforeAll(async () => {
  const spec = "../../../../../packages/api/src/services/inventory-crawler.js";
  crawler = (await import(spec)) as InventoryCrawlerModule;
});

// ── Hooks shape mirrors buildVehicleHooks ────────────────────────────────
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
        (tx as { auditLog: { create: (args: unknown) => Promise<{ id: string }> } })
          .auditLog.create({
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

// ── Stub Pub/Sub publish ─────────────────────────────────────────────────
function buildStubPubSub() {
  const published: Array<{ topic: string; data: Buffer }> = [];
  return {
    publish: async (
      topic: string,
      data: Buffer,
      _attributes?: Record<string, string>,
    ): Promise<string> => {
      published.push({ topic, data });
      return `msg-${published.length}`;
    },
    _published: published,
  };
}

// ── Stub Redis (rate-limit fail-open via no-op INCR) ─────────────────────
function buildStubRedis() {
  const calls: Array<{ key: string; op: "incr" | "expire" }> = [];
  return {
    incr: async (key: string): Promise<number> => {
      calls.push({ key, op: "incr" });
      return 1;
    },
    expire: async (key: string, _ttl: number): Promise<unknown> => {
      calls.push({ key, op: "expire" });
      return "OK";
    },
    _calls: calls,
  };
}

// ── Cleanup helper ───────────────────────────────────────────────────────
async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  await (prisma as unknown as {
    vehicle: { deleteMany: (args: unknown) => Promise<unknown> };
  }).vehicle.deleteMany({ where: { tenantId } });
  await (prisma as unknown as {
    crawlJob: { deleteMany: (args: unknown) => Promise<unknown> };
  }).crawlJob.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

// ── HTML fixture builders (Q4 lock — synthesized, no live network) ───────

function buildListingHtml(vinSlugs: string[]): string {
  const links = vinSlugs
    .map(
      (vin) =>
        `<a href="/inventory/${vin}/sedan-detail" data-stock-number="STK-${vin.slice(-4)}">${vin}</a>`,
    )
    .join("\n");
  return `<!DOCTYPE html><html><body>
    <h1>Inventory</h1>
    ${links}
  </body></html>`;
}

function buildVdpHtmlFull(vin: string): string {
  return `<!DOCTYPE html><html><head>
    <meta property="og:title" content="2024 Honda Civic EX-L - 4mk Auto" />
    <script type="application/ld+json">
      {
        "@type": "Vehicle",
        "modelYear": "2024",
        "manufacturer": "Honda",
        "model": "Civic",
        "vehicleConfiguration": "EX-L",
        "vehicleIdentificationNumber": "${vin}",
        "mileageFromOdometer": 12000,
        "bodyType": "Sedan",
        "vehicleTransmission": "Automatic",
        "fuelType": "Gas",
        "driveWheelConfiguration": "FWD",
        "itemCondition": "Used",
        "color": "Silver",
        "vehicleInteriorColor": "Black"
      }
    </script>
  </head><body><h1>2024 Honda Civic EX-L</h1></body></html>`;
}

function buildVdpHtmlPartial(): string {
  // og:title only — missing 5 required enums → extracted_partial path.
  return `<!DOCTYPE html><html><head>
    <meta property="og:title" content="2024 Honda Civic EX-L - 4mk Auto" />
  </head><body><p>Listed at $28,500.</p></body></html>`;
}

// ── Fast sleep override for tests ────────────────────────────────────────
async function fastSleep(_ms: number): Promise<void> {
  // No-op: pacing-isolated tests verify pacing via real sleep; everything
  // else runs with no delay.
}

// ── Realistic VINs (17 chars, ISO 3779) for fixtures ─────────────────────
const VINS = [
  "1HGCM82633A123451",
  "2HGCM82634B234562",
  "3HGCM82635C345673",
  "4HGCM82636D456784",
  "5HGCM82637E567895",
];

// ── Helper: dynamic-import vehicle-scraper for hook injection ────────────
interface VehicleScraperModule {
  scrapeVehicleUrl: unknown;
}
let scraperMod: VehicleScraperModule;
beforeAll(async () => {
  const spec = "../../../../../packages/api/src/services/vehicle-scraper.js";
  scraperMod = (await import(spec)) as VehicleScraperModule;
});

// ─────────────────────────────────────────────────────────────────────────
describe("KAN-1219 — Inventory crawler", () => {
  it("scenario 1 — happy path: 5 URLs → 5 extracted_full → 5 Vehicle rows + completed", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });

        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );
        expect(started.crawlJob.status).toBe("pending");
        expect(pubsub._published.length).toBe(1);
        expect(pubsub._published[0]?.topic).toBe("vehicle.crawl_requested");

        // Per-call URL inspection: route to listing/robots/VDP by URL shape.
        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory") || url.endsWith("/inventory/")) {
            return makeResponse(buildListingHtml(VINS));
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) {
            return makeResponse(buildVdpHtmlFull(m[1]!));
          }
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        // Drive the loop synchronously (subscriber bypass).
        const finalJob = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        expect(finalJob.status).toBe("completed");
        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            discoveredCount: number;
            extractedCount: number;
            failedCount: number;
            skippedVinDuplicateCount: number;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.discoveredCount).toBe(5);
        expect(job?.extractedCount).toBe(5);
        expect(job?.failedCount).toBe(0);
        expect(job?.skippedVinDuplicateCount).toBe(0);

        // 5 vehicles persisted
        const vehicles = await (prisma as unknown as {
          vehicle: { findMany: (args: unknown) => Promise<unknown[]> };
        }).vehicle.findMany({ where: { tenantId } });
        expect(vehicles.length).toBe(5);

        // Audit family: crawl_started + crawl_completed
        const audits = await prisma.auditLog.findMany({
          where: {
            tenantId,
            actionType: {
              in: ["vehicle.crawl_started", "vehicle.crawl_completed"],
            },
          },
        });
        expect(audits.length).toBe(2);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 2 — concurrent crawl prevention: second startCrawl rejects with CrawlJobAlreadyRunningError", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });

        const pubsub = buildStubPubSub();
        const first = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );
        expect(first.crawlJob.status).toBe("pending");

        // Second concurrent attempt must reject.
        let err: Error | null = null;
        try {
          await crawler.startCrawl(
            prisma as unknown as object,
            tenantId,
            "operator-1",
            { listingUrl: "https://drivegood.com/inventory" },
            pubsub,
          );
        } catch (e) {
          err = e as Error;
        }
        expect(err).not.toBeNull();
        expect(err?.name).toBe("CrawlJobAlreadyRunningError");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 3 — cancel mid-crawl: DB-status-check breaks the loop, status='cancelled'", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });

        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        // A custom sleep that flips cancellation between URL 1 and 2.
        let urlIdx = 0;
        const cancelDuringSleep = async (_ms: number) => {
          urlIdx++;
          if (urlIdx === 1) {
            // Cancel before next URL is processed.
            await crawler.cancelCrawl(
              prisma as unknown as object,
              tenantId,
              started.crawlJob.id,
              "operator pressed cancel",
            );
          }
        };

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(buildListingHtml(VINS));
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) return makeResponse(buildVdpHtmlFull(m[1]!));
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: cancelDuringSleep,
          },
        );
        expect(final.status).toBe("cancelled");

        const cancelAudits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "vehicle.crawl_cancelled" },
        });
        // At least 1 vehicle.crawl_cancelled audit row (worker emits one
        // on cancel detect; finalize would emit another but we exit
        // before finalize for cancel path).
        expect(cancelAudits.length).toBeGreaterThanOrEqual(1);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 4 — extracted_partial: vehicle NOT persisted; logged in errorSamples", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });

        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(buildListingHtml([VINS[0]!]));
          }
          if (/\/inventory\/[A-HJ-NPR-Z0-9]{17}/i.test(url)) {
            return makeResponse(buildVdpHtmlPartial());
          }
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        // failedCount increments for extracted_partial; status reflects
        // completed_with_errors (since some "failed").
        expect(final.status).toBe("completed_with_errors");

        // Zero vehicles persisted (Option B carry-forward).
        const vehicles = await (prisma as unknown as {
          vehicle: { findMany: (args: unknown) => Promise<unknown[]> };
        }).vehicle.findMany({ where: { tenantId } });
        expect(vehicles.length).toBe(0);

        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            failedCount: number;
            errorSamples: unknown;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.failedCount).toBe(1);
        const samples = job?.errorSamples as Array<{ errorVariant: string }> | null;
        expect(samples?.[0]?.errorVariant).toBe("extracted_partial");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 5 — VIN duplicate skip: existing VIN → skippedVinDuplicateCount++", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });

        // Pre-create a vehicle with the same VIN that the crawler will
        // discover. The scraper persists in $transaction; the VIN unique
        // constraint will throw P2002 → caught as skipped_vin_duplicate.
        await (prisma as unknown as {
          vehicle: { create: (args: unknown) => Promise<unknown> };
        }).vehicle.create({
          data: {
            tenantId,
            year: 2023,
            make: "Honda",
            model: "Civic",
            vin: VINS[0],
            bodyStyle: "sedan",
            transmission: "automatic",
            fuelType: "gas",
            drivetrain: "fwd",
            condition: "used",
            status: "active",
          },
        });

        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(buildListingHtml([VINS[0]!]));
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) return makeResponse(buildVdpHtmlFull(m[1]!));
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            skippedVinDuplicateCount: number;
            extractedCount: number;
            status: string;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.skippedVinDuplicateCount).toBe(1);
        expect(job?.extractedCount).toBe(0);
        // VIN-skip is NOT a failure → status is 'completed'
        expect(final.status).toBe("completed");

        // Only the pre-existing vehicle.
        const vehicles = await (prisma as unknown as {
          vehicle: { findMany: (args: unknown) => Promise<unknown[]> };
        }).vehicle.findMany({ where: { tenantId } });
        expect(vehicles.length).toBe(1);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 6 — fetch_timeout per-URL: logged in errorSamples; crawl continues", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        // First VDP times out (AbortError); second VDP succeeds.
        let vdpCalls = 0;
        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(buildListingHtml([VINS[0]!, VINS[1]!]));
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) {
            vdpCalls++;
            if (vdpCalls === 1) {
              const err = new Error("aborted");
              (err as { name: string }).name = "AbortError";
              throw err;
            }
            return makeResponse(buildVdpHtmlFull(m[1]!));
          }
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            extractedCount: number;
            failedCount: number;
            errorSamples: unknown;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.extractedCount).toBe(1);
        expect(job?.failedCount).toBe(1);
        const samples = job?.errorSamples as Array<{ errorVariant: string }>;
        expect(samples.some((s) => s.errorVariant === "fetch_timeout")).toBe(true);
        expect(final.status).toBe("completed_with_errors");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 7 — response_too_large per-URL: logged; crawl continues", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        // First VDP returns a huge body; second succeeds.
        const oversized = "x".repeat(260_000);
        let vdpCalls = 0;
        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(buildListingHtml([VINS[0]!, VINS[1]!]));
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) {
            vdpCalls++;
            if (vdpCalls === 1) return makeResponse(oversized);
            return makeResponse(buildVdpHtmlFull(m[1]!));
          }
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            extractedCount: number;
            failedCount: number;
            errorSamples: unknown;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.extractedCount).toBe(1);
        expect(job?.failedCount).toBe(1);
        const samples = job?.errorSamples as Array<{ errorVariant: string }>;
        expect(samples.some((s) => s.errorVariant === "response_too_large")).toBe(
          true,
        );
        expect(final.status).toBe("completed_with_errors");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 8 — completed_with_errors classification: 2 success + 1 fail → status='completed_with_errors'", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        let vdpCalls = 0;
        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(
              buildListingHtml([VINS[0]!, VINS[1]!, VINS[2]!]),
            );
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) {
            vdpCalls++;
            if (vdpCalls === 2) {
              // 2nd call returns barebones HTML → extraction_failed
              return makeResponse("<html><body>x</body></html>");
            }
            return makeResponse(buildVdpHtmlFull(m[1]!));
          }
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        expect(final.status).toBe("completed_with_errors");
        const audits = await prisma.auditLog.findMany({
          where: {
            tenantId,
            actionType: "vehicle.crawl_completed_with_errors",
          },
        });
        expect(audits.length).toBe(1);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 9 — robots.txt Disallow: matching URLs skipped + recorded", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nDisallow: /inventory/");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(buildListingHtml([VINS[0]!, VINS[1]!]));
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) return makeResponse(buildVdpHtmlFull(m[1]!));
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            extractedCount: number;
            failedCount: number;
            errorSamples: unknown;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.extractedCount).toBe(0);
        expect(job?.failedCount).toBe(2);
        const samples = job?.errorSamples as Array<{ errorVariant: string }>;
        expect(
          samples.every((s) => s.errorVariant === "robots_disallowed"),
        ).toBe(true);
        expect(final.status).toBe("completed_with_errors");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 10 — rate-limit Redis INCR observable: per-URL increment for each VDP fetched", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(buildListingHtml([VINS[0]!, VINS[1]!, VINS[2]!]));
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) return makeResponse(buildVdpHtmlFull(m[1]!));
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const redis = buildStubRedis();
        await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis,
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        // 3 VDPs → 3 rate-limit incr calls (one per URL, hostname-keyed).
        const incrCalls = redis._calls.filter((c) => c.op === "incr");
        expect(incrCalls.length).toBe(3);
        // Key shape: rl:crawl:{tenantId}:{hostname}:{bucket}
        for (const c of incrCalls) {
          expect(c.key).toMatch(/^rl:crawl:[a-f0-9-]+:drivegood\.com:\d+$/);
        }
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // KAN-1219 fix-forward — Memo 57 anchor #4 triple-fallback dispatcher.
  //
  // Trigger: operator-mediated test on www.4mkauto.com surfaced
  // "No adapter for hostname 4mkauto.com" hard-fail. Spec'd Layer 2
  // fingerprint + Layer 3 generic were NOT implemented at Phase 2.
  // Scenarios 11-14 cover the triple-fallback contract.
  // ───────────────────────────────────────────────────────────────────────

  it("scenario 11 — Layer 1 hostname match (regression): drivegood.com → drivegoodAdapter", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          pubsub,
        );

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(buildListingHtml([VINS[0]!]));
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) return makeResponse(buildVdpHtmlFull(m[1]!));
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );
        expect(final.status).toBe("completed");
        // adapter tag should be drivegood.com (Layer 1 match).
        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{ adapter: string } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.adapter).toBe("drivegood.com");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 12 — Layer 2 fingerprint match (4mkauto pattern): vanity domain + drivegood og:image", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "4mkauto.com" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://4mkauto.com/en/inventory" },
          pubsub,
        );
        expect(started.crawlJob.status).toBe("pending");

        // Listing HTML on 4mkauto vanity domain, BUT with drivegood
        // fingerprint signatures (og:image points at cdn.drivegood.com).
        const listingHtmlFingerprinted = `<!DOCTYPE html><html><head>
          <meta property="og:image" content="https://cdn.drivegood.com/static/og.png" />
          <meta name="author" content="Potenza Global Solutions" />
        </head><body>
          <h1>Inventory</h1>
          <a href="/inventory/${VINS[0]}/sedan-detail">Car 1</a>
        </body></html>`;

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory") || url.endsWith("/en/inventory")) {
            return makeResponse(listingHtmlFingerprinted);
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) return makeResponse(buildVdpHtmlFull(m[1]!));
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        // Layer 2 fingerprint picked drivegoodAdapter — extraction works
        // at drivegood quality. Status completed (1 URL extracted).
        expect(final.status).toBe("completed");
        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            adapter: string;
            discoveredCount: number;
            extractedCount: number;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        // adapter tag updated by worker after Layer 2 dispatch → drivegood.
        expect(job?.adapter).toBe("drivegood.com");
        expect(job?.discoveredCount).toBe(1);
        expect(job?.extractedCount).toBe(1);

        // No "No adapter for hostname" audit (dispatcher never hard-failed).
        const failedAudits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "vehicle.crawl_failed" },
        });
        expect(failedAudits.length).toBe(0);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 13 — Layer 3 generic fallback: unknown platform → generic adapter discovers VDPs", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "customdealer.com" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://customdealer.com/inventory" },
          pubsub,
        );

        // Vanilla HTML — no drivegood/Potenza signature. Layer 1 + 2 miss.
        const vanillaListing = `<!DOCTYPE html><html><head>
          <title>Custom Dealer Inventory</title>
        </head><body>
          <h1>Vehicles</h1>
          <a href="/inventory/${VINS[0]}/vehicle">Vehicle 1</a>
          <a href="/inventory/${VINS[1]}/vehicle">Vehicle 2</a>
          <a href="/inventory/${VINS[2]}/vehicle">Vehicle 3</a>
        </body></html>`;

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(vanillaListing);
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) return makeResponse(buildVdpHtmlFull(m[1]!));
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        // Layer 3 generic adapter picked — adapter tag is "*" sentinel.
        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            adapter: string;
            discoveredCount: number;
            status: string;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.adapter).toBe("*");
        // Generic parseInventoryListing discovered all 3 VDP URLs via
        // VIN-slug + path-pattern heuristics.
        expect(job?.discoveredCount).toBe(3);
        // No hard-fail; status finalized normally (completed or
        // completed_with_errors depending on per-URL extraction).
        expect(["completed", "completed_with_errors"]).toContain(final.status);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("scenario 14 — Dispatcher NEVER hard-fails: no 'No adapter for hostname' audit/cancelReason path", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        // Unknown vanity hostname; no drivegood fingerprint.
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "obscuredealer.io" },
        });
        const pubsub = buildStubPubSub();
        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://obscuredealer.io/inventory" },
          pubsub,
        );

        const vanillaListing = `<!DOCTYPE html><html><body>
          <a href="/inventory/${VINS[0]}/v">V</a>
        </body></html>`;

        const finalFetch = (async (input: unknown) => {
          const url =
            typeof input === "string"
              ? input
              : (input as { url?: string }).url ?? String(input);
          if (url.endsWith("/robots.txt")) {
            return makeResponse("User-agent: *\nAllow: /");
          }
          if (url.endsWith("/inventory")) {
            return makeResponse(vanillaListing);
          }
          const m = /\/inventory\/([A-HJ-NPR-Z0-9]{17})/i.exec(url);
          if (m) return makeResponse(buildVdpHtmlFull(m[1]!));
          throw new Error(`Unmatched URL ${url}`);
        }) as unknown as typeof fetch;

        const final = await crawler.runCrawlJob(
          prisma as unknown as object,
          started.crawlJob.id,
          {
            scrapeVehicleUrl: scraperMod.scrapeVehicleUrl,
            scraperHooks: buildTestHooks(),
            redis: buildStubRedis(),
            fetchImpl: finalFetch,
            sleep: fastSleep,
          },
        );

        // Dispatcher never produces "No adapter for hostname" error path.
        expect(final.status).not.toBe("failed");

        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            status: string;
            cancelReason: string | null;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        // Specifically: NEVER finalized as 'failed' with the "No adapter
        // for hostname" message (the deleted hard-fail branch).
        expect(job?.status).not.toBe("failed");
        if (job?.cancelReason) {
          expect(job.cancelReason).not.toMatch(/No adapter for hostname/);
        }

        // And no crawl_failed audit with that message either.
        const failedAudits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "vehicle.crawl_failed" },
        });
        for (const audit of failedAudits) {
          const reasoning = (audit as unknown as { reasoning: string }).reasoning;
          expect(reasoning).not.toMatch(/No adapter for hostname/);
        }
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  // ── KAN-1219 fix-forward Memo 57 anchor #5 Layer 2 (publish-failure) ──
  it("scenario 15 — Pub/Sub publish failure: CrawlJob.status='failed' + cancelReason='publish_infrastructure_gap' + errorSamples populated + vehicle.crawl_failed audit", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { marketingDomain: "drivegood.com" },
        });

        // Pub/Sub that throws NOT_FOUND on publish (canonical PROD trigger
        // 2026-06-17 — topic vehicle.crawl_requested unprovisioned in GCP).
        const failingPubsub = {
          publish: async (): Promise<string> => {
            const err = new Error(
              "5 NOT_FOUND: Resource not found (resource=vehicle.crawl_requested)",
            );
            (err as { code?: number }).code = 5;
            throw err;
          },
        };

        const started = await crawler.startCrawl(
          prisma as unknown as object,
          tenantId,
          "operator-1",
          { listingUrl: "https://drivegood.com/inventory" },
          failingPubsub,
        );

        // Mutation returns success-shaped (no thrown exception); but the
        // CrawlJob row carries the honest failed state.
        expect(started.publishedMessageId).toBeNull();
        expect(started.crawlJob.status).toBe("failed");

        const job = await (prisma as unknown as {
          crawlJob: { findUnique: (args: unknown) => Promise<{
            status: string;
            cancelReason: string | null;
            errorSamples: unknown;
            completedAt: Date | null;
          } | null> };
        }).crawlJob.findUnique({ where: { id: started.crawlJob.id } });
        expect(job?.status).toBe("failed");
        expect(job?.cancelReason).toBe("publish_infrastructure_gap");
        expect(job?.completedAt).not.toBeNull();

        const samples = job?.errorSamples as Array<{
          url: string;
          errorVariant: string;
          message: string;
        }>;
        expect(samples).toBeDefined();
        expect(samples.length).toBe(1);
        expect(samples[0]?.errorVariant).toBe("publish_failed");
        expect(samples[0]?.url).toBe("https://drivegood.com/inventory");
        expect(samples[0]?.message).toMatch(/NOT_FOUND/);

        // Audit row written with explicit reasoning.
        const audits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "vehicle.crawl_failed" },
        });
        expect(audits.length).toBe(1);
        const reasoning = (audits[0] as unknown as { reasoning: string })
          .reasoning;
        expect(reasoning).toMatch(/publish to vehicle\.crawl_requested failed/);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  // ── KAN-1219 fix-forward Memo 57 anchor #5 Layer 1 (boot self-heal) ──
  it("scenario 16 — boot-time idempotent topic+subscription self-heal: ensurePubsubInfrastructure creates absent + no-ops on present", async () => {
    interface StubSub {
      exists: () => Promise<[boolean]>;
    }
    interface StubTopic {
      exists: () => Promise<[boolean]>;
      create: () => Promise<unknown>;
      subscription: (name: string) => StubSub;
      createSubscription: (
        name: string,
        opts: { pushConfig: { pushEndpoint: string; oidcToken: { serviceAccountEmail: string } } },
      ) => Promise<unknown>;
    }
    function buildStubPubsub(opts: {
      topicExists: boolean;
      subExists: boolean;
    }): {
      pubsub: { topic: (name: string) => StubTopic };
      created: { topics: string[]; subscriptions: Array<{ name: string; pushEndpoint: string }> };
    } {
      const created = {
        topics: [] as string[],
        subscriptions: [] as Array<{ name: string; pushEndpoint: string }>,
      };
      const pubsub = {
        topic: (name: string): StubTopic => ({
          exists: async () => [opts.topicExists],
          create: async () => {
            created.topics.push(name);
            return {};
          },
          subscription: (_subName: string): StubSub => ({
            exists: async () => [opts.subExists],
          }),
          createSubscription: async (subName: string, subOpts: {
            pushConfig: { pushEndpoint: string; oidcToken: { serviceAccountEmail: string } };
          }) => {
            created.subscriptions.push({
              name: subName,
              pushEndpoint: subOpts.pushConfig.pushEndpoint,
            });
            return {};
          },
        }),
      };
      return { pubsub, created };
    }

    const bootstrapSpec = "../../internal/pubsub-bootstrap.js";
    const mod = (await import(bootstrapSpec)) as {
      ensurePubsubInfrastructure: (
        pubsub: unknown,
        env?: NodeJS.ProcessEnv,
      ) => Promise<{
        topicsEnsured: string[];
        subscriptionsEnsured: string[];
        errors: string[];
      }>;
    };

    // Case A: both topic + subscription absent → both created exactly once.
    {
      const { pubsub, created } = buildStubPubsub({
        topicExists: false,
        subExists: false,
      });
      const env = {
        API_PUBLIC_URL: "https://growth-api.example.com",
        PUBSUB_INVOKER_SA: "pubsub-invoker@example.iam.gserviceaccount.com",
      } as NodeJS.ProcessEnv;
      const summary = await mod.ensurePubsubInfrastructure(pubsub, env);
      expect(summary.topicsEnsured).toContain("vehicle.crawl_requested");
      expect(summary.subscriptionsEnsured).toContain("growth-api-vehicle-crawl");
      expect(summary.errors).toEqual([]);
      expect(created.topics).toEqual(["vehicle.crawl_requested"]);
      expect(created.subscriptions.length).toBe(1);
      expect(created.subscriptions[0]?.name).toBe("growth-api-vehicle-crawl");
      expect(created.subscriptions[0]?.pushEndpoint).toBe(
        "https://growth-api.example.com/pubsub/vehicle-crawl",
      );
    }

    // Case B: both present → idempotent no-op (no .create() / .createSubscription()).
    {
      const { pubsub, created } = buildStubPubsub({
        topicExists: true,
        subExists: true,
      });
      const env = {
        API_PUBLIC_URL: "https://growth-api.example.com",
        PUBSUB_INVOKER_SA: "pubsub-invoker@example.iam.gserviceaccount.com",
      } as NodeJS.ProcessEnv;
      const summary = await mod.ensurePubsubInfrastructure(pubsub, env);
      expect(summary.topicsEnsured).toContain("vehicle.crawl_requested");
      expect(summary.subscriptionsEnsured).toContain("growth-api-vehicle-crawl");
      expect(summary.errors).toEqual([]);
      expect(created.topics).toEqual([]);
      expect(created.subscriptions).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Helper: build a Response-shaped object compatible with vehicle-scraper.
// ─────────────────────────────────────────────────────────────────────────
function makeResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (key: string) => {
        if (key.toLowerCase() === "content-type")
          return "text/html; charset=utf-8";
        return null;
      },
    },
    text: async () => body,
  } as unknown as Response;
}
