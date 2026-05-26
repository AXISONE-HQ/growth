/**
 * KAN-1005 M2-1 — STRUCTURAL CI GATE: no `outcome: 'EXECUTED'` assignment
 * in the engine path may bypass evaluateThresholdWithMatrix.
 *
 * Why this exists: M2-6b will flip autoApproveEnabled=true. From that
 * moment forward, every `outcome='EXECUTED'` is an autonomous dispatch.
 * The governance gates (daily-action-limit + autoEscalateFlags +
 * aiPermissions) live INSIDE evaluateThresholdWithMatrix; any code path
 * that sets outcome='EXECUTED' without going through that gate would
 * bypass the entire M2-1 governance package.
 *
 * Sibling discipline to the KAN-1030 send-redirect no-bypass gate. The
 * gates are only load-bearing if NOTHING flanks them.
 *
 * Allowlist (documented exceptions):
 *   - runPlaybookStep (run-decision-for-contact.ts) — adapter mode for
 *     human-configured playbook steps. The human pre-approves by
 *     configuring the playbook; the engine just executes the
 *     predetermined instruction. Not autonomous-from-the-engine's-
 *     perspective. Send-safety is still enforced by KAN-1030's redirect
 *     guardrail (every provider SDK call goes through applyRedirect).
 *     If/when playbook mode ever transitions to engine-driven autonomy,
 *     this allowlist entry must be removed and gating added.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_DECISION_FILE = resolve(
  __dirname,
  '../../services/run-decision-for-contact.ts',
);

// Allowlist — every entry needs a documented reason.
const ALLOWLISTED_EXECUTED_ASSIGNMENTS = [
  {
    // runPlaybookStep at ~line 772 of run-decision-for-contact.ts
    contextMatch: /runPlaybookStep|playbook/i,
    reason:
      'Playbook adapter mode (KAN-655): human-configured pre-approved step. Send-safety enforced by KAN-1030 applyRedirect on every provider call.',
  },
];

function stripComments(src: string): string {
  // Drop block comments + line comments so we don't false-positive on
  // doc references like "// outcome: 'EXECUTED' →".
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  return out;
}

describe('KAN-1005 M2-1 — STRUCTURAL: no `outcome: \'EXECUTED\'` bypass of evaluateThresholdWithMatrix', () => {
  it('every executable EXECUTED assignment in run-decision-for-contact.ts is gated OR allowlisted', () => {
    const src = readFileSync(RUN_DECISION_FILE, 'utf8');
    const stripped = stripComments(src);

    // Match assignments / returns like:
    //   outcome: 'EXECUTED'
    //   outcome = 'EXECUTED'
    //   const outcome: 'EXECUTED' = 'EXECUTED'
    //   outcome: 'EXECUTED' | 'ESCALATED' = gateResult.outcome   ← ALLOW (gate-derived)
    //
    // The intent: literal-EXECUTED assignments that aren't downstream
    // of a gate call are violations. Anything reading from
    // `gateResult.outcome` / `gateDecision.outcome` is by definition
    // gated.
    const pattern = /['"`]EXECUTED['"`]/g;
    const violations: string[] = [];

    let m: RegExpExecArray | null;
    while ((m = pattern.exec(stripped)) !== null) {
      // Take a 200-char window around the match to inspect context.
      const start = Math.max(0, m.index - 100);
      const end = Math.min(stripped.length, m.index + 100);
      const context = stripped.slice(start, end);

      // Gate-derived assignments are fine — they consumed
      // evaluateThresholdWithMatrix's result.
      if (
        /gateResult|gateDecision|gate\.outcome|outcome:\s*['"`]EXECUTED['"`]\s*\|\s*['"`]ESCALATED['"`]/.test(
          context,
        )
      ) {
        continue;
      }

      // Type annotations (Promise<{ outcome: 'EXECUTED' | 'ESCALATED' }>)
      // — type-only, no runtime effect.
      if (/Promise<|outcome:\s*['"`]EXECUTED['"`]\s*\|\s*['"`]ESCALATED['"`]/.test(context)) {
        continue;
      }

      // Type-only comparison (=== 'EXECUTED'): not an assignment.
      if (/===\s*['"`]EXECUTED['"`]|=== ['"`]EXECUTED['"`]/.test(context)) {
        continue;
      }

      // String comparison via ternary or branching where outcome was
      // already set upstream by a gate (decision === 'approved' ? 'EXECUTED' : 'ESCALATED')
      // — gate-derived, fine.
      if (/decision\s*===\s*['"`]approved['"`]\s*\?\s*['"`]EXECUTED['"`]/.test(context)) {
        continue;
      }

      // Check the allowlist.
      const isAllowed = ALLOWLISTED_EXECUTED_ASSIGNMENTS.some((a) =>
        a.contextMatch.test(context),
      );
      if (isAllowed) continue;

      // Real violation — record it with line number for triage.
      const lineNo = src.slice(0, src.indexOf(stripped.slice(m.index, m.index + 10)))
        .split('\n').length;
      violations.push(`run-decision-for-contact.ts:~${lineNo} — context: ${context.trim().replace(/\s+/g, ' ')}`);
    }

    if (violations.length > 0) {
      const msg =
        `\n\n=== KAN-1005 M2-1 NO-BYPASS GATE VIOLATIONS ===\n` +
        violations.map((v) => `  ✗ ${v}`).join('\n') +
        `\n\nEvery code path that sets outcome='EXECUTED' in run-decision-for-contact.ts\n` +
        `MUST flow from evaluateThresholdWithMatrix's gate decision. Bypassing it bypasses\n` +
        `the entire KAN-1005 governance package (daily-action-limit, autoEscalateFlags,\n` +
        `aiPermissions) — making the M2-6b autonomy flip unsafe.\n` +
        `\n` +
        `If you have a genuine reason (e.g. adapter mode for human-configured steps),\n` +
        `add an entry to ALLOWLISTED_EXECUTED_ASSIGNMENTS at the top of this file with\n` +
        `a documented rationale (ticket reference + send-safety enforcement note).\n`;
      throw new Error(msg);
    }
  });

  it('allowlist entry for runPlaybookStep is present + documented', () => {
    // Pin the allowlist's content so it can't silently shrink (someone
    // removing the allowlist would silently disable the playbook path —
    // worth a deliberate decision, not a silent edit).
    expect(ALLOWLISTED_EXECUTED_ASSIGNMENTS).toHaveLength(1);
    expect(ALLOWLISTED_EXECUTED_ASSIGNMENTS[0].contextMatch.source).toMatch(/playbook/i);
    expect(ALLOWLISTED_EXECUTED_ASSIGNMENTS[0].reason).toMatch(/applyRedirect/);
  });
});
