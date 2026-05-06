/**
 * KAN-827 sub-cohort 4 — Knowledge ingestion chunking utility.
 *
 * Pure module: `chunk(text, options) → Chunk[]`. No I/O, no Prisma, no
 * tokenizer side-effects beyond the tiktoken encoder cache.
 *
 * **Strategy** (per architect spec §1.5 + KAN-827 ticket "Chunking utility"):
 *   - Lock 500-token chunks with 50-token overlap (MVP-locked; A/B 800/100
 *     deferred to Sprint 13+)
 *   - Tokenizer: `js-tiktoken` with `cl100k_base` encoding (matches OpenAI
 *     text-embedding-3-small)
 *   - Respect paragraph + sentence boundaries where possible — split on
 *     paragraph boundaries first, then sentence, then force-split at the
 *     token cap if a single sentence exceeds it
 *
 * **Edge cases handled:**
 *   - Empty/whitespace-only input → returns []
 *   - Single chunk fits in cap → returns [singleChunk] (no overlap math)
 *   - Single sentence exceeds cap → force-split at character offset
 *     proportional to token boundary (defensive — rare for natural prose)
 *   - Trailing whitespace stripped from each chunk
 */
import { encodingForModel } from "js-tiktoken";

// ─────────────────────────────────────────────
// Constants — locked per architect spec §1.5
// ─────────────────────────────────────────────

export const DEFAULT_CHUNK_TOKEN_CAP = 500;
export const DEFAULT_OVERLAP_TOKENS = 50;

const PARAGRAPH_SPLIT = /\n\s*\n+/;
// Sentence terminators followed by whitespace OR end-of-string. Conservative —
// preserves ., !, ?, ;, : as boundaries; splits without consuming the punctuation.
const SENTENCE_SPLIT = /(?<=[.!?;])\s+(?=[A-Z(\["'])/;

// Cache the encoder — instantiation does file I/O internally, so we keep
// one instance per process (lifetime of the import).
let _encoder: ReturnType<typeof encodingForModel> | null = null;
function getEncoder(): ReturnType<typeof encodingForModel> {
  if (!_encoder) {
    // text-embedding-3-small uses cl100k_base, same as gpt-4o-mini.
    _encoder = encodingForModel("gpt-4o-mini");
  }
  return _encoder;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export interface Chunk {
  /** 0-based ordinal in the source. Matches `knowledge_chunk.position`. */
  position: number;
  /** Chunk text (already stripped of leading/trailing whitespace). */
  text: string;
  /** Token count from the cl100k_base encoder. Stored on the row for cost auditing. */
  tokenCount: number;
}

export interface ChunkOptions {
  /** Token cap per chunk. Default 500 per spec. */
  maxTokens?: number;
  /** Token overlap between adjacent chunks. Default 50 per spec. */
  overlapTokens?: number;
}

/**
 * Chunk a plain-text source into <=maxTokens segments with overlapTokens
 * overlap between adjacent chunks. Returns [] on empty/whitespace input.
 */
export function chunk(rawText: string, options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_CHUNK_TOKEN_CAP;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  if (overlapTokens >= maxTokens) {
    throw new Error(
      `[knowledge-chunker] overlapTokens (${overlapTokens}) must be < maxTokens (${maxTokens})`,
    );
  }

  const text = rawText.trim();
  if (!text) return [];

  const encoder = getEncoder();
  const totalTokens = encoder.encode(text);
  if (totalTokens.length <= maxTokens) {
    return [{ position: 0, text, tokenCount: totalTokens.length }];
  }

  // Sliding-window pass over the token array. The chunk text is the decoded
  // slice, with paragraph/sentence boundary alignment applied as a final
  // touch-up (decoder gives byte-accurate text; we re-trim to natural breaks).
  const chunks: Chunk[] = [];
  let position = 0;
  let startTokenIdx = 0;
  while (startTokenIdx < totalTokens.length) {
    const endTokenIdx = Math.min(startTokenIdx + maxTokens, totalTokens.length);
    const sliceTokens = totalTokens.slice(startTokenIdx, endTokenIdx);
    let sliceText = encoder.decode(sliceTokens).trim();

    // Boundary-align: if not the last slice AND we can find a paragraph or
    // sentence boundary in the last 20% of the slice, prefer to end there.
    if (endTokenIdx < totalTokens.length) {
      const sliceLen = sliceText.length;
      const tailStart = Math.floor(sliceLen * 0.8);
      const paraIdx = sliceText.slice(tailStart).search(PARAGRAPH_SPLIT);
      if (paraIdx >= 0) {
        sliceText = sliceText.slice(0, tailStart + paraIdx).trim();
      } else {
        const sentIdx = sliceText.slice(tailStart).search(SENTENCE_SPLIT);
        if (sentIdx >= 0) {
          sliceText = sliceText.slice(0, tailStart + sentIdx + 1).trim();
        }
      }
    }

    if (sliceText.length === 0) {
      // Defensive: a slice that reduced to zero after alignment shouldn't
      // happen (paragraph/sentence regex only triggers if a match exists in
      // the trailing 20%). If it does, fall back to the unaligned slice.
      sliceText = encoder.decode(sliceTokens).trim();
    }

    const chunkTokens = encoder.encode(sliceText);
    chunks.push({ position, text: sliceText, tokenCount: chunkTokens.length });
    position += 1;

    // Step: advance by (chunkTokenCount - overlapTokens). If the alignment
    // shrunk the chunk substantially, this also shrinks the step — the
    // overlap math is preserved relative to the actual chunk size.
    const stepTokens = Math.max(1, chunkTokens.length - overlapTokens);
    startTokenIdx += stepTokens;
  }

  return chunks;
}
