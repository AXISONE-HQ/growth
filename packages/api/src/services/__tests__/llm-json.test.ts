import { describe, it, expect } from 'vitest';
import { parseJsonFromLlm, LlmJsonParseError } from '../lib/llm-json.js';

describe('parseJsonFromLlm — strict mode (default)', () => {
  it('parses plain JSON (idempotent on non-fenced input)', () => {
    expect(parseJsonFromLlm('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it('parses ```json-wrapped output', () => {
    expect(parseJsonFromLlm('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('parses ```JSON uppercase language tag', () => {
    expect(parseJsonFromLlm('```JSON\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('parses plain ``` fences (no language tag)', () => {
    expect(parseJsonFromLlm('```\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('parses ```javascript fences', () => {
    expect(parseJsonFromLlm('```javascript\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('tolerates whitespace around fences', () => {
    expect(parseJsonFromLlm('  ```json  \n[{"a":1}]\n  ```  ')).toEqual([{ a: 1 }]);
  });

  it('parses object responses', () => {
    expect(parseJsonFromLlm('```json\n{"entity_type":"contacts","confidence":0.92}\n```')).toEqual({
      entity_type: 'contacts',
      confidence: 0.92,
    });
  });

  // Strict mode: leading-text-then-fence is DELIBERATELY rejected.
  // Lenient mode (next describe block) accepts these.
  it('REJECTS leading explanation + fenced JSON (strict default)', () => {
    const input = 'Here is the result:\n\n```json\n[{"a":1}]\n```';
    expect(() => parseJsonFromLlm(input)).toThrow(LlmJsonParseError);
  });

  it('REJECTS trailing prose after fenced JSON', () => {
    const input = '```json\n[{"a":1}]\n```\n\nNote: row 7 was ambiguous.';
    expect(() => parseJsonFromLlm(input)).toThrow(LlmJsonParseError);
  });

  it('throws LlmJsonParseError on truncated output (no closing fence)', () => {
    let caught: LlmJsonParseError | undefined;
    try {
      parseJsonFromLlm('```json\n[{"a":1}');
    } catch (err) {
      caught = err as LlmJsonParseError;
    }
    expect(caught).toBeInstanceOf(LlmJsonParseError);
    expect(caught!.rawOutput).toBe('```json\n[{"a":1}');
    expect(caught!.underlying).toBeDefined();
  });

  it('throws on empty string', () => {
    expect(() => parseJsonFromLlm('')).toThrow(LlmJsonParseError);
  });

  it('throws on whitespace-only input', () => {
    expect(() => parseJsonFromLlm('   \n\t  ')).toThrow(LlmJsonParseError);
  });

  it('throws on null/undefined input', () => {
    expect(() => parseJsonFromLlm(null as unknown as string)).toThrow(LlmJsonParseError);
    expect(() => parseJsonFromLlm(undefined as unknown as string)).toThrow(LlmJsonParseError);
  });

  it('throws LlmJsonParseError with underlying when JSON inside valid fences is malformed', () => {
    let caught: LlmJsonParseError | undefined;
    try {
      parseJsonFromLlm('```json\n[{a:1}]\n```');
    } catch (err) {
      caught = err as LlmJsonParseError;
    }
    expect(caught).toBeInstanceOf(LlmJsonParseError);
    expect(caught!.rawOutput).toBe('```json\n[{a:1}]\n```');
    expect(caught!.underlying).toBeDefined();
  });

  it('preserves raw output (full, not just preview) on the error instance', () => {
    const longInput = 'x'.repeat(600); // > 500 char preview cap
    let caught: LlmJsonParseError | undefined;
    try {
      parseJsonFromLlm(longInput);
    } catch (err) {
      caught = err as LlmJsonParseError;
    }
    expect(caught!.rawOutput).toBe(longInput);
    expect(caught!.rawOutput.length).toBe(600);
    expect(caught!.message).toContain('(truncated)');
    expect(caught!.message.length).toBeLessThan(700); // preview capped at 500
  });

  it('supports generic type parameter for caller type safety', () => {
    interface Mapping {
      sourceColumn: string;
      targetField: string;
      confidence: number;
    }
    const result = parseJsonFromLlm<Mapping[]>(
      '[{"sourceColumn":"email","targetField":"email","confidence":100}]',
    );
    expect(result[0].sourceColumn).toBe('email');
  });
});

describe('parseJsonFromLlm — lenient mode (tolerateLeadingText: true)', () => {
  it('parses leading explanation + fenced JSON (the case Fred hit)', () => {
    const input = 'Sure! Here is the mapping:\n\n```json\n[{"a":1}]\n```';
    expect(
      parseJsonFromLlm(input, { tolerateLeadingText: true, expectedShape: 'array' }),
    ).toEqual([{ a: 1 }]);
  });

  it('parses leading explanation without fences (greedy regex extract)', () => {
    const input = 'Sure! Here is the mapping: [{"a":1}, {"b":2}]';
    expect(
      parseJsonFromLlm(input, { tolerateLeadingText: true, expectedShape: 'array' }),
    ).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('parses trailing prose after array', () => {
    const input = '[{"a":1}]\n\nNote: row 7 was ambiguous.';
    expect(
      parseJsonFromLlm(input, { tolerateLeadingText: true, expectedShape: 'array' }),
    ).toEqual([{ a: 1 }]);
  });

  it('parses object shape with leading explanation', () => {
    const input = "Here's the detection:\n\n```json\n{\"entity_type\":\"contacts\"}\n```";
    expect(
      parseJsonFromLlm(input, { tolerateLeadingText: true, expectedShape: 'object' }),
    ).toEqual({ entity_type: 'contacts' });
  });

  it('defaults expectedShape to "array" when omitted', () => {
    const input = 'prelude [{"a":1}] postlude';
    expect(parseJsonFromLlm(input, { tolerateLeadingText: true })).toEqual([{ a: 1 }]);
  });

  it('still parses clean strict input (lenient never engages)', () => {
    expect(
      parseJsonFromLlm('[{"a":1}]', { tolerateLeadingText: true, expectedShape: 'array' }),
    ).toEqual([{ a: 1 }]);
    expect(
      parseJsonFromLlm('```json\n[{"a":1}]\n```', {
        tolerateLeadingText: true,
        expectedShape: 'array',
      }),
    ).toEqual([{ a: 1 }]);
  });

  it('still throws when no JSON-shaped block exists anywhere', () => {
    const input = "I'm not sure how to map this CSV — could you provide more context?";
    expect(() =>
      parseJsonFromLlm(input, { tolerateLeadingText: true, expectedShape: 'array' }),
    ).toThrow(LlmJsonParseError);
  });

  it('still throws when extracted block is malformed JSON', () => {
    const input = 'Here: [{a:1}]';
    expect(() =>
      parseJsonFromLlm(input, { tolerateLeadingText: true, expectedShape: 'array' }),
    ).toThrow(LlmJsonParseError);
  });

  it('preserves the original rawOutput on lenient-path error', () => {
    const input = 'Here: [{a:1}]';
    let caught: LlmJsonParseError | undefined;
    try {
      parseJsonFromLlm(input, { tolerateLeadingText: true, expectedShape: 'array' });
    } catch (err) {
      caught = err as LlmJsonParseError;
    }
    expect(caught!.rawOutput).toBe(input);
  });

  it('expectedShape scopes the regex but does NOT enforce result type — caller must shape-check downstream', () => {
    // expectedShape='object' on input that has both `{...}` and `[...]` will
    // extract the OBJECT inside the array (`{a:1}`). It returns valid JSON
    // but not the shape the caller wanted. The 3 import-pipeline parsers
    // ALL run an `Array.isArray(parsed)` / shape check after parseJsonFromLlm
    // — this is the canonical pattern.
    const input = 'prelude [{"a":1}] postlude';
    const result = parseJsonFromLlm(input, {
      tolerateLeadingText: true,
      expectedShape: 'object',
    });
    expect(result).toEqual({ a: 1 });
  });
});
