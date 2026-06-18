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
 * Per Memo 53 (AuditLog action_type provenance distinguishability), persists
 * scraped products directly with action_type='product.scraped' rather than
 * reusing product-service.createProduct() (which writes 'product.created').
 * Provenance must be queryable at the row level, NOT via cross-reference
 * reconstruction. See step 7 inline doctrine block for full reasoning.
 *
 * # Title-sanitization doctrine (KAN-1219 fix-forward)
 *
 * 5. **stripSiteSuffix is Pattern A only, NOT B or C.** Pattern A strips
 *    the og:site_name (when meta present) appended via separator characters
 *    (- | — :: –). Case-insensitive site match. Pattern C — naive
 *    last-segment strip regardless of match — was rejected because
 *    legitimate product names commonly contain separators
 *    ("Widget - Pro Edition" must NOT clip to "Widget").
 *
 *    **Pattern B (hostname-derived candidate) DEFERRED to KAN-1221** per
 *    Memo 54 empirical-priority-discipline. PROD anchor: 4mkauto.com sets
 *    og:site_name="4mk Auto" — Pattern A alone handles the original bug.
 *    Pattern B (when og:site_name absent) was speculative defensive scope
 *    that fails on hostname↔suffix lexical mismatch (`4mkauto` hostname
 *    vs `4mk auto` suffix is not regex-decomposable without vocabulary).
 *    Reopen KAN-1221 when an empirical PROD site with absent og:site_name
 *    AND raw-hostname suffix appears.
 *
 * 6. **GENERIC_H1_WHITELIST is hoisted to packages/shared** per Memo 37
 *    (cross-workspace algorithm hoist eliminates byte-stability drift).
 *    Future apps/web /settings/products lint surface will consume the
 *    same vocabulary at name-entry time. Re-implement-per-workspace is
 *    silent-drift-prone.
 *
 * 7. **Doctrine anchors** —
 *    - Memo 39 #7: symptom-vs-root-cause classification (KAN-1230 +
 *      KAN-1219 forced upward reclassification when title-sanitization
 *      gap surfaced as silent name-pollution rather than null name).
 *    - Memo 51 #5: stripSiteSuffix is the 5th test-author CI fix-forward
 *      anchored to the cross-workspace algorithm-hoist cohort.
 *    - Memo 54 #4: Pattern B deferral validates empirical-priority
 *      discipline — defensive scope without empirical signal is removed,
 *      not shipped narrower.
 */
import * as cheerio from "cheerio";
import {
  type ProductScraperInput,
  type ProductScraperResult,
  ProductScraperInputSchema,
  SCRAPER_TIMEOUT_MS,
  SCRAPER_MAX_RESPONSE_BYTES,
  GENERIC_H1_WHITELIST,
  SITE_SUFFIX_SEPARATORS,
} from "@growth/shared";

import type { ProductServiceHooks } from "./product-service.js";

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

/**
 * isGenericH1 — case-insensitive whitelist rejection.
 *
 * Rejects strings matching GENERIC_H1_WHITELIST (page chrome like "Inventory"
 * / "Home" / "Products"). Returns TRUE when the text should be rejected as
 * a name candidate. Whitespace-trimmed comparison; empty input → false
 * (caller already filters nulls).
 */
export function isGenericH1(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return GENERIC_H1_WHITELIST.some((g) => g.toLowerCase() === normalized);
}

/**
 * stripSiteSuffix — Pattern A only (og:site_name).
 *
 * Pattern A: when og:site_name meta present, strip ` <sep> <site>` from end.
 *   Separators per SITE_SUFFIX_SEPARATORS (-, |, —, –, ::). Case-insensitive
 *   site match.
 *
 * Pattern B (hostname-derived) is DEFERRED to KAN-1221 — see module
 * header doctrine #5 for empirical-priority rationale. Pattern C (naive
 * last-segment strip) is REJECTED — would clip "Widget - Pro Edition".
 *
 * Safety: if the strip would leave < 3 chars OR og:site_name is absent,
 * return the original raw string unchanged.
 */
export function stripSiteSuffix(raw: string, $: cheerio.CheerioAPI): string {
  const input = raw.trim();
  if (input.length === 0) return raw;

  const siteName = pickMeta($, 'meta[property="og:site_name"]');
  if (!siteName) return input;

  const trimmedCand = siteName.trim();
  if (trimmedCand.length === 0) return input;

  const stripped = applySuffixStrip(input, trimmedCand);
  if (stripped !== null && stripped.length >= 3) return stripped;
  return input;
}

/**
 * applySuffixStrip — case-insensitive end-match of ` <sep> <candidate>`.
 * Returns null when no separator-bridged suffix matches; returns the
 * trimmed prefix otherwise.
 */
