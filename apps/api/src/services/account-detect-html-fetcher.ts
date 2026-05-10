/**
 * KAN-862 — Account Page Cohort 5: HTML fetcher + page discovery for
 * the detect-from-website pipeline.
 *
 * Hybrid heuristic per Fred's pre-flight Decision (item 6):
 *   1. Fetch homepage HTML (max 500KB, 5s timeout)
 *   2. cheerio-parse, extract anchors matching about|contact|team
 *      (case-insensitive)
 *   3. If <2 candidates, fall back to common URL patterns via HEAD
 *   4. Skip cross-domain or 404 candidates
 *   5. Top 2 candidates + homepage = max 3 pages, in priority order
 *
 * HTML cleaning: strip script/style/nav/footer/aside; preserve
 * body/main/article. Truncate to ~30K combined tokens before LLM call.
 *
 * No JS-rendered SPA support at MVP — cheerio static fetch only. If a
 * tenant complains, file a focused follow-up to add Playwright.
 */
import * as cheerio from "cheerio";

const PAGE_FETCH_TIMEOUT_MS = 5000;
const MAX_PAGE_BYTES = 500 * 1024; // 500KB per page
const MAX_PAGES = 3;
const MAX_COMBINED_CHARS = 120000; // ~30K tokens at ~4 chars/token

/** Anchor href patterns we consider "about/contact/team" (case-insensitive). */
const RELEVANT_LINK_REGEX = /\/(about|about-us|contact|contact-us|team|company)(\/|\?|#|$)/i;

/** Fallback URL patterns to probe via HEAD when anchor extraction yields <2. */
const FALLBACK_PATTERNS = [
  "/about",
  "/about-us",
  "/contact",
  "/contact-us",
  "/team",
];

export interface FetchedPage {
  url: string;
  /** Cleaned text content, stripped of script/style/nav/footer/aside. */
  textContent: string;
}

export interface PageDiscoveryResult {
  pages: FetchedPage[];
  /** Why discovery stopped — informational, surfaced in detect_progress events. */
  notes: string[];
}

/**
 * Fetch homepage + discover up to 2 additional pages, return cleaned
 * text content for each.
 */
export async function discoverAndFetchPages(
  rootUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PageDiscoveryResult> {
  const notes: string[] = [];
  const pages: FetchedPage[] = [];
  const rootOrigin = new URL(rootUrl).origin;

  // Step 1: fetch homepage
  const homepageHtml = await fetchHtml(rootUrl, fetchImpl);
  if (homepageHtml == null) {
    notes.push(`homepage fetch failed: ${rootUrl}`);
    return { pages, notes };
  }
  const homepage: FetchedPage = {
    url: rootUrl,
    textContent: cleanHtml(homepageHtml),
  };
  pages.push(homepage);

  // Step 2: extract relevant anchors from homepage
  const $ = cheerio.load(homepageHtml);
  const candidateUrls = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (!RELEVANT_LINK_REGEX.test(href)) return;
    const absolute = absolutizeUrl(href, rootUrl);
    if (!absolute) return;
    if (new URL(absolute).origin !== rootOrigin) return; // cross-domain skip
    if (absolute === rootUrl) return; // skip self-link
    candidateUrls.add(absolute);
  });

  // Step 3: fall back to common URL patterns if too few anchors
  if (candidateUrls.size < 2) {
    notes.push(
      `anchor extraction yielded ${candidateUrls.size} candidate(s) — probing fallback patterns`,
    );
    for (const pattern of FALLBACK_PATTERNS) {
      if (candidateUrls.size >= MAX_PAGES - 1) break;
      const probe = `${rootOrigin}${pattern}`;
      if (probe === rootUrl) continue;
      if (candidateUrls.has(probe)) continue;
      const exists = await probeHead(probe, fetchImpl);
      if (exists) candidateUrls.add(probe);
    }
  }

  // Step 4: fetch up to 2 additional pages
  const additional = Array.from(candidateUrls).slice(0, MAX_PAGES - 1);
  for (const url of additional) {
    const html = await fetchHtml(url, fetchImpl);
    if (html == null) {
      notes.push(`page fetch failed: ${url}`);
      continue;
    }
    pages.push({ url, textContent: cleanHtml(html) });
  }

  return { pages, notes };
}

/**
 * Fetch a URL with timeout + size cap. Returns null on any failure.
 */
async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "AxisOne/1.0 (+https://growth-ai.com; account-detect; contact: support@growth-ai.com)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) return null;
    // Read with size cap. fetch() in Node's Response doesn't expose a
    // streaming size guard cleanly; we read the full text and truncate.
    // The 5s timeout above keeps abuse tractable.
    const text = await resp.text();
    if (text.length > MAX_PAGE_BYTES) return text.slice(0, MAX_PAGE_BYTES);
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HEAD request to confirm a fallback URL pattern exists before adding it
 * to the candidate set. Cheap probe — avoids paying full GET cost on
 * dead URLs.
 */
async function probeHead(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "manual", // catch cross-domain redirects without following
    });
    return resp.status >= 200 && resp.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function absolutizeUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Strip script/style/nav/footer/aside blocks; concatenate the text
 * content of body/main/article. Whitespace-collapsed.
 */
export function cleanHtml(html: string): string {
  const $ = cheerio.load(html);
  // Remove non-content blocks
  $("script, style, nav, footer, aside, noscript, svg, iframe").remove();
  // Prefer main/article when present; fall back to body
  const root = $("main").length > 0
    ? $("main")
    : $("article").length > 0
      ? $("article")
      : $("body");
  const text = root.text() ?? "";
  // Collapse whitespace, trim per-line
  return text
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Combined text for the LLM prompt — pages joined with separators.
 * Truncates the WHOLE combined string to MAX_COMBINED_CHARS to keep the
 * Sonnet input token count predictable.
 */
export function buildCombinedTextForLLM(pages: FetchedPage[]): string {
  const sections: string[] = [];
  for (const p of pages) {
    sections.push(`---\nPAGE URL: ${p.url}\n---\n${p.textContent}`);
  }
  const combined = sections.join("\n\n");
  if (combined.length > MAX_COMBINED_CHARS) {
    return combined.slice(0, MAX_COMBINED_CHARS);
  }
  return combined;
}

/** Test seam — exposed so test files don't need to mock cheerio internals. */
export const _internalForTest = {
  cleanHtml,
  RELEVANT_LINK_REGEX,
  FALLBACK_PATTERNS,
};
