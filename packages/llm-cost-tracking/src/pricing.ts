/**
 * Per-model price per million tokens, USD. Used at `llm.call` emit time to
 * compute `costUsd` for the event payload.
 *
 * REVIEW DISCIPLINE — quarterly: Anthropic + OpenAI both adjust prices
 * periodically. `MODEL_PRICING_VERSION` is bumped on each refresh so
 * observability data can be filtered by which pricing snapshot was active.
 * See `feedback_model_pricing_refresh_discipline` memory entry for the
 * audit checklist.
 */
export const MODEL_PRICING_VERSION = '2026-04-29-v1';

interface ModelPrice {
  /** USD per 1M input tokens */
  inputPerMillion: number;
  /** USD per 1M output tokens */
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Anthropic — reasoning + cheap tiers
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  // OpenAI — fallback chain
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  // OpenAI — embedding tier (no output tokens)
  'text-embedding-3-small': { inputPerMillion: 0.02, outputPerMillion: 0 },
};

/**
 * Compute USD cost for a given (model, inputTokens, outputTokens) tuple.
 * Returns 0 for unknown models — better than throwing in the cost-tracking
 * hot path; aggregator (KAN-745 PR B) flags zero-cost rows for review.
 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICING[model];
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}
