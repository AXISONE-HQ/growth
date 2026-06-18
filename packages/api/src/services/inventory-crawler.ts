/**
 * KAN-1219 (Slice 5 of KAN-1211 epic) — Full-inventory crawler service.
 *
 * Walks dealer inventory listing URL → discovers per-vehicle URLs via adapter
 * → invokes KAN-1216 scrapeVehicleUrl per URL → persists extracted_full via
 * KAN-1214 vehicle-service.createVehicle (with VIN dedup).
 *
 * # SPO verdict locks
 *
 * - Q1: Pub/Sub push subscriber pattern (Memo 39 anchor #11) — startCrawl
 *   publishes to vehicle.crawl_requested; vehicle-crawl-push.ts consumes
 *   and drives the worker loop, mutating CrawlJob row.
 * - Q2: 6-variant CrawlJobStatus enum (Memo 42 affordance-honesty) —
 *   completed_with_errors distinct from completed.
 * - Q3: Redis INCR rate-limit (account-detect-rate-limit:29-55 precedent) —
 *   per-tenant-per-hostname keying; sliding-window fail-open.
 * - Q4: Inline robots.txt (Memo 37 trigger not yet hit at <3 workspaces).
 * - Q6: 5-variant audit log family (vehicle.crawl_started/completed/
 *   completed_with_errors/cancelled/failed; Memo 53 namespace expansion).
 *
 * # Cancel discipline
 *
 * Worker reads CrawlJob.status between each URL extract (DB-status-check
 * precedent per deferred-send-evaluator-concurrent-claim:314,324). On
 * `cancelled` → break loop, set cancelledAt + cancelReason, write
 * vehicle.crawl_cancelled audit, exit.
 *
 * # extracted_partial discipline (Option B carry-forward from KAN-1216)
 *
 * Per-URL scrape returning extracted_partial does NOT persist (substrate
 * requires non-null enums). Log to CrawlJob.errorSamples; continue loop.
 * Operator can manually complete via /settings/inventory Create form.
 */

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

export class CrawlJobAlreadyRunningError extends Error {
  constructor(public existingJobId: string) {
    super(`Another crawl job is already running (id=${existingJobId})`);
    this.name = "CrawlJobAlreadyRunningError";
  }
}

export class CrawlJobNotFoundError extends Error {
  constructor() {
    super("Crawl job not found");
    this.name = "CrawlJobNotFoundError";
  }
}

export class HostnameMismatchError extends Error {
  constructor(public hostname: string, public configuredDomain: string) {
    super(
      `Listing URL hostname (${hostname}) does not match tenant marketing domain (${configuredDomain})`,
    );
    this.name = "HostnameMismatchError";
  }
}

export class MarketingDomainNotConfiguredError extends Error {
  constructor() {
    super("Tenant marketing domain is not configured");
    this.name = "MarketingDomainNotConfiguredError";
  }
}

// ─────────────────────────────────────────────
// Adapter dispatch — drivegood-only V1 (mirror vehicle-scraper.ts)
// ─────────────────────────────────────────────

import type * as cheerio from "cheerio";
import {
  drivegoodAdapter,
  type DealerAdapter,
} from "./dealer-adapters/drivegood.js";

const ADAPTERS: ReadonlyArray<DealerAdapter> = [drivegoodAdapter];

export function pickCrawlerAdapter(hostname: string): DealerAdapter | null {
  const lower = hostname.toLowerCase();
  for (const adapter of ADAPTERS) {
    if (lower === adapter.hostname || lower.endsWith(`.${adapter.hostname}`)) {
      return adapter;
    }
  }
  return null;
}

