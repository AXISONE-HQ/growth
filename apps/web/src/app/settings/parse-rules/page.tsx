'use client';

/**
 * KAN-1140 Phase 3 PR 9c — Parse Rules dashboard (operator authoring UI).
 *
 * THE FINAL PR of the KAN-1140 arc. Surfaces:
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
 */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { ParseRulesDashboard } from './_components/dashboard';

export default function ParseRulesPage(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();

  // Q-ADD-INLINE-CROSS-LINK — parse-fingerprints "Create rule for this
  // pattern →" passes ?createForFingerprint=<id> + ?scope=<format/vendor>.
  // Read into URL state for the create form pre-fill.
  const createForFingerprintId = searchParams.get('createForFingerprint');
  const createForFormat = searchParams.get('format');
  const createForVendor = searchParams.get('vendor');

  React.useEffect(() => {
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
      <ParseRulesDashboard
        createForFingerprintId={createForFingerprintId}
        createForFormat={createForFormat}
        createForVendor={createForVendor}
      />
    </main>
  );
}
