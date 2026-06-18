/**
 * KAN-1219 (Slice 5 of KAN-1211 epic) — vehicle.crawl_requested push subscriber.
 *
 * Mirrors decision-run-push.ts shape (Memo 39 anchor #11) — single load-bearing
 * Pub/Sub push subscriber precedent in the codebase. Consumes the event
 * published by startCrawl() inside the vehiclesRouter.startCrawl tRPC procedure
 * and drives the crawler worker loop (runCrawlJob).
 *
 * # Hard guards (Memo 39 / decision-run-push.ts:497 precedent)
 *
 * Before driving the worker, the consumer asserts the CrawlJob row exists +
 * belongs to the tenantId in the message + is still in 'pending' state.
 * Operator cancellation between publish + delivery flips the row to
 * 'cancelled'; the consumer observes that and exits.
 *
 * # Idempotency
 *
 * Pub/Sub at-least-once delivery means redelivery is possible. runCrawlJob()
 * is responsible for idempotency via the status='pending' check (a row that's
 * already 'running' / 'completed' / 'cancelled' / 'failed' short-circuits).
 *
 * # Error classification
 *
 * Unlike decision-run-push (which classifies persistent vs transient + routes
 * to DLQ), this V1 always ack-200 on error to avoid a retry storm against
 * a parse bug. CrawlJob row carries the failure state (status='failed' +
 * cancelReason). Future hardening: classify Redis/network as transient,
 * parse/shape as persistent.
 */

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { verifyPubsubOidc } from "../lib/oidc-pubsub-verify.js";
import { getRedisClient } from "../services/redis-client.js";

// ─────────────────────────────────────────────
// Variable-specifier loaders (KAN-689 cohort) — cross-rootDir to packages/api
// ─────────────────────────────────────────────

interface InventoryCrawlerModule {
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
  ) => Promise<unknown>;
}
let _crawlerModule: InventoryCrawlerModule | null = null;
async function loadCrawlerModule(): Promise<InventoryCrawlerModule> {
  if (_crawlerModule) return _crawlerModule;
  const spec = "../../../../packages/api/src/services/inventory-crawler.js";
  _crawlerModule = (await import(spec)) as InventoryCrawlerModule;
  return _crawlerModule;
}

interface VehicleScraperModule {
  scrapeVehicleUrl: unknown;
}
let _scraperModule: VehicleScraperModule | null = null;
async function loadScraperModule(): Promise<VehicleScraperModule> {
  if (_scraperModule) return _scraperModule;
  const spec = "../../../../packages/api/src/services/vehicle-scraper.js";
  _scraperModule = (await import(spec)) as VehicleScraperModule;
  return _scraperModule;
}

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const CrawlRequestedEventSchema = z.object({
  tenantId: z.string().uuid(),
  crawlJobId: z.string().uuid(),
  listingUrl: z.string().url(),
});

// ─────────────────────────────────────────────
// Hooks builder — mirror buildVehicleHooks() shape from router.ts
// (the crawler's scraper invocation needs the same AuditLog writer).
// ─────────────────────────────────────────────

function buildCrawlerHooks() {
  return {
    auditLog: {
      writeInTx: async (
        tx: { auditLog: { create: (args: unknown) => Promise<{ id: string }> } },
        payload: {
          tenantId: string;
          actor: string;
          actionType: string;
          payload: Record<string, unknown>;
          reasoning: string;
        },
      ): Promise<{ id: string }> =>
        tx.auditLog.create({
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

// ─────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────

export const vehicleCrawlPushApp = new Hono();

vehicleCrawlPushApp.post("/vehicle-crawl", async (c) => {
  if (!(await verifyPubsubOidc(c))) {
    return c.text("unauthorized", 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error(
      `[vehicle-crawl-push] malformed envelope: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text("ok", 200);
  }

  let event: z.infer<typeof CrawlRequestedEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, "base64").toString("utf8");
    event = CrawlRequestedEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error(
      `[vehicle-crawl-push] malformed event: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text("ok", 200);
  }

  // ── HARD GUARD: CrawlJob row exists + tenant-scoped + still pending ──
  const job = await prisma.crawlJob.findFirst({
    where: { id: event.crawlJobId, tenantId: event.tenantId },
    select: { id: true, status: true },
  });
  if (!job) {
    console.log(
      JSON.stringify({
        type: "vehicle_crawl_guard_rejected",
        reason: "crawl_job_not_found",
        tenantId: event.tenantId,
        crawlJobId: event.crawlJobId,
        messageId: envelope.message.messageId,
      }),
    );
    return c.text("ok", 200);
  }

  if (job.status !== "pending") {
    // Idempotency: row already advanced (running, completed, cancelled,
    // failed). Pub/Sub redelivery short-circuits here. Same posture as
    // decision-run-push guard rejection.
    console.log(
      JSON.stringify({
        type: "vehicle_crawl_guard_rejected",
        reason: "crawl_job_not_pending",
        actualStatus: job.status,
        tenantId: event.tenantId,
        crawlJobId: event.crawlJobId,
        messageId: envelope.message.messageId,
      }),
    );
    return c.text("ok", 200);
  }

  // ── ALL GUARDS PASSED — drive the worker loop ────────────────────────
  try {
    const crawler = await loadCrawlerModule();
    const scraper = await loadScraperModule();
    const result = await crawler.runCrawlJob(prisma, event.crawlJobId, {
      scrapeVehicleUrl: scraper.scrapeVehicleUrl,
      scraperHooks: buildCrawlerHooks(),
      redis: getRedisClient(),
    });
    console.log(
      JSON.stringify({
        type: "vehicle_crawl_dispatched",
        tenantId: event.tenantId,
        crawlJobId: event.crawlJobId,
        messageId: envelope.message.messageId,
        finalStatus: (result as { status?: string })?.status ?? "unknown",
      }),
    );
    return c.text("ok", 200);
  } catch (err) {
    // V1 — always ack 200 on error. CrawlJob row's status carries the
    // failure state. Future hardening: persistent vs transient classify.
    console.error(
      JSON.stringify({
        type: "vehicle_crawl_handler_error",
        tenantId: event.tenantId,
        crawlJobId: event.crawlJobId,
        messageId: envelope.message.messageId,
        error: err instanceof Error ? err.message : String(err),
        stack:
          err instanceof Error ? err.stack?.split("\n").slice(0, 5).join(" | ") : undefined,
      }),
    );
    // Best-effort: try to mark the job as failed so the operator sees
    // the failure state (the worker may not have got that far).
    try {
      await prisma.crawlJob.updateMany({
        where: {
          id: event.crawlJobId,
          tenantId: event.tenantId,
          status: { in: ["pending", "running"] },
        },
        data: {
          status: "failed",
          completedAt: new Date(),
          cancelReason: `handler error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    } catch (updateErr) {
      console.error(
        `[vehicle-crawl-push] failed to mark job failed: ${(updateErr as Error)?.message ?? String(updateErr)}`,
      );
    }
    return c.text("ok", 200);
  }
});
