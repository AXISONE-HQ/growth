/**
 * KAN-707 PR B — Shared interface for the 3 ingestion path handlers.
 *
 * Each handler takes the raw payload + a deps bundle and returns a list of
 * Chunks ready to embed. Embedding + DB write are orchestrated by the worker
 * binary (apps/knowledge-worker), not by the path handlers themselves —
 * keeps the handlers pure (easy to test) and centralizes embedding cost
 * tracking + status transitions in one place.
 */
import type { Chunk } from "../knowledge-chunker.js";

export interface PathHandlerDeps {
  /**
   * HTTP fetch (injected so tests can stub). Defaults to global `fetch` in
   * the worker; tests pass a mock that returns fixture HTML.
   */
  fetch: typeof globalThis.fetch;
  /**
   * GCS download for type=document. Returns the raw file Buffer. Injected so
   * tests can stub without hitting Cloud Storage.
   */
  downloadFile: (gcsRef: string) => Promise<Buffer>;
}

export type IngestionPathInput =
  | { path: "url"; sourceUrl: string; crawlScope: "page" | "domain" | "sitemap" }
  | { path: "document"; uploadedFileRef: string; originalFileName: string }
  | { path: "qa_pair"; question: string; answer: string };

export interface IngestionPathResult {
  /** Final chunks ready to embed + persist. */
  chunks: Chunk[];
  /** Crawl-only counts; 0 for non-url paths. */
  urlsDiscovered: number;
  urlsIndexed: number;
  /** Soft warnings that didn't fail the path (e.g., crawl partial). */
  warnings: string[];
}

export type PathHandler = (
  input: IngestionPathInput,
  deps: PathHandlerDeps,
) => Promise<IngestionPathResult>;
