/**
 * KAN-707 PR B — Token-based chunker for the knowledge ingestion pipeline.
 *
 * Tokenizer: js-tiktoken cl100k_base. Compatible with OpenAI
 * text-embedding-3-small (the embedding model declared in llm-client.ts
 * TIER_MAP.embedding.primary).
 *
 * Footgun guard: chunk-time and embedding-time MUST agree on tokenizer. The
 * embedding endpoint quietly truncates inputs >8191 tokens silently; if our
 * chunker produced 4000-token chunks but used a different tokenizer, what
 * we count as 4000 might be 4500 to OpenAI and the tail gets dropped. By
 * pinning cl100k_base on both sides (embedding API uses it implicitly), the
 * chunk size is what gets embedded.
 *
 * Defaults:
 *   - CHUNK_SIZE_TOKENS = 500   — balances retrieval granularity and embedding
 *                                 cost. text-embedding-3-small is cheap so
 *                                 smaller chunks are fine; smaller chunks =
 *                                 better localized retrieval at a higher
 *                                 fan-out cost in the worker.
 *   - CHUNK_OVERLAP_TOKENS = 50 — preserves context across chunk boundaries
 *                                 without blowing up storage. 10% overlap is
 *                                 a common-sense default; tune later.
 *
 * Both constants are exported for the wizard / future tenant-config UI to
 * read; KAN-707 PR B does NOT expose them as tenant-tunable yet.
 */
import { Tiktoken, getEncoding } from "js-tiktoken";

export const CHUNK_SIZE_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 50;
export const TOKENIZER_NAME = "cl100k_base" as const;

let cached: Tiktoken | null = null;
function tokenizer(): Tiktoken {
  if (!cached) cached = getEncoding(TOKENIZER_NAME);
  return cached;
}

export interface Chunk {
  /** 0-based index of this chunk within the source's full chunk sequence. */
  index: number;
  /** Total chunks the source was split into. Stored on every chunk for "X of N" UI. */
  total: number;
  /** Plain-text content of the chunk, ready to feed to the embedding API. */
  content: string;
  /** Token count of the chunk content (NOT counting overlap with neighbors). */
  tokenCount: number;
}

export interface ChunkOptions {
  size?: number;
  overlap?: number;
}

/**
 * Split a plain-text string into token-windowed chunks with overlap.
 *
 * Edge cases:
 *   - Empty / whitespace-only input → returns []
 *   - Input shorter than `size` → returns a single chunk (total=1)
 *   - `overlap >= size` → throws (invalid config)
 *   - Each chunk is decoded back from token IDs, so the boundary always
 *     lands on a complete token (no broken UTF-8 / multi-byte issues)
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const size = options.size ?? CHUNK_SIZE_TOKENS;
  const overlap = options.overlap ?? CHUNK_OVERLAP_TOKENS;
  if (overlap >= size) {
    throw new Error(`chunkText: overlap (${overlap}) must be < size (${size})`);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const enc = tokenizer();
  const tokens = enc.encode(trimmed);
  if (tokens.length === 0) return [];

  // Single-chunk fast path — input fits in one window.
  if (tokens.length <= size) {
    return [{ index: 0, total: 1, content: trimmed, tokenCount: tokens.length }];
  }

  const chunks: Chunk[] = [];
  const stride = size - overlap;
  let start = 0;
  while (start < tokens.length) {
    const end = Math.min(start + size, tokens.length);
    const slice = tokens.slice(start, end);
    chunks.push({
      index: chunks.length,
      total: 0, // patched below
      content: enc.decode(slice),
      tokenCount: slice.length,
    });
    if (end >= tokens.length) break;
    start += stride;
  }
  // Backfill `total` now that we know the count.
  for (const c of chunks) c.total = chunks.length;
  return chunks;
}
