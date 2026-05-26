/**
 * KAN-1005 M2-2 — STRUCTURAL CI GATE: no dispatch path may bypass
 * evaluateSendPolicy on the apps/api side.
 *
 * Mirrors KAN-1030's send-redirect no-bypass test (the redirect's
 * downstream sibling). The two gates are layered:
 *
 *   evaluateSendPolicy  (upstream — should we send at all, and now?)
 *         ↓
 *   composeMessage
 *         ↓
 *   guardrail validation (gateAndPublishComposed)
 *         ↓
 *   publishActionSend → connector adapter send() → applyRedirect (KAN-1030)
 *         ↓
 *   provider SDK
 *
 * Every dispatch site (= file calling publishActionSend or
 * gateAndPublishComposed) MUST also call evaluateSendPolicy in the same
 * file. The allowlist covers infrastructure files that wire the gate by
 * dependency injection (cron-deferred-send.ts) and tests/mocks.
 *
 * If you add a new subscriber or dispatch path, you either engage
 * evaluateSendPolicy or you fail this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// __dirname = apps/api/src/__tests__; 4 levels up = repo root.
const REPO_ROOT = resolve(__dirname, '../../../../');
const SCAN_DIRS = [
  join(REPO_ROOT, 'apps/api/src/subscribers'),
  join(REPO_ROOT, 'apps/api/src/internal'),
];

// Dispatch-site patterns. Any line matching one of these triggers the
// "this file must also call evaluateSendPolicy" requirement.
const DISPATCH_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // gateAndPublishComposed routes to publishActionSend internally — gating
  // it is equivalent to gating publishActionSend, and it's the API the
  // engine-path uses.
  {
    pattern: /\bgateAndPublishComposed\s*\(/g,
    description: 'gateAndPublishComposed call (wraps publishActionSend)',
  },
  {
    pattern: /\bpublishActionSend\s*\(/g,
    description: 'publishActionSend direct call',
  },
];

// Files that legitimately reference dispatch APIs without calling
// evaluateSendPolicy themselves. Each entry needs a reason.
const ALLOWLIST: Array<{ pathSuffix: string; reason: string }> = [
  {
    // The cron handler wires the evaluator with publishActionSend +
    // publishActionDecided by dependency injection. The evaluator itself
    // re-runs evaluateSendPolicy before publishing. The cron file
    // references these symbols only to inject them, not to call them.
    pathSuffix: 'apps/api/src/internal/cron-deferred-send.ts',
    reason:
      'KAN-814 cron handler: injects publishActionSend into deferred-send-evaluator, which re-runs evaluateSendPolicy before dispatch. Not a direct dispatch site.',
  },
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

function fileEngagesPolicyGate(src: string): boolean {
  const stripped = stripComments(src);
  // Import path may be static or via variable-specifier dynamic import.
  // Match both the literal source path and the dynamic-import spec string.
  const importsCanonically =
    /from\s+['"][^'"]*send-policy[^'"]*['"]/.test(stripped) ||
    /['"][^'"]*send-policy[^'"]*\.js['"]/.test(stripped);
  const callsEvaluate = /\bevaluateSendPolicy\s*\(/.test(stripped);
  return importsCanonically && callsEvaluate;
}

describe('KAN-1005 M2-2 — STRUCTURAL CI GATE: no dispatch path may bypass evaluateSendPolicy', () => {
  const allFiles = SCAN_DIRS.flatMap(listTsFiles);

  it('scan-scope check: at least one source file found (test self-check)', () => {
    expect(allFiles.length).toBeGreaterThan(0);
  });

  for (const { pattern, description } of DISPATCH_PATTERNS) {
    it(`every "${description}" site is in a file that engages evaluateSendPolicy`, () => {
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
          if (!fileEngagesPolicyGate(src)) {
            const origIdx = src.indexOf(m[0]);
            const lineNo =
              origIdx >= 0
                ? src.slice(0, origIdx).split('\n').length
                : stripped.slice(0, m.index).split('\n').length;
            violations.push(
              `${relPath}:${lineNo} — ${description}, but file does NOT import or call evaluateSendPolicy`,
            );
          }
        }
      }

      if (violations.length > 0) {
        const msg =
          `\n\n=== KAN-1005 M2-2 NO-BYPASS GATE VIOLATIONS ===\n` +
          violations.map((v) => `  ✗ ${v}`).join('\n') +
          `\n\nEvery dispatch site (publishActionSend / gateAndPublishComposed) MUST be in a file\n` +
          `that calls evaluateSendPolicy. Send-policy is the upstream gate — paired with KAN-1030's\n` +
          `applyRedirect as the downstream gate, both mandatory before any send.\n\n` +
          `If you are adding a new subscriber or dispatch path:\n` +
          `  1. Import evaluateSendPolicy (canonical: packages/api/src/services/send-policy.ts,\n` +
          `     or dynamic-import the .js spec for cross-rootDir bypass)\n` +
          `  2. Call evaluateSendPolicy(prisma, tenantId, contactId, { channel }) BEFORE compose/dispatch\n` +
          `  3. Honor all 3 outcomes:\n` +
          `       allow → proceed to dispatch\n` +
          `       defer → persist DeferredSend row (replay_via discriminator: 'action_send' or 'action_decided')\n` +
          `       deny  → best-effort AuditLog.create + 200-ack, NO dispatch\n\n` +
          `If you have a genuine reason to bypass, the allowlist is at the top of this file. Every\n` +
          `entry requires a written reason and ideally a Jira reference. The current single entry\n` +
          `(cron-deferred-send.ts) is justified because the evaluator it invokes re-runs evaluateSendPolicy\n` +
          `before any publish — net effect: the gate still fires.\n`;
        throw new Error(msg);
      }
    });
  }

  it('ordering pin: action-decided-push.ts calls evaluateSendPolicy BEFORE composeMessage (LLM-cost guard)', () => {
    const file = join(REPO_ROOT, 'apps/api/src/subscribers/action-decided-push.ts');
    const src = readFileSync(file, 'utf8');
    const stripped = stripComments(src);
    const policyIdx = stripped.indexOf('evaluateSendPolicy(');
    const composeIdx = stripped.indexOf('composeMessage(');
    expect(policyIdx).toBeGreaterThan(0);
    expect(composeIdx).toBeGreaterThan(0);
    expect(policyIdx).toBeLessThan(composeIdx);
  });

  it('ordering pin: lead-received-push.ts calls evaluateSendPolicy BEFORE publishActionSend (existing KAN-814 behavior preserved)', () => {
    const file = join(REPO_ROOT, 'apps/api/src/subscribers/lead-received-push.ts');
    const src = readFileSync(file, 'utf8');
    const stripped = stripComments(src);
    const policyIdx = stripped.indexOf('evaluateSendPolicy(');
    const publishIdx = stripped.indexOf('publishActionSend(');
    expect(policyIdx).toBeGreaterThan(0);
    expect(publishIdx).toBeGreaterThan(0);
    expect(policyIdx).toBeLessThan(publishIdx);
  });
});
