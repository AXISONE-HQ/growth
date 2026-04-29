/**
 * KAN-718 — NEXT_PUBLIC_DEMO_MODE per-environment toggle.
 *
 * Permanent infrastructure (not pre-launch crutch). Sales demos + internal
 * training surface routes/cards behind this flag pre- AND post-launch.
 *
 * Per-environment posture (set in deploy-web.yml env vars when KAN-757
 * tightens the strategy; today the flag is read at build/runtime):
 *   - dev / staging  → DEMO_MODE=on  (fixtures visible)
 *   - prod           → DEMO_MODE=off (real tenants never see demo data)
 *
 * UI rule: when DEMO_MODE is on, every page renders the DemoModeBanner at
 * the top. Demo-only routes (currently /conversations) and demo-flagged
 * dashboard cards are hidden when off. KAN-757 (Sprint 5) refines fixture
 * quality once we know what kinds of demos sales will run.
 *
 * ──────────────────────────────────────────────────────────────────
 * CANONICAL DEMO-GATING PATTERNS (referenced by the KAN-718 May 6 drift
 * sweep classifier — keep these names stable so the audit doesn't
 * false-positive on intentional demo content):
 *
 *   1. `isDemoMode()`                    — non-JSX conditional in a function body
 *   2. `<DemoModeOnly>`                  — JSX-ergonomic wrapper (this component
 *                                          is `apps/web/src/components/demo-mode-only.tsx`)
 *   3. `process.env.NEXT_PUBLIC_DEMO_MODE === 'true'`
 *                                        — direct env-var check (rarely needed
 *                                          since (1) wraps it; supported for the
 *                                          edge case of static evaluation)
 *   4. Any file named `demo-fixtures.ts` or `demo-fixtures.tsx` (anywhere
 *      in the tree) is assumed to be demo-only mock data; imports from
 *      these files are intentional, NOT drift.
 *
 * If a new demo-gating pattern is introduced (e.g., a hook, a context provider,
 * a higher-order component), update both this docstring AND the May 6 sweep's
 * agent prompt to keep classifier alignment.
 * ──────────────────────────────────────────────────────────────────
 */
export function isDemoMode(): boolean {
  // Next.js inlines NEXT_PUBLIC_* at build time. The toString check guards
  // against the env var being literally undefined or any truthy non-"true"
  // value (e.g. "false", "0").
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}
