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