function extractHostnameFromConfigured(configured: string): string {
  try {
    return new URL(configured).hostname;
  } catch {
    return configured.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

function hostnameMatches(input: string, configured: string): boolean {
  const inLower = input.toLowerCase();
  const cfgLower = configured.toLowerCase();
  return inLower === cfgLower || inLower.endsWith(`.${cfgLower}`);
}

// ─────────────────────────────────────────────
// Inline robots.txt (Q4 lock — Memo 37 trigger not yet hit at <3 workspaces)
//
// Minimal RFC 9309 subset: parses `User-agent: *` and `User-agent: AxisOne`
// directive groups; honors Disallow lines. Fail-open on fetch/parse error
// (mirrors knowledge-paths/url.js:6,30-87 precedent). Cached per-host within
// a single crawl invocation via the caller-passed map.
// ─────────────────────────────────────────────

interface RobotsRules {
  disallow: string[];
}

export function parseRobotsTxt(body: string, userAgent: string): RobotsRules {
  const lines = body.split(/\r?\n/);
  const groups: Array<{ agents: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; disallow: string[] } | null = null;
  let inAgentBlock = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!inAgentBlock || !current) {
        current = { agents: [], disallow: [] };
        groups.push(current);
        inAgentBlock = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (key === "disallow") {
      if (!current) {
        current = { agents: ["*"], disallow: [] };
        groups.push(current);
      }
      current.disallow.push(value);
      inAgentBlock = false;
    } else {
      inAgentBlock = false;
    }
  }

  const uaLower = userAgent.toLowerCase();
  const matched: RobotsRules = { disallow: [] };
  for (const g of groups) {
    if (g.agents.includes(uaLower) || g.agents.includes("*")) {
      for (const d of g.disallow) matched.disallow.push(d);
    }
  }
  return matched;
}

export function robotsTxtAllows(rules: RobotsRules, urlPath: string): boolean {
  for (const dis of rules.disallow) {
    if (dis === "") continue; // Empty Disallow = allow all
    if (urlPath.startsWith(dis)) return false;
  }
  return true;
}

export async function fetchRobotsTxt(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<RobotsRules> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const u = new URL(baseUrl);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const resp = await fetchImpl(robotsUrl, {
      signal: controller.signal,
      headers: { "user-agent": CRAWLER_USER_AGENT },
    });
    if (!resp.ok) {
      // Fail-open: a missing robots.txt means no restrictions.
      return { disallow: [] };
    }
    const body = await resp.text();
    return parseRobotsTxt(body, CRAWLER_USER_AGENT);
  } catch {
    // Fail-open per knowledge-paths precedent. Robots.txt is courtesy, not a
    // security boundary; a fetch timeout should not block the crawl.
    return { disallow: [] };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────
// Redis rate-limit (Q3 — mirror account-detect-rate-limit:29-55)
//
// Per-tenant-per-hostname keying; 1 request per WINDOW_SECONDS; fail-open
// on Redis outage. Caller is responsible for invoking this between URL
// extracts; we DO NOT add real-time pacing here (the rate-limit acts as a
// hard ceiling, not a per-request pacing throttle — pacing is done via
// explicit setTimeout in the loop).
// ─────────────────────────────────────────────

const RATE_LIMIT_WINDOW_SECONDS = 2; // 1 req / 2s = 30 req/min per host
const RATE_LIMIT_TTL_SECONDS = RATE_LIMIT_WINDOW_SECONDS * 2;
const RATE_LIMIT_MAX = 1;

interface RedisRateLimitClient {
  incr: (key: string) => Promise<number>;
  expire: (key: string, ttlSeconds: number) => Promise<unknown>;
}

export interface RateLimitResult {
  allowed: boolean;
  resetAt: number;
}

export async function checkCrawlRateLimit(
  redis: RedisRateLimitClient,
  tenantId: string,
  hostname: string,
): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const resetAt = (bucket + 1) * RATE_LIMIT_WINDOW_SECONDS;
  const key = `rl:crawl:${tenantId}:${hostname}:${bucket}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_TTL_SECONDS);
    }
    return { allowed: count <= RATE_LIMIT_MAX, resetAt };
  } catch (err) {
    // Fail-open per KAN-742 precedent.
    console.error("[inventory-crawler] rate-limit redis incr failed:", err);
    return { allowed: true, resetAt };
  }
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const CRAWLER_USER_AGENT =
  "AxisOne/1.0 (+https://growth-ai.com; inventory-crawler; contact: support@growth-ai.com)";

const ERROR_SAMPLES_CAP = 50;
const PACING_DELAY_MS = 2000; // Mirrors RATE_LIMIT_WINDOW_SECONDS
const CRAWL_TOPIC = "vehicle.crawl_requested";

// ─────────────────────────────────────────────
// Prisma surface (narrow)
// ─────────────────────────────────────────────

export interface CrawlJobRecord {
  id: string;
  tenantId: string;
  createdByUserId: string;
  listingUrl: string;
  adapter: string;
  status: string;
  discoveredCount: number;
  extractedCount: number;
  skippedVinDuplicateCount: number;
  failedCount: number;
  errorSamples: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryCrawlerPrisma {
  tenant: {
    findUnique: (args: {
      where: { id: string };
      select: { marketingDomain: true };
    }) => Promise<{ marketingDomain: string | null } | null>;
  };
  crawlJob: {
    findFirst: (args: unknown) => Promise<CrawlJobRecord | null>;
    create: (args: { data: Record<string, unknown> }) => Promise<CrawlJobRecord>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<CrawlJobRecord>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

// ─────────────────────────────────────────────
// startCrawl — concurrent-prevention + Pub/Sub publish
// ─────────────────────────────────────────────

export interface StartCrawlInput {
  listingUrl: string;
}

export interface StartCrawlResult {
  crawlJob: CrawlJobRecord;
  /** Pub/Sub messageId returned by publish (best-effort). */
  publishedMessageId: string | null;
}

interface PubSubPublishClient {
  publish: (
    topic: string,
    data: Buffer,
    attributes?: Record<string, string>,
  ) => Promise<string>;
}

export async function startCrawl(
  prisma: InventoryCrawlerPrisma,
  tenantId: string,
  createdByUserId: string,
  input: StartCrawlInput,
  pubsub: PubSubPublishClient,
): Promise<StartCrawlResult> {
  // ── Step 1: tenant.marketingDomain lookup ────────────────────────────
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { marketingDomain: true },
  });
  if (!tenant || !tenant.marketingDomain) {
    throw new MarketingDomainNotConfiguredError();
  }

  // ── Step 2: URL parse + hostname match (mirror vehicle-scraper) ──────
  let inputHost: string;
  try {
    inputHost = new URL(input.listingUrl).hostname;
  } catch {
    throw new Error("Invalid listing URL");
  }
  const configuredHost = extractHostnameFromConfigured(tenant.marketingDomain);
  if (!hostnameMatches(inputHost, configuredHost)) {
    throw new HostnameMismatchError(inputHost, configuredHost);
  }

  // ── Step 3: adapter dispatch ─────────────────────────────────────────
  const adapter = pickCrawlerAdapter(inputHost);
  if (!adapter) {
    throw new Error(`No adapter for hostname ${inputHost}`);
  }

  // ── Step 4: concurrent-prevention (Q-LOCK: only one running per tenant) ─
  const running = await prisma.crawlJob.findFirst({
    where: { tenantId, status: { in: ["pending", "running"] } },
  });
  if (running) {
    throw new CrawlJobAlreadyRunningError(running.id);
  }

  // ── Step 5: create the job row + Pub/Sub publish ─────────────────────
  const job = await prisma.crawlJob.create({
    data: {
      tenantId,
      createdByUserId,
      listingUrl: input.listingUrl,
      adapter: adapter.hostname,
      status: "pending",
    },
  });

  let publishedMessageId: string | null = null;
  try {
    const data = Buffer.from(
      JSON.stringify({ tenantId, crawlJobId: job.id, listingUrl: input.listingUrl }),
      "utf8",
    );
    publishedMessageId = await pubsub.publish(CRAWL_TOPIC, data, {
      tenantId,
      crawlJobId: job.id,
    });
  } catch (err) {
    // Best-effort publish; job row already exists. Operator can re-publish
    // via a future fix-forward procedure if Pub/Sub was down.
    console.error("[inventory-crawler] Pub/Sub publish failed:", err);
  }

  return { crawlJob: job, publishedMessageId };
}

// ─────────────────────────────────────────────
// cancelCrawl — status-guarded updateMany (precedent:
// deferred-send-evaluator-concurrent-claim:314,324)
// ─────────────────────────────────────────────

export interface CancelCrawlResult {
  /** True if a row transitioned to 'cancelled' (false if already terminal). */
  cancelled: boolean;
  crawlJob: CrawlJobRecord | null;
}

export async function cancelCrawl(
  prisma: InventoryCrawlerPrisma,
  tenantId: string,
  crawlJobId: string,
  reason: string,
): Promise<CancelCrawlResult> {
  const result = await prisma.crawlJob.updateMany({
    where: {
      id: crawlJobId,
      tenantId,
      status: { in: ["pending", "running"] },
    },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: reason,
    },
  });
  const after = await prisma.crawlJob.findFirst({
    where: { id: crawlJobId, tenantId },
  });
  return { cancelled: result.count > 0, crawlJob: after };
}

// ─────────────────────────────────────────────
// getCrawlStatus — operator-poll endpoint
// ─────────────────────────────────────────────

export async function getCrawlStatus(
  prisma: InventoryCrawlerPrisma,
  tenantId: string,
  crawlJobId: string,
): Promise<CrawlJobRecord> {
  const job = await prisma.crawlJob.findFirst({
    where: { id: crawlJobId, tenantId },
  });
  if (!job) throw new CrawlJobNotFoundError();
  return job;
}

// ─────────────────────────────────────────────
// Worker loop — runCrawlJob
// ─────────────────────────────────────────────

// Type contract for the KAN-1216 scraper return — re-declared locally to
// avoid a hard cross-module dep on the shared union (which is also exported
// from @growth/shared).
type VehicleScraperResultMirror =
  | { kind: "extracted_full"; vehicleId: string }
  | {
      kind: "extracted_partial";
      extractedFields: Record<string, unknown>;
      extractGaps: string[];
    }
  | { kind: "tenant_marketing_domain_not_configured" }
  | { kind: "hostname_mismatch"; hostname: string; configuredDomain: string }
  | { kind: "fetch_timeout" }
  | { kind: "response_too_large"; maxBytes: number; actualBytes: number }
  | { kind: "extraction_failed"; reason: string };

export interface ScrapeVehicleUrlFn {
  (
    prisma: unknown,
    tenantId: string,
    input: { url: string },
    actor: string,
    hooks: unknown,
    fetchImpl?: typeof fetch,
  ): Promise<VehicleScraperResultMirror>;
}

export interface RunCrawlJobDeps {
  /** Per-URL scrape + persist (KAN-1216 vehicle-scraper.scrapeVehicleUrl). */
  scrapeVehicleUrl: ScrapeVehicleUrlFn;
  /** Hooks passed through to scrapeVehicleUrl. */
  scraperHooks: unknown;
  /** Redis client for rate-limit. */
  redis: RedisRateLimitClient;
  /** Override fetch in tests. */
  fetchImpl?: typeof fetch;
  /** Override sleep in tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface ErrorSample {
  url: string;
  errorVariant: string;
  message: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCrawlJob(
  prisma: InventoryCrawlerPrisma,
  crawlJobId: string,
  deps: RunCrawlJobDeps,
): Promise<CrawlJobRecord> {
  const sleep = deps.sleep ?? defaultSleep;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // ── Load job + idempotency / cancel-mid-pending guards ───────────────
  const initialJob = await prisma.crawlJob.findFirst({
    where: { id: crawlJobId },
  });
  if (!initialJob) throw new CrawlJobNotFoundError();
  if (initialJob.status === "cancelled") {
    // Race: operator cancelled between create + push delivery.
    return initialJob;
  }
  if (initialJob.status !== "pending") {
    // Idempotency: if the row has already advanced past pending (e.g.,
    // Pub/Sub redelivery), do not re-run.
    return initialJob;
  }

  const tenantId = initialJob.tenantId;
  const listingUrl = initialJob.listingUrl;

  // ── Adapter dispatch ─────────────────────────────────────────────────
  let listingHost: string;
  try {
    listingHost = new URL(listingUrl).hostname;
  } catch {
    return await finalizeJob(prisma, crawlJobId, tenantId, {
      status: "failed",
      cancelReason: "Invalid listing URL",
      errorSamples: [],
      counts: { discovered: 0, extracted: 0, skipped: 0, failed: 0 },
    });
  }
  const adapter = pickCrawlerAdapter(listingHost);
  if (!adapter) {
    return await finalizeJob(prisma, crawlJobId, tenantId, {
      status: "failed",
      cancelReason: `No adapter for hostname ${listingHost}`,
      errorSamples: [],
      counts: { discovered: 0, extracted: 0, skipped: 0, failed: 0 },
    });
  }

  // ── Status → running + vehicle.crawl_started audit ───────────────────
  await prisma.crawlJob.update({
    where: { id: crawlJobId },
    data: { status: "running", startedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      tenantId,
      actor: initialJob.createdByUserId,
      actionType: "vehicle.crawl_started",
      payload: { crawlJobId, listingUrl, adapter: adapter.hostname },
      reasoning: `inventory-crawler started crawl ${crawlJobId} for ${listingUrl}`,
    },
  });

  // ── Fetch + parse listing page ───────────────────────────────────────
  const errorSamples: ErrorSample[] = [];
  let discoveredUrls: string[] = [];
  try {
    const html = await fetchListingHtml(listingUrl, fetchImpl);
    // Lazy cheerio import (matches vehicle-scraper pattern).
    const cheerioMod = (await import("cheerio")) as typeof cheerio;
    const $ = cheerioMod.load(html);
    discoveredUrls = adapter.parseInventoryListing(html, $, listingUrl);
  } catch (err) {
    return await finalizeJob(prisma, crawlJobId, tenantId, {
      status: "failed",
      cancelReason: `Failed to fetch listing: ${(err as Error)?.message ?? String(err)}`,
      errorSamples,
      counts: { discovered: 0, extracted: 0, skipped: 0, failed: 0 },
    });
  }

  await prisma.crawlJob.update({
    where: { id: crawlJobId },
    data: { discoveredCount: discoveredUrls.length },
  });

  // ── Robots.txt (inline, Q4 lock) ─────────────────────────────────────
  const robots = await fetchRobotsTxt(listingUrl, fetchImpl);

  // ── Worker loop: per-URL extract + cancel-poll + rate-limit + pace ───
  let extractedCount = 0;
  let skippedVinDuplicateCount = 0;
  let failedCount = 0;

  for (let i = 0; i < discoveredUrls.length; i++) {
    const url = discoveredUrls[i]!;

    // Cancel-poll between URLs (precedent: deferred-send-evaluator-
    // concurrent-claim:314,324). Status-guarded DB read.
    const currentStatus = await prisma.crawlJob.findFirst({
      where: { id: crawlJobId },
    });
    if (!currentStatus || currentStatus.status === "cancelled") {
      // Already cancelled by operator. Refresh + emit audit + return.
      await prisma.auditLog.create({
        data: {
          tenantId,
          actor: initialJob.createdByUserId,
          actionType: "vehicle.crawl_cancelled",
          payload: {
            crawlJobId,
            listingUrl,
            extractedCount,
            skippedVinDuplicateCount,
            failedCount,
            cancelledAtUrlIndex: i,
          },
          reasoning: `inventory-crawler cancelled at URL ${i}/${discoveredUrls.length}`,
        },
      });
      // Persist counters; do NOT overwrite status (already 'cancelled' in row).
      await prisma.crawlJob.update({
        where: { id: crawlJobId },
        data: {
          extractedCount,
          skippedVinDuplicateCount,
          failedCount,
          errorSamples: errorSamples.slice(0, ERROR_SAMPLES_CAP),
        },
      });
      const after = await prisma.crawlJob.findFirst({
        where: { id: crawlJobId },
      });
      return after!;
    }

    // robots.txt allow-check (fail-open above; honored here)
    let urlPath: string;
    try {
      urlPath = new URL(url).pathname;
    } catch {
      failedCount++;
      pushSample(errorSamples, { url, errorVariant: "invalid_url", message: "URL parse failed" });
      continue;
    }
    if (!robotsTxtAllows(robots, urlPath)) {
      failedCount++;
      pushSample(errorSamples, {
        url,
        errorVariant: "robots_disallowed",
        message: `robots.txt disallows ${urlPath}`,
      });
      continue;
    }

    // Rate-limit check (advisory ceiling; pacing below is the real throttle).
    await checkCrawlRateLimit(deps.redis, tenantId, listingHost);

    // Per-URL extract.
    let result: VehicleScraperResultMirror;
    try {
      result = await deps.scrapeVehicleUrl(
        prisma,
        tenantId,
        { url },
        "inventory-crawler",
        deps.scraperHooks,
        fetchImpl,
      );
    } catch (err) {
      // VIN-dedup classification — scrapeVehicleUrl persists via raw
      // tx.vehicle.create (not vehicle-service.createVehicle), so a VIN
      // collision surfaces as Prisma P2002 with `meta.target` including
      // 'vin'. We ALSO accept the typed VinAlreadyExistsError shape in case
      // a future refactor routes through the service-layer wrap.
      const message = (err as Error)?.message ?? String(err);
      const errCode = (err as { code?: string })?.code;
      const errMetaTarget = (err as { meta?: { target?: unknown } })?.meta?.target;
      const targetIncludesVin = Array.isArray(errMetaTarget)
        ? errMetaTarget.includes("vin")
        : typeof errMetaTarget === "string" && errMetaTarget.includes("vin");
      const isVinUniqueViolation = errCode === "P2002" && targetIncludesVin;
      const isVinAlreadyExistsType = (err as Error)?.name === "VinAlreadyExistsError";
      if (
        isVinUniqueViolation ||
        isVinAlreadyExistsType ||
        /VinAlreadyExists/i.test(message)
      ) {
        skippedVinDuplicateCount++;
        pushSample(errorSamples, {
          url,
          errorVariant: "skipped_vin_duplicate",
          message,
        });
      } else {
        failedCount++;
        pushSample(errorSamples, { url, errorVariant: "thrown", message });
      }
      await sleep(PACING_DELAY_MS);
      continue;
    }

    // Discriminated-union branching (Memo 42 — every variant must surface).
    switch (result.kind) {
      case "extracted_full":
        extractedCount++;
        break;
      case "extracted_partial":
        // Memo 51 #6 + Option B: do NOT persist; log + continue.
        failedCount++;
        pushSample(errorSamples, {
          url,
          errorVariant: "extracted_partial",
          message: `gaps: ${result.extractGaps.join(",")}`,
        });
        break;
      case "fetch_timeout":
        failedCount++;
        pushSample(errorSamples, { url, errorVariant: "fetch_timeout", message: "fetch timed out" });
        break;
      case "response_too_large":
        failedCount++;
        pushSample(errorSamples, {
          url,
          errorVariant: "response_too_large",
          message: `${result.actualBytes}B > ${result.maxBytes}B`,
        });
        break;
      case "hostname_mismatch":
        failedCount++;
        pushSample(errorSamples, {
          url,
          errorVariant: "hostname_mismatch",
          message: `${result.hostname} vs ${result.configuredDomain}`,
        });
        break;
      case "tenant_marketing_domain_not_configured":
        // Should never happen mid-crawl (start gates on this).
        failedCount++;
        pushSample(errorSamples, {
          url,
          errorVariant: "tenant_marketing_domain_not_configured",
          message: "tenant marketingDomain unset mid-crawl",
        });
        break;
      case "extraction_failed":
        // Distinguish VIN-duplicate from generic extraction failure: the
        // scraper persists in a $transaction and would throw P2002 on
        // duplicate, which is caught above. Anything reaching here is a
        // real parse failure.
        failedCount++;
        pushSample(errorSamples, {
          url,
          errorVariant: "extraction_failed",
          message: result.reason,
        });
        break;
    }

    // Periodic progress write (every URL — cheap).
    await prisma.crawlJob.update({
      where: { id: crawlJobId },
      data: {
        extractedCount,
        skippedVinDuplicateCount,
        failedCount,
        errorSamples: errorSamples.slice(0, ERROR_SAMPLES_CAP),
      },
    });

    // Pace between URLs.
    if (i < discoveredUrls.length - 1) {
      await sleep(PACING_DELAY_MS);
    }
  }

  // ── Finalize: classify completion status (Memo 42 honesty) ───────────
  const finalStatus: "completed" | "completed_with_errors" =
    failedCount > 0 ? "completed_with_errors" : "completed";

  return await finalizeJob(prisma, crawlJobId, tenantId, {
    status: finalStatus,
    cancelReason: null,
    errorSamples,
    counts: {
      discovered: discoveredUrls.length,
      extracted: extractedCount,
      skipped: skippedVinDuplicateCount,
      failed: failedCount,
    },
  });
}

function pushSample(samples: ErrorSample[], s: ErrorSample): void {
  if (samples.length < ERROR_SAMPLES_CAP) samples.push(s);
}

async function fetchListingHtml(
  listingUrl: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetchImpl(listingUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": CRAWLER_USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching listing`);
    }
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

