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
 */
export function isDemoMode(): boolean {
  // Next.js inlines NEXT_PUBLIC_* at build time. The toString check guards
  // against the env var being literally undefined or any truthy non-"true"
  // value (e.g. "false", "0").
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}
