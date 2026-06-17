/**
 * KAN-1219 (Slice 5 of KAN-1212 epic) — Product scraper service.
 *
 * First scraper service in the catalog arc. Reuses M4 archive-discipline
 * patterns from product-service.ts for the auto-save side-effect; reuses
 * cheerio + AbortController + size-cap patterns from
 * apps/api/src/services/account-detect-html-fetcher.ts.
 *
 * # Scraper boundary contract
 *
 * 1. **Subdomain matching lives HERE** (NOT at settings.setMarketingDomain).
 *    Per KAN-1217 H3 deferral: tenant configures the root domain (e.g.
 *    `example.com`); scraper boundary accepts the root AND any subdomain
 *    (`store.example.com`, `shop.example.com`). Case-insensitive.
 *
 * 2. **Resource limits** — 5s AbortController timeout +
 *    200KB SCRAPER_MAX_RESPONSE_BYTES cap (J5 REFUTE per
 *    account-detect-html-fetcher precedent). Cap enforced post-text();
 *    timeout enforced via signal.
 *
 * 3. **Auto-save status policy** — full extract (name + price + description +
 *    primaryImageUrl) → status='active'; partial extract (name present but
 *    one or more of price/description/image missing) → status='draft' +
 *    customFields.extractGaps[] populated for operator review.
 *
 * 4. **Discriminated result union** — 6 variants per
 *    product-scraper-types.ts. UI consumer MUST branch on every variant
 *    (Memo 41 discriminated-union doctrine).
 *
 * # Module discipline
 *
 * Pure service module — Prisma + @growth/shared types + cheerio only.
 * No tRPC, no Pub/Sub, no logger. Loaded via variable-specifier dynamic
 * import (KAN-689 cohort) from apps/api/src/router.ts.
 *
 * AuditLog hook contract mirrors product-service.ts buildProductHooks shape.
 * Reuses createProduct() from product-service.ts internally — the scraper is
 * a producer + consumer pair (fetch + parse → invoke CRUD).
 */
import * as cheerio from "cheerio";
import {
  type ProductScraperInput,
  type ProductScraperResult,
  ProductScraperInputSchema,
  SCRAPER_TIMEOUT_MS,
  SCRAPER_MAX_RESPONSE_BYTES,
} from "@growth/shared";

import {
  createProduct,
  type CreateProductInput,
  type ProductServiceHooks,
} from "./product-service.js";

// ─────────────────────────────────────────────
// Prisma surface (typed loosely — same posture as product-service.ts)
// ─────────────────────────────────────────────

interface ScraperPrisma {
  tenant: {
    findUnique: (args: unknown) => Promise<{ id: string; marketingDomain: string | null } | null>;
  };
  $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
  product: {
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    findFirst: (args: unknown) => Promise<unknown>;
  };
  auditLog: {
    create: (args: unknown) => Promise<{ id: string }>;
  };
}

// ─────────────────────────────────────────────
// hostnameMatches — subdomain-aware case-insensitive match
//
// Per KAN-1217 H3 deferral: tenant configures root domain (e.g.
// "example.com"); scraper accepts root + any subdomain.
//
// Examples:
//   hostnameMatches("example.com", "example.com")           → true
//   hostnameMatches("store.example.com", "example.com")     → true
//   hostnameMatches("EXAMPLE.com", "example.com")           → true
//   hostnameMatches("example.com.evil.com", "example.com")  → false (suffix attack guard)
//   hostnameMatches("notexample.com", "example.com")        → false
//   hostnameMatches("competitor.com", "example.com")        → false
// ─────────────────────────────────────────────

export function hostnameMatches(input: string, configured: string): boolean {
  const lhs = stripTrailingDot(input.toLowerCase().trim());
  const rhs = stripTrailingDot(configured.toLowerCase().trim());
  if (!lhs || !rhs) return false;
  if (lhs === rhs) return true;
  // Subdomain match: lhs must end with "." + rhs (suffix-attack guard via
  // dot separator — "notexample.com" does NOT end with ".example.com").
  return lhs.endsWith(`.${rhs}`);
}

function stripTrailingDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

/** Extract hostname from a configured marketingDomain that may be a full URL
 *  (e.g. "https://example.com/") or a bare hostname ("example.com"). Returns
 *  the bare hostname for matching. */
