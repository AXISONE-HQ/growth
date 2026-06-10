'use client';

/**
 * KAN-1140 Phase 3 PR 9c — Parse Rules dashboard (operator authoring UI).
 *
 * Closes the KAN-1140 arc. Surfaces:
 *
 *   - Rule list (status-filtered)
 *   - Create / edit form (multi-extractor; Q-ADD-EXTRACTOR-COUNT)
 *   - Sample testing (stored / paste / recent; Q3 lock)
 *   - Version history + rollback (Q5 hybrid versioning)
 *   - Status lifecycle controls (activate / deactivate / re-enable)
 *
 * # Authority gate
 *
 * `protectedProcedure` at the backend; same convention as parse-fingerprints.
 * Every operator within a tenant can author rules for THEIR tenant.
 *
 * # KAN-1158 dependency
 *
 * The activate affordance ships gated by KAN-1158's empirical runtime
 * budget verification. Operators clicking "Activate" cause rules to fire
 * on subsequent inbounds; the budget mechanism + safe-regex2 + lead-first
 * invariant are all empirically locked.
 *
 * # Q-ADD-INLINE-CROSS-LINK URL params (KAN-1166 fix-forward)
 *
 * The cross-link from parse-fingerprints passes ?createForFingerprint + ?format
 * + ?vendor. URL param reading lives in the dashboard component (NOT this
 * page wrapper). Rationale: `useSearchParams` in Next.js 14.2 returns null
 * during prerender; `.get()` on null throws and corrupts the page render
 * (manifests as redirect-to-home on initial load). Moving the reading
 * downstream of the auth gate keeps this wrapper byte-identical to the
 * parse-fingerprints sibling — proven SSR-stable pattern.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { ParseRulesDashboard } from './_components/dashboard';

export default function ParseRulesPage(): React.ReactElement {
  const router = useRouter();
  const { user, loading } = useAuth();

  React.useEffect(() => {
    // protectedProcedure gate is at the backend; this is just a
    // signed-in check (any tenant operator passes). Unauthenticated
    // users get redirected to home so the empty page doesn't render.
    if (!loading && !user) {
      router.replace('/');
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <main className="p-6">
        <div className="text-sm" style={{ color: 'var(--ds-ink-secondary)' }}>
          Loading…
        </div>
      </main>
    );
  }

  if (!user) {
    return <main className="p-6" />;
  }

  return (
    <main className="p-6">
      <ParseRulesDashboard />
    </main>
  );
}