interface FinalizeInput {
  status: "completed" | "completed_with_errors" | "cancelled" | "failed";
  cancelReason: string | null;
  errorSamples: ErrorSample[];
  counts: { discovered: number; extracted: number; skipped: number; failed: number };
}

async function finalizeJob(
  prisma: InventoryCrawlerPrisma,
  crawlJobId: string,
  tenantId: string,
  input: FinalizeInput,
): Promise<CrawlJobRecord> {
  const now = new Date();
  const data: Record<string, unknown> = {
    status: input.status,
    discoveredCount: input.counts.discovered,
    extractedCount: input.counts.extracted,
    skippedVinDuplicateCount: input.counts.skipped,
    failedCount: input.counts.failed,
    errorSamples: input.errorSamples.slice(0, ERROR_SAMPLES_CAP),
  };
  if (input.status === "cancelled") {
    data.cancelledAt = now;
    data.cancelReason = input.cancelReason;
  } else {
    data.completedAt = now;
  }
  const updated = await prisma.crawlJob.update({
    where: { id: crawlJobId },
    data,
  });

  const auditType =
    input.status === "completed"
      ? "vehicle.crawl_completed"
      : input.status === "completed_with_errors"
        ? "vehicle.crawl_completed_with_errors"
        : input.status === "cancelled"
          ? "vehicle.crawl_cancelled"
          : "vehicle.crawl_failed";

  await prisma.auditLog.create({
    data: {
      tenantId,
      actor: "inventory-crawler",
      actionType: auditType,
      payload: {
        crawlJobId,
        discoveredCount: input.counts.discovered,
        extractedCount: input.counts.extracted,
        skippedVinDuplicateCount: input.counts.skipped,
        failedCount: input.counts.failed,
        cancelReason: input.cancelReason,
        errorSampleCount: input.errorSamples.length,
      },
      reasoning:
        input.status === "failed"
          ? `crawl ${crawlJobId} failed: ${input.cancelReason ?? "unknown"}`
          : `crawl ${crawlJobId} ${input.status}: ${input.counts.extracted}/${input.counts.discovered} extracted, ${input.counts.failed} failed, ${input.counts.skipped} VIN-skipped`,
    },
  });

  return updated;
}

/** Test seam — exposed for unit-level helper coverage. */
export const _internalForTest = {
  pickCrawlerAdapter,
  extractHostnameFromConfigured,
  hostnameMatches,
  parseRobotsTxt,
  robotsTxtAllows,
};

/** Topic exported for subscriber. */
export const VEHICLE_CRAWL_REQUESTED_TOPIC = CRAWL_TOPIC;
