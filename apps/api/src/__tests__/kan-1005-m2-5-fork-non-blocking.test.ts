/**
 * KAN-1005 M2-5 — non-blocking fork pin in action-decided-push.ts.
 *
 * M2-4 pattern: fork lives in the dispatch-layer subscriber (apps/api),
 * not the engine (packages/api). This file proves:
 *
 *   1. Structural pin (source grep on action-decided-push.ts):
 *      - The sampling fork is wrapped in `void (async () => {...})()`
 *        — fire-and-forget IIFE, doesn't await before ack
 *      - The fork body catches with `try { ... } catch { ... }` so a
 *        sampling-path throw never propagates
 *      - The fork fires AFTER `return c.text('ok', 200)` is set up
 *        (semantically: the ack response is not gated on sampling)
 *      - The catch log mentions "action UNAFFECTED" (operator signal)
 *
 *   2. The engine (packages/api/src/services/run-decision-for-contact.ts)
 *      does NOT import the sampling module — M2-4 pattern enforcement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// __dirname = apps/api/src/__tests__; 4 levels up = repo root.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PUSH_PATH = join(REPO_ROOT, 'apps/api/src/subscribers/action-decided-push.ts');
const ENGINE_PATH = join(REPO_ROOT, 'packages/api/src/services/run-decision-for-contact.ts');

const PUSH_SRC = readFileSync(PUSH_PATH, 'utf8');
const ENGINE_SRC = readFileSync(ENGINE_PATH, 'utf8');

describe('KAN-1005 M2-5 — fork structural shape in action-decided-push.ts', () => {
  it('imports maybeEnqueueSampledReview + resolveSampleRate from ../lib/ (same rootDir)', () => {
    expect(PUSH_SRC).toMatch(
      /import\s+\{[^}]*maybeEnqueueSampledReview[^}]*\}\s+from\s+['"]\.\.\/lib\/human-review-sampling\.js['"]/,
    );
    expect(PUSH_SRC).toMatch(
      /import\s+\{[^}]*resolveSampleRate[^}]*\}\s+from\s+['"]\.\.\/lib\/human-review-sampling\.js['"]/,
    );
  });

  it('fork is fire-and-forget (`void (async () => {...})()`)', () => {
    // Match the IIFE pattern that wraps the fork body.
    const iifePattern = /void\s+\(async\s+\(\)\s*=>\s*\{[\s\S]*?maybeEnqueueSampledReview[\s\S]*?\}\)\(\)/;
    expect(PUSH_SRC).toMatch(iifePattern);
  });

  it('fork body uses try/catch to swallow throws (non-blocking)', () => {
    // The IIFE body must contain `try { ... } catch` around the sampling call.
    const iifeIdx = PUSH_SRC.search(/void\s+\(async\s+\(\)\s*=>\s*\{/);
    expect(iifeIdx).toBeGreaterThan(0);
    // Slice ~3000 chars from the IIFE start (the body).
    const body = PUSH_SRC.slice(iifeIdx, iifeIdx + 3000);
    expect(body).toMatch(/try\s*\{/);
    expect(body).toMatch(/catch\s*\(/);
    expect(body).toMatch(/maybeEnqueueSampledReview/);
  });

  it('fork catch log mentions "action UNAFFECTED" (greppable operator signal)', () => {
    expect(PUSH_SRC).toMatch(/action UNAFFECTED/);
  });

  it('fork fires BEFORE return c.text("ok", 200) but does NOT delay it (void IIFE)', () => {
    // Find the void IIFE start and the return c.text statement.
    const iifeIdx = PUSH_SRC.search(/void\s+\(async\s+\(\)\s*=>/);
    // Look for the NEXT return c.text('ok', 200) after the IIFE.
    const returnPattern = /return\s+c\.text\(['"]ok['"]\s*,\s*200\)/g;
    let lastReturnIdx = -1;
    let m: RegExpExecArray | null;
    while ((m = returnPattern.exec(PUSH_SRC)) !== null) {
      if (m.index > iifeIdx) {
        lastReturnIdx = m.index;
        break;
      }
    }
    expect(iifeIdx).toBeGreaterThan(0);
    expect(lastReturnIdx).toBeGreaterThan(iifeIdx);
    // IIFE sits before the ack-return — semantically: fork is kicked
    // off, response immediately follows. The `void` prevents await.
  });
});

describe('KAN-1005 M2-5 — engine isolation (M2-4 pattern enforcement)', () => {
  it('engine (run-decision-for-contact.ts) does NOT import human-review-sampling', () => {
    // CRITICAL: this is the structural pin that keeps apps/api 157=157.
    // If the engine ever imports the sampling module, apps/api's
    // transitive type chain pulls a new packages/api file into its
    // rootDir-violation cohort (+1 TS6059).
    expect(ENGINE_SRC).not.toMatch(/human-review-sampling/);
    expect(ENGINE_SRC).not.toMatch(/maybeEnqueueSampledReview/);
  });

  it('engine threads decisionSource as a publish-input field (the data-only interface)', () => {
    // M2-4 pattern: engine emits the discriminator as data on
    // action.decided; the subscriber (apps/api) is the one that
    // interprets it for sampling. Engine has zero sampling knowledge
    // beyond emitting the source label.
    expect(ENGINE_SRC).toMatch(/decisionSource:\s*'agentic_live'/);
    expect(ENGINE_SRC).toMatch(/decisionSource:\s*'freeform'/);
    expect(ENGINE_SRC).toMatch(/decisionSource:\s*'playbook'/);
  });
});
