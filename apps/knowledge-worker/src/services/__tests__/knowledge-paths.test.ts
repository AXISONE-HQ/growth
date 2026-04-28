/**
 * KAN-707 PR B — path handler tests.
 *
 * - Q&A pair: end-to-end with chunker, single chunk + multi-chunk
 * - Document: txt/md raw read; pdf/docx mocked at the parse layer
 * - URL crawl: robots.txt allowed/disallowed; HTML extraction; non-HTML skip
 */
import { describe, it, expect, vi } from "vitest";
import { ingestQaPair, ingestDocument, ingestUrl, type PathHandlerDeps } from "../knowledge-paths/index.js";

const noopFetch = vi.fn() as unknown as typeof fetch;
const noopDownload = vi.fn(async (_: string) => Buffer.alloc(0));
const baseDeps: PathHandlerDeps = { fetch: noopFetch, downloadFile: noopDownload };

describe("ingestQaPair", () => {
  it("produces 1 chunk for short Q&A", async () => {
    const out = await ingestQaPair(
      { path: "qa_pair", question: "What is X?", answer: "X is Y." },
      baseDeps,
    );
    expect(out.chunks.length).toBe(1);
    expect(out.chunks[0]!.content).toContain("Q: What is X?");
    expect(out.chunks[0]!.content).toContain("A: X is Y.");
    expect(out.urlsDiscovered).toBe(0);
    expect(out.urlsIndexed).toBe(0);
    expect(out.warnings).toEqual([]);
  });

  it("produces multiple chunks for very long Q&A", async () => {
    const longAnswer = "lorem ipsum dolor sit amet ".repeat(500);
    const out = await ingestQaPair(
      { path: "qa_pair", question: "Tell me everything.", answer: longAnswer },
      baseDeps,
    );
    expect(out.chunks.length).toBeGreaterThan(1);
  });
});

describe("ingestDocument", () => {
  it("reads .txt files raw", async () => {
    const deps: PathHandlerDeps = {
      ...baseDeps,
      downloadFile: async () => Buffer.from("Hello world.\nLine two.", "utf8"),
    };
    const out = await ingestDocument(
      { path: "document", uploadedFileRef: "bucket/file.txt", originalFileName: "file.txt" },
      deps,
    );
    expect(out.chunks.length).toBe(1);
    expect(out.chunks[0]!.content).toContain("Hello world");
  });

  it("reads .md files raw", async () => {
    const deps: PathHandlerDeps = {
      ...baseDeps,
      downloadFile: async () => Buffer.from("# Title\n\nSome content.", "utf8"),
    };
    const out = await ingestDocument(
      { path: "document", uploadedFileRef: "bucket/notes.md", originalFileName: "notes.md" },
      deps,
    );
    expect(out.chunks.length).toBe(1);
    expect(out.chunks[0]!.content).toContain("Title");
  });

  it("rejects unknown file types with a clear error", async () => {
    await expect(
      ingestDocument(
        { path: "document", uploadedFileRef: "bucket/bad.xlsx", originalFileName: "bad.xlsx" },
        baseDeps,
      ),
    ).rejects.toThrow(/Unsupported file type/);
  });

  it("warns on empty parsed text", async () => {
    const deps: PathHandlerDeps = {
      ...baseDeps,
      downloadFile: async () => Buffer.from("   \n\n   ", "utf8"),
    };
    const out = await ingestDocument(
      { path: "document", uploadedFileRef: "bucket/empty.txt", originalFileName: "empty.txt" },
      deps,
    );
    expect(out.chunks.length).toBe(0);
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toMatch(/empty text/);
  });

  it("rejects files exceeding 50MB cap", async () => {
    const deps: PathHandlerDeps = {
      ...baseDeps,
      downloadFile: async () => Buffer.alloc(51 * 1024 * 1024),
    };
    await expect(
      ingestDocument(
        { path: "document", uploadedFileRef: "bucket/big.txt", originalFileName: "big.txt" },
        deps,
      ),
    ).rejects.toThrow(/exceeds size cap/);
  });
});

describe("ingestUrl", () => {
  function mockFetch(robotsBody: string | null, pageBody: string, contentType = "text/html"): typeof fetch {
    return vi.fn(async (url: string | URL | Request, _opts?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/robots.txt")) {
        if (robotsBody === null) {
          return new Response("", { status: 404 });
        }
        return new Response(robotsBody, { status: 200 });
      }
      return new Response(pageBody, { status: 200, headers: { "content-type": contentType } });
    }) as unknown as typeof fetch;
  }

  it("crawls a single page when robots.txt is absent", async () => {
    const deps: PathHandlerDeps = {
      ...baseDeps,
      fetch: mockFetch(null, "<html><body><h1>Hello</h1><p>World content here.</p></body></html>"),
    };
    const out = await ingestUrl(
      { path: "url", sourceUrl: "https://example.com/about", crawlScope: "page" },
      deps,
    );
    expect(out.chunks.length).toBe(1);
    // html-to-text uppercases h1 by default; check for either form.
    expect(out.chunks[0]!.content.toLowerCase()).toContain("hello");
    expect(out.chunks[0]!.content).toContain("World content");
    expect(out.urlsDiscovered).toBe(1);
    expect(out.urlsIndexed).toBe(1);
  });

  it("respects robots.txt Disallow: /", async () => {
    const deps: PathHandlerDeps = {
      ...baseDeps,
      fetch: mockFetch("User-agent: *\nDisallow: /", "<html>blocked</html>"),
    };
    const out = await ingestUrl(
      { path: "url", sourceUrl: "https://example.com/about", crawlScope: "page" },
      deps,
    );
    expect(out.chunks.length).toBe(0);
    expect(out.urlsIndexed).toBe(0);
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toMatch(/disallow/i);
  });

  it("rejects multi-page crawlScope (V1 only supports 'page')", async () => {
    await expect(
      ingestUrl(
        { path: "url", sourceUrl: "https://example.com", crawlScope: "domain" },
        baseDeps,
      ),
    ).rejects.toThrow(/not implemented in V1/);
  });

  it("skips non-HTML responses with a warning", async () => {
    const deps: PathHandlerDeps = {
      ...baseDeps,
      fetch: mockFetch(null, "PDF binary", "application/pdf"),
    };
    const out = await ingestUrl(
      { path: "url", sourceUrl: "https://example.com/file.pdf", crawlScope: "page" },
      deps,
    );
    expect(out.chunks.length).toBe(0);
    expect(out.urlsIndexed).toBe(0);
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toMatch(/content-type/i);
  });
});
