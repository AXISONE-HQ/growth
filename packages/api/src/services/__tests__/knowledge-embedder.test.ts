/**
 * KAN-827 sub-cohort 6 — knowledge-embedder tests.
 *
 * OpenAI client mocked. Tests cover: happy-path embedding, transient-failure
 * retry success, exhausted retries → EmbeddingFailedError with correct
 * position. Verifies dimension validation (mismatched length throws).
 */
import { describe, it, expect, vi } from "vitest";
import { embed, EmbeddingFailedError } from "../knowledge-embedder.js";
import type { Chunk } from "../knowledge-chunker.js";

function makeMockClient(
  embeddingsCreate: ReturnType<typeof vi.fn>,
): { embeddings: { create: ReturnType<typeof vi.fn> } } {
  return { embeddings: { create: embeddingsCreate } };
}

const HAPPY_VEC = Array.from({ length: 1536 }, () => 0.1);
const SHORT_VEC = Array.from({ length: 100 }, () => 0.1);

describe("knowledge-embedder", () => {
  it("embeds chunks happy-path: returns EmbeddedChunk[] with vectors of length 1536", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ embedding: HAPPY_VEC }] });
    const client = makeMockClient(create);
    const chunks: Chunk[] = [
      { position: 0, text: "first", tokenCount: 5 },
      { position: 1, text: "second", tokenCount: 5 },
    ];

    const result = await embed(chunks, { client: client as never });

    expect(result).toHaveLength(2);
    expect(result[0]!.embedding).toHaveLength(1536);
    expect(result[0]!.position).toBe(0);
    expect(result[1]!.position).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries on transient failure and succeeds before exhausting attempts", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("network reset"))
      .mockRejectedValueOnce(new Error("429 rate limit"))
      .mockResolvedValue({ data: [{ embedding: HAPPY_VEC }] });
    const client = makeMockClient(create);

    const result = await embed(
      [{ position: 0, text: "x", tokenCount: 1 }],
      { client: client as never, maxAttempts: 3 },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.embedding).toHaveLength(1536);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("throws EmbeddingFailedError after exhausted retries with correct position", async () => {
    const create = vi.fn().mockRejectedValue(new Error("upstream timeout"));
    const client = makeMockClient(create);

    await expect(
      embed(
        [
          { position: 0, text: "first", tokenCount: 5 },
          { position: 1, text: "second", tokenCount: 5 },
        ],
        { client: client as never, maxAttempts: 2 },
      ),
    ).rejects.toMatchObject({
      name: "EmbeddingFailedError",
      position: 0,
      message: expect.stringContaining("position=0"),
    });

    // First chunk's retries exhausted — should NOT proceed to second.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("throws on dimension mismatch (defensive — OpenAI returned wrong length)", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ embedding: SHORT_VEC }] });
    const client = makeMockClient(create);

    await expect(
      embed([{ position: 0, text: "x", tokenCount: 1 }], { client: client as never, maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(EmbeddingFailedError);
  });

  it("returns [] on empty input without invoking client", async () => {
    const create = vi.fn();
    const client = makeMockClient(create);

    const result = await embed([], { client: client as never });

    expect(result).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});
