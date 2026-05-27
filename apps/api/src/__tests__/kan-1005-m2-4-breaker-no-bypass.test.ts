/**
 * KAN-1005 M2-4 — STRUCTURAL CI GATE: every decision-engine invocation
 * must be preceded by evaluateBreakerState.
 *
 * Mirrors the M2-2 send-policy no-bypass test (apps/api/src/__tests__/
 * kan-1005-m2-2-send-policy-no-bypass.test.ts). Scans
 * apps/api/src/subscribers/ for any file that calls
 * `runDecisionForContact` and requires it ALSO call `evaluateBreakerState`
 * — the caller-reads-Redis-passes-to-engine pattern. Without this gate,
 * a future subscriber could invoke the engine and skip the breaker
 * state entirely, defeating the machine-speed pause.
 *
 * If you add a new subscriber that invokes the Decision Engine:
 *   1. Import evaluateBreakerState from '../lib/circuit-breaker.js'
 *      (or use the variable-specifier dynamic-import pattern)
 *   2. Call `await evaluateBreakerState(getRedisClient(), tenantId)`
 *      BEFORE invoking the engine
 *   3. Pass the result as `breakerState` to `runDecisionForContact`
 *
 * Allowlist exists for tests + DLQ replay paths that legitimately don't
 * engage the breaker; require a written reason per entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// __dirname = apps/api/src/__tests__; 4 levels up = repo root.
const REPO_ROOT = resolve(__dirname, '../../../../');
const SCAN_DIRS = [
  join(REPO_ROOT, 'apps/api/src/subscribers'),
];

// Engine-invocation patterns. Any line matching one of these is an
// "engine call site" that MUST be in a file that engages the breaker.
const ENGINE_INVOCATION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\brunDecisionForContact\s*\(/g,
    description: 'runDecisionForContact direct call',
  },
];

// Files explicitly outside the gate. Each entry needs a reason.
const ALLOWLIST: Array<{ pathSuffix: string; reason: string }> = [
  // KAN-1018 DLQ subscriber: replays dead-lettered messages for diagnostic
  // logging; does NOT invoke the engine. Listed only as defense against
  // false positives in the grep — the actual file has no runDecisionForContact
  // call. (No entry needed today; placeholder for future DLQ-replay paths.)
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  return out;
}

function fileEngagesBreaker(src: string): boolean {
  const stripped = stripComments(src);
  // Match either a static import OR a dynamic-import spec string.
  const importsCanonically =
    /from\s+['"][^'"]*circuit-breaker[^'"]*['"]/.test(stripped) ||
    /['"][^'"]*circuit-breaker[^'"]*\.js['"]/.test(stripped);
  const callsEvaluate = /\bevaluateBreakerState\s*\(/.test(stripped);
  return importsCanonically && callsEvaluate;
}

describe('KAN-1005 M2-4 — STRUCTURAL CI GATE: every engine invocation reads breakerState', () => {
  const allFiles = SCAN_DIRS.flatMap(listTsFiles);

  it('scan-scope check: at least one source file found (test self-check)', () => {
    expect(allFiles.length).toBeGreaterThan(0);
  });

  for (const { pattern, description } of ENGINE_INVOCATION_PATTERNS) {
    it(`every "${description}" site is in a file that engages evaluateBreakerState`, () => {
      const violations: string[] = [];

      for (const file of allFiles) {
        const relPath = file.replace(REPO_ROOT + '/', '');
        const isAllowlisted = ALLOWLIST.some((a) => relPath.endsWith(a.pathSuffix));
        if (isAllowlisted) continue;

        const src = readFileSync(file, 'utf8');
        const stripped = stripComments(src);
        const re = new RegExp(pattern.source, pattern.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped)) !== null) {
          if (!fileEngagesBreaker(src)) {
            const origIdx = src.indexOf(m[0]);
            const lineNo =
              origIdx >= 0
                ? src.slice(0, origIdx).split('\n').length
                : stripped.slice(0, m.index).split('\n').length;
            violations.push(
              `${relPath}:${lineNo} — ${description}, but file does NOT import or call evaluateBreakerState`,
            );
          }
        }
      }

      if (violations.length > 0) {
        const msg =
          `\n\n=== KAN-1005 M2-4 NO-BYPASS GATE VIOLATIONS ===\n` +
          violations.map((v) => `  ✗ ${v}`).join('\n') +
          `\n\nEvery Decision Engine invocation in apps/api/src/subscribers/ MUST be in a file\n` +
          `that calls evaluateBreakerState BEFORE the engine call (caller-reads-Redis-passes-to-engine).\n` +
          `Without this, a tripped breaker won't reach the threshold-gate ladder and the\n` +
          `machine-speed pause is defeated for this code path.\n\n` +
          `If you are adding a new subscriber that invokes the Decision Engine:\n` +
          `  1. Import evaluateBreakerState (canonical: apps/api/src/lib/circuit-breaker.ts)\n` +
          `  2. Call \`await evaluateBreakerState(getRedisClient(), tenantId)\` BEFORE the engine call\n` +
          `  3. Pass the result as \`breakerState\` to runDecisionForContact\n` +
          `  4. The engine threads breakerState to evaluateThresholdWithMatrix → evaluateThreshold\n` +
          `     step 3, which routes to human_review when tripped.\n\n` +
          `If you have a genuine reason to bypass (e.g., a DLQ-replay path that doesn't dispatch),\n` +
          `the allowlist is at the top of this file. Every entry requires a written reason.\n`;
        throw new Error(msg);
      }
    });
  }

  it('ordering pin: decision-run-push.ts calls evaluateBreakerState BEFORE runDecisionForContact', () => {
    const file = join(REPO_ROOT, 'apps/api/src/subscribers/decision-run-push.ts');
    const src = readFileSync(file, 'utf8');
    const stripped = stripComments(src);
    const breakerIdx = stripped.indexOf('evaluateBreakerState(');
    const engineIdx = stripped.indexOf('runDecisionForContact(prisma');
    expect(breakerIdx).toBeGreaterThan(0);
    expect(engineIdx).toBeGreaterThan(0);
    expect(breakerIdx).toBeLessThan(engineIdx);
  });

  it('decision-run-push.ts passes breakerState to runDecisionForContact (not just reads, also threads)', () => {
    const file = join(REPO_ROOT, 'apps/api/src/subscribers/decision-run-push.ts');
    const src = readFileSync(file, 'utf8');
    const stripped = stripComments(src);
    // Look for `breakerState` field passed in the runDecisionForContact args object.
    expect(stripped).toMatch(/breakerState,/);
  });
});