function extractHostnameFromConfigured(configured: string): string {
  try {
    // Try URL parse first — handles "https://example.com/path".
    return new URL(configured).hostname;
  } catch {
    // Fall back to treating the string as a bare hostname (strip any leading
    // protocol-like junk + trailing path).
    return configured.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

// ─────────────────────────────────────────────
// extractProductFields — cheerio + heuristic selector pipeline
//
// Priority-ordered selectors for each field. Returns nulls when a field
// has no candidate. Caller decides extractGaps[] policy.
// ─────────────────────────────────────────────

export interface ExtractedFields {
  name: string | null;
  description: string | null;
  price: number | null;
  primaryImageUrl: string | null;
}

const PRICE_REGEX = /\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/;

export function extractProductFields(html: string): ExtractedFields {
  const $ = cheerio.load(html);

  // ── Name (priority order: og:title meta > h1 > h2 > title meta) ────────
  const name =
    pickMeta($, 'meta[property="og:title"]') ??
    pickText($, "h1") ??
    pickText($, "h2") ??
    pickMeta($, 'meta[name="title"]') ??
    null;

  // ── Description (og:description > meta description > .product-description) ─
  const description =
    pickMeta($, 'meta[property="og:description"]') ??
    pickMeta($, 'meta[name="description"]') ??
    pickText($, ".product-description") ??
    null;

  // ── Price (regex scan over text content; strip thousands separators) ──
  const text = $("body").text();
  let price: number | null = null;
  const match = text.match(PRICE_REGEX);
  if (match) {
    const numeric = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(numeric)) price = numeric;
  }

  // ── Image (og:image only — no fallback heuristic) ─────────────────────
  const primaryImageUrl = pickMeta($, 'meta[property="og:image"]') ?? null;

  return { name, description, price, primaryImageUrl };
}

function pickMeta($: cheerio.CheerioAPI, selector: string): string | null {
  const el = $(selector).first();
  const content = el.attr("content");
  if (!content) return null;
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickText($: cheerio.CheerioAPI, selector: string): string | null {
  const el = $(selector).first();
  const text = el.text();
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

// ─────────────────────────────────────────────
// scrapeProduct — main service entry point
// ─────────────────────────────────────────────

export async function scrapeProduct(
  prisma: ScraperPrisma,
  tenantId: string,
  input: ProductScraperInput,
  actor: string,
  hooks: ProductServiceHooks,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductScraperResult> {
  // Defensive boundary validation (M4 lock #3 — same posture as product-service).
  const parsed = ProductScraperInputSchema.parse(input);

  // ── Step 1: tenant marketingDomain check ───────────────────────────────
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
  });
  if (!tenant || !tenant.marketingDomain) {
    return { kind: "tenant_marketing_domain_not_configured" };
  }

  // ── Step 2: subdomain-aware hostname match (KAN-1217 H3 boundary) ──────
  let inputHost: string;
  try {
    inputHost = new URL(parsed.url).hostname;
  } catch {
    return { kind: "fetch_failed", reason: "invalid URL" };
  }
  const configuredHost = extractHostnameFromConfigured(tenant.marketingDomain);
  if (!hostnameMatches(inputHost, configuredHost)) {
    return {
      kind: "domain_not_allowed",
      hostname: inputHost,
      configuredDomain: configuredHost,
    };
  }

  // ── Step 3: fetch with AbortController timeout ─────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);
  let responseText: string;
  try {
    const resp = await fetchImpl(parsed.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "AxisOne/1.0 (+https://growth-ai.com; product-scraper; contact: support@growth-ai.com)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) {
      return { kind: "fetch_failed", reason: `HTTP ${resp.status}` };
    }
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) {
      return { kind: "fetch_failed", reason: `unsupported content-type: ${ct}` };
    }
    responseText = await resp.text();
  } catch (err) {
    const reason =
      (err as { name?: string } | null)?.name === "AbortError"
        ? "timeout"
        : (err as Error)?.message ?? "network error";
    return { kind: "fetch_failed", reason };
  } finally {
    clearTimeout(timer);
  }

  // ── Step 4: response size cap (200KB per J5 REFUTE) ────────────────────
  // Use byte length (UTF-8) so the cap is honest with the SCRAPER_MAX_RESPONSE_BYTES
  // contract — string.length over-counts ASCII and under-counts emoji surrogates.
  const actualBytes = Buffer.byteLength(responseText, "utf8");
  if (actualBytes > SCRAPER_MAX_RESPONSE_BYTES) {
    return {
      kind: "response_too_large",
      maxBytes: SCRAPER_MAX_RESPONSE_BYTES,
      actualBytes,
    };
  }

  // ── Step 5: parse with cheerio + heuristic extract ─────────────────────
  const fields = extractProductFields(responseText);
  if (!fields.name) {
    return { kind: "parse_failed", reason: "no name extracted" };
  }

  // ── Step 6: compute extractGaps + auto-save status ─────────────────────
  const extractGaps: string[] = [];
  if (fields.price == null) extractGaps.push("price");
  if (!fields.description) extractGaps.push("description");
  if (!fields.primaryImageUrl) extractGaps.push("primaryImageUrl");
  const isScrapeSuccess = extractGaps.length === 0;
  const status: "active" | "draft" = isScrapeSuccess ? "active" : "draft";

  // ── Step 7: persist via product-service.createProduct (re-uses M4 audit hooks) ─
  const createInput: CreateProductInput = {
    name: fields.name,
    description: fields.description,
    status,
    price: fields.price,
    currency: "USD",
    externalUrl: parsed.url,
    primaryImageUrl: fields.primaryImageUrl,
    customFields: {
      scrapedAt: new Date().toISOString(),
      scrapedFrom: parsed.url,
      extractGaps,
    },
  };

  const created = await createProduct(
    prisma as unknown as Parameters<typeof createProduct>[0],
    tenantId,
    createInput,
    actor,
    hooks,
  );

  return {
    kind: "scraped",
    productId: (created.product as { id: string }).id,
    isScrapeSuccess,
    extractGaps,
  };
}

/** Test seam — exposed so tests can swap selectors / regex without re-implementing. */
export const _internalForTest = {
  PRICE_REGEX,
  extractHostnameFromConfigured,
};
