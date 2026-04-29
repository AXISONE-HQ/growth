'use client';

/**
 * KAN-718 — `<DemoModeOnly>` wrapper for JSX-ergonomic demo gating.
 *
 * Use this for inline JSX gating (rendering a card conditionally inside a
 * larger page). For non-JSX conditionals, use `isDemoMode()` from
 * `@/lib/demo-mode` directly.
 *
 * The May 6 drift sweep's classifier looks for `<DemoModeOnly>` (this
 * component) as one of three canonical demo-gating patterns — keep this
 * component name stable so the audit doesn't false-positive when the gate is
 * legitimate.
 *
 * Example:
 *   <DemoModeOnly>
 *     <DashboardMockCard data={demoFixtures.salesPipeline} />
 *   </DemoModeOnly>
 */
import { isDemoMode } from "@/lib/demo-mode";

export function DemoModeOnly({
  children,
  fallback = null,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}): React.ReactNode {
  return isDemoMode() ? children : fallback;
}
