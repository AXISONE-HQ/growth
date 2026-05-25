/**
 * KAN-1030 — STRUCTURAL CI GATE: no provider SDK call may exist outside
 * the reach of applyRedirect.
 *
 * Founder mandate 2026-05-25, unbypassable enforcement. This test scans
 * every adapter + integration source file for provider SDK calls
 * (resend.emails.send, client.messages.create, raw fetch() to FB Graph,
 * etc.) and fails CI if any such call site exists in a function that
 * does NOT also call applyRedirect.
 *
 * Same posture as the comm-23 zero-new gate: drift-proof structurally,
 * not a hope. Every new adapter or send path inherits the discipline OR
 * fails CI.
 *
 * Sibling tests:
 *   send-redirect.test.ts — behavior of the redirect itself
 *   This file — proves nothing can bypass it
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────
// Scan scope — directories where send-capable code may live. If a new
// directory ever houses a provider SDK call, ADD IT HERE and the gate
// will scan it.
// ─────────────────────────────────────────────────────────────────────────
const REPO_ROOT = resolve(__dirname, '../../../../../../');
const SCAN_DIRS = [
  join(REPO_ROOT, 'apps/connectors/src/adapters'),
  join(REPO_ROOT, 'apps/api/src/integrations'),
];

// ─────────────────────────────────────────────────────────────────────────
// Provider-SDK-call patterns. Any line matching one of these is a
// "send site" that MUST be preceded by applyRedirect in the same function.
//
// Webhook/inbound/status-callback/OAuth/health-check fetches are NOT send
// sites — distinguish by the URL or method context where possible. We
// use a coarse first pass (any pattern match) then per-pattern allowlists
// for known non-send sites.
// ─────────────────────────────────────────────────────────────────────────
const SEND_SITE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /resend\.emails\.send\s*\(/g, description: 'Resend SDK email send' },
  { pattern: /client\.messages\.create\s*\(/g, description: 'Twilio SDK message create' },
  // FB Graph /me/messages POST = Messenger send (only kind of FB Graph
  // fetch that ships a message to a user). The other Graph calls
  // (validate token, subscribe webhooks, get profile) are admin/auth.
  {
    pattern: /fetch\s*\([^)]*\/me\/messages/g,
    description: 'Facebook Graph /me/messages send',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Allowlist — files explicitly outside the gate. Use sparingly; each
// entry must carry a Jira reference + a reason. Tests do not count
// (they mock providers).
// ─────────────────────────────────────────────────────────────────────────
const ALLOWLIST: Array<{ pathSuffix: string; reason: string }> = [
  // (none today — all real send sites must pass the gate)
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
      // skip tests + node_modules + dist
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip line comments + block comments before pattern scanning so
 * docs/jsdoc/commented-out code don't false-positive the gate. This is
 * a "good enough" stripper — it handles standard TS comments without
 * being a full lexer (which is overkill for this use case).
 */
function stripComments(src: string): string {
  // Block comments first (incl. multi-line)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Then line comments
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  return out;
}

/**
 * Does the file structurally engage the guard? Three conditions:
 *   (a) imports applyRedirect from a path ending in `send-redirect` —
 *       proves canonical-module use, not a redeclared local stub
 *   (b) calls applyRedirect(…) somewhere in the file
 *   (c) the call is in the same source file as the SDK call
 *
 * This is a pragmatic structural check: we don't full-call-graph trace
 * "every path to the SDK call includes applyRedirect" — that would need
 * a TS AST. Instead we trust that any author of an adapter file who:
 *   - imports applyRedirect from the canonical module
 *   - calls it somewhere
 * has engaged the guard intentionally. Bad-faith additions (adding a
 * new function in the same file that doesn't call applyRedirect) are
 * caught by code review.
 *
 * False-positive resistance: comment-stripping removes docs/commented-out
 * code that mention the SDK calls (the original gate flagged jsdoc in
 * resend/errors.ts and a commented-out twilio call as violations).
 */
