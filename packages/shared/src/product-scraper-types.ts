/**
 * KAN-1219 (Slice 5 of KAN-1212 epic) — Product scraper output contract.
 *
 * Input schema + discriminated result union for the product-scraper service
 * (packages/api/src/services/product-scraper.ts). Consumed by:
 *   - apps/api productsRouter.scrape tRPC procedure
 *   - apps/web /settings/products ScrapeProductModal (KAN-1218 scrape button
 *     now functional)
 *
 * # Discriminated union — 6 variants
 *
 *   - scraped — full or partial extract; product persisted (status='active'
 *     when isScrapeSuccess=true, otherwise status='draft' + extractGaps[]).
 *   - domain_not_allowed — input URL hostname does not match (subdomain-aware)
 *     the tenant's configured marketingDomain. KAN-1217 H3 lock anchors the
 *     subdomain-match boundary HERE (NOT in settings.setMarketingDomain).
 *   - fetch_failed — fetch() threw (timeout via AbortController, network,
 *     non-2xx, content-type mismatch).
 *   - parse_failed — cheerio loaded HTML but no product name extractable
 *     (heuristic selectors yielded null).
 *   - response_too_large — response body exceeded SCRAPER_MAX_RESPONSE_BYTES.
 *     Cap = 200KB per J5 REFUTE (NOT SPO 50KB pre-lean); inherits the
 *     account-detect-html-fetcher 500KB precedent shape, scaled to product
 *     page typical size.
 *   - tenant_marketing_domain_not_configured — defensive variant; UI button
 *     SHOULD be disabled when this is true, but service handles directly to
 *     avoid silent NPE on null marketingDomain.
 *
 * # Memo 39 (codebase precedent) — resource limits inherited from siblings
 *
 *   - account-detect-html-fetcher: cheerio + AbortController + size cap.
 *   - feasibility-counsel-types: discriminated-union shape over outcome
 *     branches (cold_start / counsel / unavailable).
 *   - Both anchored as canonical for service-result reporting.
 *
 * Hoisted to packages/shared per Memo 37 — apps/api consumer + apps/web
 * consumer cross-workspace.
 */
import { z } from "zod";

// ─────────────────────────────────────────────
// Input schema — single URL target
// ─────────────────────────────────────────────

export const ProductScraperInputSchema = z.object({
  url: z.string().url(),
});
export type ProductScraperInput = z.infer<typeof ProductScraperInputSchema>;

// ─────────────────────────────────────────────
// Service constants (single source of truth for resource limits)
// ─────────────────────────────────────────────

/** Hard timeout for the upstream fetch() — AbortController-enforced. */
export const SCRAPER_TIMEOUT_MS = 5000;

/**
 * Response body cap. 200KB per J5 REFUTE — SPO pre-lean cited 50KB but the
 * account-detect-html-fetcher precedent uses 500KB; product pages typically
 * sit between (image-heavy storefronts + cart bundles run 100-180KB). 200KB
 * is the balance point.
 */
export const SCRAPER_MAX_RESPONSE_BYTES = 200 * 1024;

// ─────────────────────────────────────────────
// ProductScraperResult — discriminated return shape (6 variants)
// ─────────────────────────────────────────────

export type ProductScraperResult =
  | {
      kind: "scraped";
      /** Persisted product id (consumer refetches via products.list). */
      productId: string;
      /** True when all required fields extracted; product saved as 'active'.
       *  False when partial extract; product saved as 'draft' for operator
       *  review with extractGaps[] populated. */
      isScrapeSuccess: boolean;
      /** Field names missing from the extract (e.g. ["price", "description"]).
       *  Empty when isScrapeSuccess=true. Operator UI renders as a hint list. */
      extractGaps: string[];
    }
  | {
      kind: "domain_not_allowed";
      /** Hostname parsed from input URL. */
      hostname: string;
      /** Tenant's configured marketingDomain (for operator-facing message). */
      configuredDomain: string;
    }
  | {
      kind: "fetch_failed";
      /** Short human-readable reason (timeout / network / non-2xx / content-type). */
      reason: string;
    }
  | {
      kind: "parse_failed";
      /** Short human-readable reason (e.g. "no name extracted"). */
      reason: string;
    }
  | {
      kind: "response_too_large";
      maxBytes: number;
      actualBytes: number;
    }
  | {
      kind: "tenant_marketing_domain_not_configured";
    };