// KAN-1216: re-exported for vehicle-scraper consumer (Memo 37 pre-hoist pattern)
export function applySuffixStrip(input: string, candidate: string): string | null {
  const lower = input.toLowerCase();
  const candLower = candidate.toLowerCase();
  for (const sep of SITE_SUFFIX_SEPARATORS) {
    // Match `<whitespace?><sep><whitespace?><candidate>` at end.
    const needle = `${sep.toLowerCase()} ${candLower}`;
    const idx = lower.lastIndexOf(needle);
    if (idx === -1) continue;
    // Verify it really IS at the end (allow trailing whitespace).
    const tail = lower.slice(idx + needle.length).trim();
    if (tail.length !== 0) continue;
    // Walk left through any leading whitespace before the separator.
    let cut = idx;
    while (cut > 0 && /\s/.test(input.charAt(cut - 1))) cut--;
    if (cut <= 0) return null;
    return input.slice(0, cut).trim();
  }
  return null;
}

export function extractProductFields(html: string): ExtractedFields {
  const $ = cheerio.load(html);

  // ── Name (priority order: og:title meta > h1 > h2 > title meta) ────────
  // Each candidate runs through stripSiteSuffix (Pattern A — og:site_name)
  // to remove site-name pollution ("X - Brand"). h1/h2 candidates
  // additionally run through isGenericH1 to reject page-chrome like
  // "Inventory" / "Home" / "Products". KAN-1219 fix-forward — anchor:
  // 4mkauto.com og:title="2024 Toyota Camry XLE - 4mk Auto" with
  // og:site_name="4mk Auto" shipped with suffix intact before this fix.
  const ogTitle = pickMeta($, 'meta[property="og:title"]');
  const h1 = pickText($, "h1");
  const h2 = pickText($, "h2");
  const metaTitle = pickMeta($, 'meta[name="title"]');

  const cleanedOgTitle = ogTitle ? stripSiteSuffix(ogTitle, $) : null;
  const cleanedH1 = h1 && !isGenericH1(h1) ? stripSiteSuffix(h1, $) : null;
  const cleanedH2 = h2 && !isGenericH1(h2) ? stripSiteSuffix(h2, $) : null;

  const name = cleanedOgTitle ?? cleanedH1 ?? cleanedH2 ?? metaTitle ?? null;

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

  // ── Step 7: persist directly + write `product.scraped` audit_log ───────
  //
  // Memo 53 — AuditLog action_type provenance distinguishability.
  // We do NOT reuse product-service.createProduct() because that writes
  // `product.created` audit rows, conflating operator-origin with
  // scraper-origin entities. Per Memo 32 family + KAN-1190 J7 dual-audit-
  // type discipline, distinct commit paths emit distinct action_types so
  // audit-replay queryability is preserved at the row level (operational
  // analytics like "how many products did operators create vs scrape this
  // week" need distinguishable rows, NOT cross-reference reconstruction).
  //
  // Payload includes: productId, externalUrl, extractedFields snapshot,
  // extractGaps[], scrapedAt — everything downstream forensic queries
  // need to reconstruct the scrape decision.
  const scrapedAt = new Date().toISOString();
  const { product, auditId } = await prisma.$transaction(async (tx) => {
    const txt = tx as unknown as {
      product: { create: (args: unknown) => Promise<{ id: string }> };
    };
    const prod = await txt.product.create({
      data: {
        tenantId,
        name: fields.name,
        description: fields.description,
        status,
        price: fields.price,
        currency: "USD",
        externalUrl: parsed.url,
        primaryImageUrl: fields.primaryImageUrl,
        customFields: {
          scrapedAt,
          scrapedFrom: parsed.url,
          extractGaps,
        },
      },
    });
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product.scraped",
      payload: {
        productId: prod.id,
        externalUrl: parsed.url,
        extractedFields: {
          name: fields.name,
          description: fields.description,
          price: fields.price,
          primaryImageUrl: fields.primaryImageUrl,
        },
        extractGaps,
        scrapedAt,
      },
      reasoning: `scraper (${actor}) scraped product from ${parsed.url} (gaps: ${extractGaps.length === 0 ? "none" : extractGaps.join(",")})`,
    });
    return { product: prod, auditId: audit.id };
  });
  void auditId; // auditId is referenced via audit-log; we don't return it.
  return {
    kind: "scraped",
    productId: product.id,
    isScrapeSuccess,
    extractGaps,
  };
}

/** Test seam — exposed so tests can swap selectors / regex without re-implementing. */
export const _internalForTest = {
  PRICE_REGEX,
  extractHostnameFromConfigured,
};
