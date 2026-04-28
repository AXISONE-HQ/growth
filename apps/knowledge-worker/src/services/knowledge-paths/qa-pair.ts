/**
 * KAN-707 PR B — Q&A pair ingestion path.
 *
 * Simplest path. Concatenate `Q: <question>\nA: <answer>` into a single text
 * blob, then chunk. Most Q&A pairs fit in a single chunk; long Q&As fall
 * back to the standard chunker windowing.
 *
 * Both question and answer feed into retrieval similarity (embedding the
 * concatenation matches typical "Q&A → retrieval → answer surfaced when the
 * tenant asks something semantically close to either Q or A").
 */
import { chunkText } from "../knowledge-chunker.js";
import type { IngestionPathInput, IngestionPathResult, PathHandler } from "./types.js";

export const ingestQaPair: PathHandler = async (input: IngestionPathInput): Promise<IngestionPathResult> => {
  if (input.path !== "qa_pair") {
    throw new Error(`ingestQaPair: wrong path discriminator ${input.path}`);
  }
  const text = `Q: ${input.question.trim()}\nA: ${input.answer.trim()}`;
  const chunks = chunkText(text);
  return {
    chunks,
    urlsDiscovered: 0,
    urlsIndexed: 0,
    warnings: [],
  };
};
