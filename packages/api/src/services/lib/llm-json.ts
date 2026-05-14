/**
 * KAN-917 — Strip markdown code fences from LLM output and parse JSON.
 *
 * Haiku/Sonnet occasionally wrap JSON in ```json...``` or ```...``` fences
 * despite "JSON only" system prompts. The model ignores prompt-side
 * instructions ~once-in-a-while; the parser is the right place to handle
 * this consistently across every LLM consumer.
 *
 * Default (strict) mode: trim → strip-fence-if-fully-wrapped → JSON.parse.
 *   - Matches the existing inline pattern at 5 sites (brain-service,
 *     pipeline-router, message-shaper, message-composer, apps/api/src/llm.ts).
 *     Those sites can migrate to this helper later (KAN-918).
 *   - Anchored at both ends — partial fence-wrapped output (no closing
 *     fence) falls through to raw parse and surfaces a real error.
 *
 * Lenient mode (`tolerateLeadingText: true`): on strict failure, greedy
 * shape-scoped regex extract (`[...]` or `{...}`), strip fences inside
 * the extract, retry parse. Preserves the 3 import-pipeline parsers'
 * day-one contract of tolerating prelude text like "Sure! Here's the
 * mapping: [...]". Caller must declare `expectedShape: 'array' | 'object'`
 * to scope the regex.
 *
 * The error preserves the FULL rawOutput on the exception instance so
 * downstream loggers can grep PROD logs by the raw response shape — see
 * the `[import-projection] Unknown` channel for the same discipline
 * (feedback_enum_coercion_lossy_v1).
 */

export class LlmJsonParseError extends Error {
  constructor(
    public readonly rawOutput: string,
    public readonly underlying?: Error,
  ) {
    const preview = rawOutput.slice(0, 500);
    const truncated = rawOutput.length > 500 ? ' (truncated)' : '';
    super(
      `LLM returned unparseable JSON output. Raw preview${truncated}: ${preview}`,
    );
    this.name = 'LlmJsonParseError';
  }
}

export interface ParseJsonFromLlmOptions {
  /**
   * If true, fall back to greedy regex extract when strict parse fails.
   * Tolerates leading explanation text like "Sure! Here's the mapping: [...]".
   * Requires `expectedShape` to scope the regex.
   * Default: false (strict mode).
   */
  tolerateLeadingText?: boolean;
  /**
   * Required when tolerateLeadingText=true. Determines whether the greedy
   * regex extract looks for `[...]` (array) or `{...}` (object).
   */
  expectedShape?: 'array' | 'object';
}

export function parseJsonFromLlm<T = unknown>(
  rawOutput: string,
  options?: ParseJsonFromLlmOptions,
): T {
  if (rawOutput == null || rawOutput.trim() === '') {
    throw new LlmJsonParseError(rawOutput ?? '');
  }

  // Strict path: trim + strip fence + parse.
  const stripped = stripCodeFence(rawOutput.trim());
  try {
    return JSON.parse(stripped) as T;
  } catch (strictErr) {
    if (!options?.tolerateLeadingText) {
      throw new LlmJsonParseError(
        rawOutput,
        strictErr instanceof Error ? strictErr : new Error(String(strictErr)),
      );
    }

    // Lenient fallback: greedy shape-scoped regex extract, strip fences
    // inside the extract, retry parse. The fence-strip inside is for the
    // case where Haiku returns "Sure, here's the mapping:\n\n```json\n[...]\n```"
    // — the regex grabs from `[` to the last `]`, which excludes the
    // fences, so the inner strip is a no-op here. But if Haiku ever
    // returns `[ "```", ... ]` (fence inside JSON string), the inner
    // strip leaves the JSON intact because the outer brackets are
    // already excluded from the fence regex anchor.
    const shape = options.expectedShape ?? 'array';
    const pattern = shape === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
    const match = rawOutput.match(pattern);
    if (!match) {
      throw new LlmJsonParseError(
        rawOutput,
        strictErr instanceof Error ? strictErr : new Error(String(strictErr)),
      );
    }
    const extracted = stripCodeFence(match[0].trim());
    try {
      return JSON.parse(extracted) as T;
    } catch (extractErr) {
      throw new LlmJsonParseError(
        rawOutput,
        extractErr instanceof Error ? extractErr : new Error(String(extractErr)),
      );
    }
  }
}

function stripCodeFence(input: string): string {
  // Match: ```<optional language tag>\n<content>\n```
  // - Language tag is optional (handles ```json, ```JSON, ```javascript, plain ```)
  // - Whitespace/newlines around fences tolerated
  // - Greedy content match within the fence pair
  // - Anchored at ^ and $ — leading explanation falls through unchanged
  //   (lenient mode in the caller handles those via regex extract)
  const fenceMatch = input.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch && fenceMatch[1] != null) {
    return fenceMatch[1].trim();
  }
  return input;
}
