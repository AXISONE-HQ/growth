/**
 * KAN-827 sub-cohort 5 — Knowledge ingestion embedder.
 *
 * Pure module: `embed(chunks) → EmbeddedChunk[]`. Calls OpenAI embeddings API
 * (text-embedding-3-small, 1536 dim per architect spec §1.1 locked decision).
 *
 * **Resilience:**
 *   - Per-chunk retry with exponential backoff on transient failures
 *     (network, 429, 5xx) — 3 attempts total per chunk, sleeps 500ms / 1s / 2s
 *   - On final failure: throw EmbeddingFailedError with the chunk that failed
 *     so the caller can mark `knowledge_source.status = 'error'` with detail
 *
 * **Cost integration deferred** to KAN-734 follow-up (worker-side cost
 * visibility gap per memory `feedback_kan_734_worker_cost_visibility_gap`).
 * For Sprint 11a MVP we don't emit `llm.call` events from the embedder —
 * KAN-734 / Sprint 5 follow-up will wire this in.
 */
import OpenAI from "openai";
import type { Chunk } from "./knowledge-chunker.js";

// ─────────────────────────────────────────────
// Constants — locked per architect spec §1.1
// ─────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const MAX_ATTEMPTS = 3;

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

export class EmbeddingFailedError extends Error {
  constructor(
    message: string,
    public readonly position: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingFailedError";
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export interface EmbedOptions {
  /** Override the default OpenAI client (testing). */
  client?: OpenAI;
  /** Override max attempts (testing). */
  maxAttempts?: number;
}

/**
 * Embed each chunk via OpenAI text-embedding-3-small (1536 dim). Retries
 * transient failures up to MAX_ATTEMPTS times per chunk; throws
 * EmbeddingFailedError on final failure with the failing chunk's position.
 *
 * Embeds the chunk's `text` for paste_text/pdf paths. For FAQ pairs the
 * caller may pre-process so that `text` is the question (stored separately
 * from the answer in metadata) — this module is agnostic; it embeds whatever
 * `text` is passed in.
 */
export async function embed(
  chunks: Chunk[],
  options: EmbedOptions = {},
): Promise<EmbeddedChunk[]> {
  if (chunks.length === 0) return [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !options.client) {
    throw new Error("[knowledge-embedder] OPENAI_API_KEY not configured");
  }
  const client = options.client ?? new OpenAI({ apiKey });
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;

  const results: EmbeddedChunk[] = [];
  for (const c of chunks) {
    const vec = await embedSingleWithRetry(client, c, maxAttempts);
    results.push({ ...c, embedding: vec });
  }
  return results;
}

async function embedSingleWithRetry(
  client: OpenAI,
  chunk: Chunk,
  maxAttempts: number,
): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: chunk.text,
        dimensions: EMBEDDING_DIMENSIONS,
      });
      const vec = response.data[0]?.embedding;
      if (!vec || vec.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `[knowledge-embedder] OpenAI returned vector of length ${vec?.length ?? 0}, expected ${EMBEDDING_DIMENSIONS}`,
        );
      }
      return vec;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 500 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new EmbeddingFailedError(
    `Failed to embed chunk position=${chunk.position} after ${maxAttempts} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`,
    chunk.position,
    lastErr,
  );
}