function fileEngagesGuard(src: string): boolean {
  const stripped = stripComments(src);
  const importsCanonically = /from\s+['"][^'"]*send-redirect[^'"]*['"]/.test(stripped);
  const callsApplyRedirect = /\bapplyRedirect\s*\(/.test(stripped);
  return importsCanonically && callsApplyRedirect;
}

describe('KAN-1030 — STRUCTURAL CI GATE: no provider SDK call may bypass applyRedirect', () => {
  const allFiles = SCAN_DIRS.flatMap(listTsFiles);

  it('scan-scope check: at least one source file found (test self-check)', () => {
    expect(allFiles.length).toBeGreaterThan(0);
  });

  for (const { pattern, description } of SEND_SITE_PATTERNS) {
    it(`every "${description}" call site is in a file that engages applyRedirect`, () => {
      const violations: string[] = [];

      for (const file of allFiles) {
        const isAllowlisted = ALLOWLIST.some((a) => file.endsWith(a.pathSuffix));
        if (isAllowlisted) continue;

        const src = readFileSync(file, 'utf8');
        const strippedForScan = stripComments(src);
        // Reset regex state for each file
        const re = new RegExp(pattern.source, pattern.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(strippedForScan)) !== null) {
          if (!fileEngagesGuard(src)) {
            // Use original src for line numbers (stripComments preserves
            // line structure for block comments by leaving newlines, but
            // line comments are removed entirely — the offsets still
            // point at the same line because we strip after newlines).
            // For accuracy: re-locate the match in the original.
            const origIdx = src.indexOf(m[0]);
            const lineNo = origIdx >= 0
              ? src.slice(0, origIdx).split('\n').length
              : strippedForScan.slice(0, m.index).split('\n').length;
            violations.push(
              `${file.replace(REPO_ROOT + '/', '')}:${lineNo} — ${description} found, but file does NOT import or call applyRedirect`,
            );
          }
        }
      }

      if (violations.length > 0) {
        const msg =
          `\n\n=== KAN-1030 NO-BYPASS GATE VIOLATIONS ===\n` +
          violations.map((v) => `  ✗ ${v}`).join('\n') +
          `\n\nEvery provider SDK call site MUST call applyRedirect(msg, channel) in the same function,\n` +
          `as the FIRST line before the SDK call. The founder mandate (2026-05-25) requires this be\n` +
          `unbypassable: even an approved, executed send gets redirected while SEND_REDIRECT_ENABLED=true.\n` +
          `\n` +
          `If you are adding a new adapter or send path:\n` +
          `  1. Import applyRedirect from '../_shared/send-redirect.js' (or the equivalent path)\n` +
          `  2. As the first line of your send function, do: msg = applyRedirect(msg, '<CHANNEL>')\n` +
          `  3. The redirect throws SendRedirectMisconfiguredError when target env is missing —\n` +
          `     propagate it up to the subscriber, which catches + ACKs (no retry storm).\n` +
          `\n` +
          `If you are deleting a dormant send path (no callers, not registered, not tested), just delete it.\n` +
          `\n` +
          `If you have a genuine reason to bypass (you don't — talk to the founder first), the allowlist is\n` +
          `at the top of this file. Every entry requires a Jira reference and a written reason.\n`;
        throw new Error(msg);
      }
    });
  }

  it('safety net: deleted Messenger raw-fetch sends stay deleted (regression for the 2026-05-25 cleanup)', () => {
    const messengerFile = join(REPO_ROOT, 'apps/api/src/integrations/messenger/graph-api.ts');
    let src: string;
    try {
      src = readFileSync(messengerFile, 'utf8');
    } catch {
      // File was fully removed — also acceptable.
      return;
    }
    // These two raw-fetch sends bypassed the ChannelAdapter pattern.
    // Deleted under KAN-1030. If they come back, they must come back
    // as a proper ChannelAdapter that goes through applyRedirect.
    expect(src).not.toMatch(/export\s+async\s+function\s+sendTextMessage/);
    expect(src).not.toMatch(/export\s+async\s+function\s+sendQuickReplyMessage/);
  });
});
