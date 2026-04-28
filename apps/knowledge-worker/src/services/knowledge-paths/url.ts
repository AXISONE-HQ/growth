/**
 * KAN-707 PR B — URL crawl ingestion path (V1: single-page).
 *
 * V1 SCOPE (intentionally narrow):
 *   - Fetches exactly ONE URL (the submitted sourceUrl)
 *   - Respects robots.txt for the target URL (rejects with warning if
 *     User-agent disallowed)
 *   - Strips HTML to plain text via html-to-text (with sane defaults:
 *     skip nav/script/style/footer, preserve paragraph structure)
 *   - Chunks the extracted text via the standard chunker
 *
 * V2+ FOLLOW-UPS (filed at PR-open time):
 *   - Multi-page crawl (depth > 1, link traversal) — KAN-728+
 *   - sitemap.xml-aware seeding — KAN-728+
 *   - Per-domain rate limiter (1 req/sec) — required when V2 multi-page
 *     lands; V1 makes 1 request total so rate limiter is moot
 *   - Per-tenant queue depth (already enforced at tRPC layer per KAN-707 PR A)
 *   - Page-level partial-success accounting — V1 has no page-level fan-out
 *
 * The current `crawlScope` enum value is preserved on the input but only
 * `page` is implemented in V1. `domain` and `sitemap` reject with a clear
 * error directing to follow-up tickets; the wizard can still surface the
 * options for forward compatibility.
 */
import { htmlToText } from "html-to-text";
import { chunkText } from "../knowledge-chunker.js";
import type { IngestionPathInput, IngestionPathResult, PathHandler, PathHandlerDeps } from "./types.js";

const USER_AGENT = "growth-knowledge-worker/0.1 (+https://growth-web-biut5gfhuq-uc.a.run.app)";

async function checkRobotsTxt(fetcher: typeof fetch, sourceUrl: string): Promise<{ allowed: boolean; reason?: string }> {
  const u = new URL(sourceUrl);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  let body: string;
  try {
    const r = await fetcher(robotsUrl, { headers: { "User-Agent": USER_AGENT } });
    if (r.status === 404) return { allowed: true }; // No robots.txt = open by default
    if (!r.ok) return { allowed: true, reason: `robots.txt fetch returned ${r.status} — assuming allowed` };
    body = await r.text();
  } catch {
    return { allowed: true, reason: "robots.txt fetch failed — assuming allowed" };
  }

  // Minimal parser: find `User-agent: *` block and check for `Disallow: <path>`
  // matching our target path. NOT a full robots.txt spec implementation;
  // covers the common case (default deny via "*"). KAN-728+ for proper parser.
  const lines = body.split("\n").map((l) => l.split("#")[0]!.trim()).filter(Boolean);
  let inStarBlock = false;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("user-agent:")) {
      const ua = lower.slice("user-agent:".length).trim();
      inStarBlock = ua === "*";
      continue;
    }
    if (!inStarBlock) continue;
    if (lower.startsWith("disallow:")) {
      const path = line.slice("disallow:".length).trim();
      if (path === "" || path === "/") {
        if (path === "/") return { allowed: false, reason: "robots.txt disallows / for User-agent: *" };
      } else if (u.pathname.startsWith(path)) {
        return { allowed: false, reason: `robots.txt disallows path prefix "${path}" for User-agent: *` };
      }
    }
  }
  return { allowed: true };
}

export const ingestUrl: PathHandler = async (
  input: IngestionPathInput,
  deps: PathHandlerDeps,
): Promise<IngestionPathResult> => {
  if (input.path !== "url") {
    throw new Error(`ingestUrl: wrong path discriminator ${input.path}`);
  }

  // V1: only crawlScope=page is implemented. domain + sitemap surface a clear
  // error so the worker fails fast with diagnostic rather than partially
  // ingesting.
  if (input.crawlScope !== "page") {
    throw new Error(
      `crawlScope=${input.crawlScope} not implemented in V1 (single-page only). KAN-728 follow-up tracks multi-page crawl.`,
    );
  }

  const robots = await checkRobotsTxt(deps.fetch, input.sourceUrl);
  const warnings: string[] = [];
  if (!robots.allowed) {
    return {
      chunks: [],
      urlsDiscovered: 1,
      urlsIndexed: 0,
      warnings: [robots.reason ?? "robots.txt disallowed"],
    };
  }
  if (robots.reason) warnings.push(robots.reason);

  const r = await deps.fetch(input.sourceUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.9" },
  });
  if (!r.ok) {
    throw new Error(`Crawl fetch failed: ${r.status} ${r.statusText} for ${input.sourceUrl}`);
  }
  const contentType = r.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html") && !contentType.toLowerCase().includes("text/plain")) {
    return {
      chunks: [],
      urlsDiscovered: 1,
      urlsIndexed: 0,
      warnings: [`Skipped: content-type "${contentType}" is not HTML/plain text`],
    };
  }
  const html = await r.text();
  const text = htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "aside", format: "skip" },
      { selector: "header", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  });

  const chunks = chunkText(text);

  return {
    chunks,
    urlsDiscovered: 1,
    urlsIndexed: chunks.length > 0 ? 1 : 0,
    warnings,
  };
};
